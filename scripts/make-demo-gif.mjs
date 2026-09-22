#!/usr/bin/env node
// Compose a side-by-side demo GIF from a run: left = the page as Jev saw it (per-step screenshot),
// right = Jev's judgment for that step (goal_done, blocker, action distribution, chosen target).
// usage: node scripts/make-demo-gif.mjs <result.json> <out.gif> [--title "…"] [--width 1100] [--mp4]
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { launchChrome, CdpConnection } from "../skills/jev-browser/lib/backends/chrome.mjs";

const args = process.argv.slice(2);
const resultFile = args[0];
const outGif = args[1];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const title = opt("title", null);
const width = Number(opt("width", 1100));
const wantMp4 = args.includes("--mp4");
if (!resultFile || !outGif) {
  console.error("usage: node scripts/make-demo-gif.mjs <result.json> <out.gif> [--title t] [--width px] [--mp4]");
  process.exit(1);
}

const result = JSON.parse(await fs.readFile(resultFile, "utf8"));
const steps = (await fs.readFile(path.join(result.journalDir, "steps.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
const shotsDir = path.dirname(steps.find((s) => s.screenshot)?.screenshot ?? "");
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (p) => `${Math.round((p ?? 0) * 100)}%`;
const bars = (map, highlight, names = {}) =>
  Object.entries(map ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, p]) => `<div class="bar"><span class="k${k === highlight ? " hi" : ""}" title="${esc(k)}">${esc(names[k] ? `${names[k].replace(/ → .*$/, "")} · ${k}` : k)}</span><span class="track"><i style="width:${Math.max(2, p * 100)}%"></i></span><span class="v">${pct(p)}</span></div>`)
    .join("");
const elementName = (step, id) => {
  const label = step.chosen?.label ?? "";
  return label.replace(/^(clicked|typed .* into|changed) /, "");
};

const frames = [];
const H = Math.round(width * 0.56);
const stepFrames = steps.filter((s) => !s.finalCheck);
for (const s of stepFrames) {
  const a = s.answers ?? {};
  const chosenLabel =
    (s.chosen && s.chosen.kind !== "stop" ? s.chosen.label : null) ??
    (s.outcome === "success"
      ? `goal verified (${pct(s.goalDone)}) → success`
      : s.outcome === "stop"
        ? result.status === "success"
          ? `model chose stop, goal verified (${pct(s.goalDone)}) → success`
          : "model chose stop → stuck"
        : s.outcome === "needs_user"
          ? `blocker "${s.blocker}" → handed to the user`
          : "stop");
  const target = a.click_target?.top3 ?? a.type_target?.top3 ?? null;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${width}px;height:${H}px;background:#0B1020;font-family:-apple-system,"SF Pro Text","Inter","Segoe UI",Helvetica,Arial,sans-serif;color:#E6E9F5;overflow:hidden}
  .top{height:52px;display:flex;align-items:center;padding:0 22px;gap:14px;border-bottom:1px solid #1e2542}
  .top .logo{width:26px;height:26px}.top b{font-size:17px;letter-spacing:-.2px}.top .goal{color:#9AA3C7;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .top .step{margin-left:auto;font-size:13px;color:#2DD4BF;font-weight:600;white-space:nowrap}
  .body{display:flex;height:${H - 52 - 46}px}
  .shot{width:62%;padding:14px 10px 14px 18px;box-sizing:border-box}.shot .frame{width:100%;height:100%;border-radius:10px;overflow:hidden;border:1px solid #2a3150;background:#fff;position:relative}
  .shot img{width:100%;display:block}.shot .tag{position:absolute;left:10px;top:10px;background:rgba(11,16,32,.85);color:#fff;font-size:12px;padding:4px 8px;border-radius:6px}
  .panel{width:38%;padding:14px 18px 14px 8px;box-sizing:border-box;display:flex;flex-direction:column;gap:10px}
  .card{background:#121833;border:1px solid #1e2542;border-radius:10px;padding:10px 12px}.card h4{margin:0 0 6px;font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#7C86AD;font-weight:600}
  .big{display:flex;align-items:baseline;gap:8px}.big .n{font-size:30px;font-weight:800;color:#fff}.big .l{font-size:12px;color:#9AA3C7}
  .gauge{height:8px;background:#1e2542;border-radius:4px;overflow:hidden;margin-top:6px}.gauge i{display:block;height:100%;background:linear-gradient(90deg,#4F46E5,#2DD4BF)}
  .bar{display:flex;align-items:center;gap:8px;font-size:12px;margin:3px 0}.bar .k{width:150px;color:#C7CDE6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar .k.hi{color:#2DD4BF;font-weight:700}
  .bar .track{flex:1;height:7px;background:#1e2542;border-radius:4px;overflow:hidden}.bar .track i{display:block;height:100%;background:#4F46E5}.bar .v{width:36px;text-align:right;color:#9AA3C7}
  .bottom{height:46px;display:flex;align-items:center;padding:0 22px;gap:10px;border-top:1px solid #1e2542;font-size:14px}
  .bottom .arrow{color:#2DD4BF;font-weight:800}.bottom .act{color:#fff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bottom .cost{margin-left:auto;color:#7C86AD;font-size:12px;white-space:nowrap}
  </style></head><body>
  <div class="top"><img class="logo" src="file://${path.resolve("assets/logo.svg")}"><b>jev-browser</b><span class="goal">${esc(title ?? result.goal)}</span><span class="step">step ${s.step} / ${stepFrames.length}</span></div>
  <div class="body">
    <div class="shot"><div class="frame">${s.screenshot ? `<img src="file://${s.screenshot}">` : ""}<div class="tag">${esc(result.backend)} · ${esc(s.url)}</div></div></div>
    <div class="panel">
      <div class="card"><h4>goal_done</h4><div class="big"><span class="n">${pct(s.goalDone)}</span><span class="l">P(goal accomplished on this page)</span></div><div class="gauge"><i style="width:${(s.goalDone ?? 0) * 100}%"></i></div></div>
      <div class="card"><h4>blocker</h4><div class="big"><span class="n" style="font-size:20px">${esc(s.blocker)}</span><span class="l">${pct(a.blocker?.top3?.[s.blocker])}</span></div></div>
      <div class="card"><h4>action</h4>${bars(a.action?.top3, a.action?.top)}</div>
      ${target ? `<div class="card"><h4>target</h4>${bars(target, Object.keys(target)[0], s.targets)}</div>` : ""}
    </div>
  </div>
  <div class="bottom"><span class="arrow">→</span><span class="act">${esc(chosenLabel)}</span><span class="cost">${s.usage?.input_tokens ?? "?"} tokens · $${(s.costUsd ?? 0).toFixed(4)} · ${s.ms ?? "?"} ms</span></div>
  </body></html>`;
  frames.push({ html, duration: s.chosen ? 2.4 : 3.2 });
}
// closing frame
const closing = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width}px;height:${H}px;background:#0B1020;font-family:-apple-system,"SF Pro Display","Inter","Segoe UI",Helvetica,Arial,sans-serif;color:#fff;display:flex;align-items:center;justify-content:center}
.c{text-align:center}.c img{width:110px}.c h1{margin:14px 0 6px;font-size:40px;letter-spacing:-1px}.c p{margin:4px 0;color:#2DD4BF;font-size:20px}.c small{display:block;margin-top:14px;color:#9AA3C7;font-size:15px}
</style></head><body><div class="c"><img src="file://${path.resolve("assets/logo.svg")}"><h1>${esc(result.status)}</h1><p>${esc(result.finalTitle ?? result.finalUrl ?? "")}</p><small>${result.steps} steps · ${result.usage?.requests ?? "?"} Jev requests · ${result.usage?.inputTokens ?? "?"} tokens · $${(result.usage?.costUsd ?? 0).toFixed(4)} · ${Math.round((result.elapsedMs ?? 0) / 1000)} s</small></div></body></html>`;
frames.push({ html: closing, duration: 3.5 });

const work = await fs.mkdtemp("/tmp/jev-demo-");
const chrome = await launchChrome({ headless: true, userDataDir: path.join(work, "profile"), log: () => {} });
const version = await (await fetch(`${chrome.cdpUrl}/json/version`)).json();
const cdp = new CdpConnection(version.webSocketDebuggerUrl);
await cdp.connect();
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
const send = (m, p) => cdp.send(m, p, sessionId);
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height: H, deviceScaleFactor: 2, mobile: false });
const concat = [];
for (const [i, f] of frames.entries()) {
  const file = path.join(work, `frame-${String(i).padStart(2, "0")}.html`);
  await fs.writeFile(file, f.html);
  await send("Page.navigate", { url: `file://${file}` });
  await new Promise((r) => setTimeout(r, 700));
  const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height: H, scale: 1 } });
  const png = path.join(work, `frame-${String(i).padStart(2, "0")}.png`);
  await fs.writeFile(png, Buffer.from(data, "base64"));
  concat.push(`file '${png}'`, `duration ${f.duration}`);
}
concat.push(`file '${path.join(work, `frame-${String(frames.length - 1).padStart(2, "0")}.png`)}'`); // concat demuxer quirk: repeat last frame
await fs.writeFile(path.join(work, "list.txt"), concat.join("\n"));
await cdp.send("Browser.close").catch(() => {});
chrome.process.kill();

const ffmpeg = (a) => new Promise((resolve, reject) => {
  const p = spawn("ffmpeg", ["-y", "-loglevel", "error", ...a], { stdio: "inherit" });
  p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
});
const outW = Math.min(width, 960);
await ffmpeg(["-f", "concat", "-safe", "0", "-i", path.join(work, "list.txt"), "-vf", `fps=10,scale=${outW}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, "-loop", "0", outGif]);
if (wantMp4) await ffmpeg(["-f", "concat", "-safe", "0", "-i", path.join(work, "list.txt"), "-vf", `fps=30,scale=${width}:-2:flags=lanczos`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", outGif.replace(/\.gif$/, ".mp4")]);
const size = (await fs.stat(outGif)).size;
console.log(`wrote ${outGif} (${(size / 1024).toFixed(0)} KB, ${frames.length} frames)`);
await fs.rm(work, { recursive: true, force: true });
