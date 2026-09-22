#!/usr/bin/env node
// Compose a demo video from a run made with `jev-browser run --step-screenshots <dir>`.
// Left: the page as Jev saw it before each step. Right: Jev's judgment (goal_done, blocker,
// action and target distributions) and the action the controller executed.
//
// usage: node scripts/make-demo.mjs <run.json> <out.mp4|out.gif> [--title "…"] [--width 1920] [--height 1080]
//        [--hold 2.6] [--fade 0.45] [--gif out.gif] [--gif-width 960]
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { launchChrome, CdpConnection } from "../skills/jev-browser/lib/backends/chrome.mjs";

const args = process.argv.slice(2);
const [resultFile, outFile] = args;
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
if (!resultFile || !outFile) {
  console.error("usage: node scripts/make-demo.mjs <run.json> <out.mp4|out.gif> [--title t] [--width 1920] [--height 1080] [--hold s] [--fade s] [--gif out.gif] [--gif-width px]");
  process.exit(1);
}
const title = opt("title", null);
const W = Number(opt("width", 1920));
const H = Number(opt("height", 1080));
const hold = Number(opt("hold", 2.6));
const fade = Number(opt("fade", 0.45));
const gifOut = opt("gif", outFile.endsWith(".gif") ? outFile : null);
const gifWidth = Number(opt("gif-width", 960));
const mp4Out = outFile.endsWith(".mp4") ? outFile : null;

const result = JSON.parse(await fs.readFile(resultFile, "utf8"));
const steps = (await fs.readFile(path.join(result.journalDir, "steps.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).filter((s) => !s.finalCheck);
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (p) => `${Math.round((p ?? 0) * 100)}%`;
const logo = `file://${path.resolve("assets/logo.svg")}`;
const u = W / 1920; // scale unit so the layout holds at any resolution

const css = `
html,body{margin:0;width:${W}px;height:${H}px;background:#0B1020;font-family:-apple-system,"SF Pro Text","Inter","Segoe UI",Helvetica,Arial,sans-serif;color:#E6E9F5;overflow:hidden}
.grid{position:absolute;inset:0;background-image:radial-gradient(#1c2340 ${1.6*u}px,transparent ${1.6*u}px);background-size:${36*u}px ${36*u}px;opacity:.5}
.top{position:relative;height:${92*u}px;display:flex;align-items:center;padding:0 ${40*u}px;gap:${22*u}px;border-bottom:1px solid #1e2542}
.top img{width:${44*u}px;height:${44*u}px}.top b{font-size:${30*u}px;letter-spacing:-.3px}.top .goal{color:#9AA3C7;font-size:${24*u}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top .step{margin-left:auto;font-size:${22*u}px;color:#2DD4BF;font-weight:700;white-space:nowrap}
.body{position:relative;display:flex;height:${H - 92*u - 84*u}px}
.shot{width:63%;padding:${24*u}px ${16*u}px ${24*u}px ${32*u}px;box-sizing:border-box}
.frame{width:100%;height:100%;border-radius:${16*u}px;overflow:hidden;border:1px solid #2a3150;background:#fff;position:relative;box-shadow:0 ${20*u}px ${60*u}px rgba(0,0,0,.45)}
.frame img{width:100%;display:block}.tag{position:absolute;left:${16*u}px;top:${16*u}px;background:rgba(11,16,32,.86);color:#fff;font-size:${19*u}px;padding:${7*u}px ${12*u}px;border-radius:${8*u}px;max-width:90%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.panel{width:37%;padding:${24*u}px ${32*u}px ${24*u}px ${12*u}px;box-sizing:border-box;display:flex;flex-direction:column;gap:${16*u}px}
.card{background:#121833;border:1px solid #1e2542;border-radius:${16*u}px;padding:${18*u}px ${22*u}px}.card h4{margin:0 0 ${10*u}px;font-size:${17*u}px;letter-spacing:1.2px;text-transform:uppercase;color:#7C86AD;font-weight:700}
.big{display:flex;align-items:baseline;gap:${14*u}px}.big .n{font-size:${52*u}px;font-weight:800;color:#fff;line-height:1}.big .l{font-size:${20*u}px;color:#9AA3C7}
.gauge{height:${12*u}px;background:#1e2542;border-radius:${6*u}px;overflow:hidden;margin-top:${12*u}px}.gauge i{display:block;height:100%;background:linear-gradient(90deg,#4F46E5,#2DD4BF)}
.bar{display:flex;align-items:center;gap:${14*u}px;font-size:${21*u}px;margin:${6*u}px 0}.bar .k{width:${280*u}px;color:#C7CDE6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar .k.hi{color:#2DD4BF;font-weight:700}
.bar .track{flex:1;height:${11*u}px;background:#1e2542;border-radius:${6*u}px;overflow:hidden}.bar .track i{display:block;height:100%;background:#4F46E5}.bar .hi+.track i{background:#2DD4BF}.bar .v{width:${64*u}px;text-align:right;color:#9AA3C7}
.bottom{position:relative;height:${84*u}px;display:flex;align-items:center;padding:0 ${40*u}px;gap:${16*u}px;border-top:1px solid #1e2542;font-size:${25*u}px}
.bottom .arrow{color:#2DD4BF;font-weight:800;font-size:${30*u}px}.bottom .act{color:#fff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bottom .cost{margin-left:auto;color:#7C86AD;font-size:${20*u}px;white-space:nowrap}
.card.center{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.title{position:relative;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.title img{width:${180*u}px}.title h1{margin:${24*u}px 0 ${10*u}px;font-size:${72*u}px;letter-spacing:-2px;color:#fff}.title p{margin:${6*u}px 0;color:#2DD4BF;font-size:${32*u}px;max-width:80%}.title small{display:block;margin-top:${28*u}px;color:#9AA3C7;font-size:${24*u}px}
`;
const bars = (map, highlight, names = {}) =>
  Object.entries(map ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, p]) => `<div class="bar"><span class="k${k === highlight ? " hi" : ""}">${esc(names[k] ? `${names[k].replace(/ → .*$/, "").replace(/ \(.*\)$/, "")} · ${k}` : k)}</span><span class="track"><i style="width:${Math.max(2, p * 100)}%"></i></span><span class="v">${pct(p)}</span></div>`)
    .join("");
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="grid"></div>${body}</body></html>`;

const frames = [];
frames.push({ hold: 2.2, html: page(`<div class="title"><img src="${logo}"><h1>jev-browser</h1><p>${esc(title ?? result.goal)}</p><small>backend: ${esc(result.backend)} · model: TypeSafe Jev · each step = one request, code decides</small></div>`) });
for (const s of steps) {
  const a = s.answers ?? {};
  const label =
    (s.chosen && s.chosen.kind !== "stop" ? s.chosen.label : null) ??
    (s.outcome === "success" ? `goal verified (${pct(s.goalDone)}) → success` : s.outcome === "stop" ? (result.status === "success" ? `model chose stop, goal verified (${pct(s.goalDone)}) → success` : "model chose stop → stuck") : s.outcome === "needs_user" ? `blocker "${s.blocker}" → handed to the user` : "stop");
  const target = a.click_target?.top3 ?? a.type_target?.top3 ?? a.select_target?.top3 ?? null;
  const value = a.type_value?.top3 ? `<div class="card"><h4>value</h4>${bars(a.type_value.top3, a.type_value.top)}</div>` : "";
  frames.push({ hold: s.chosen ? hold : hold + 0.8, html: page(`
  <div class="top"><img src="${logo}"><b>jev-browser</b><span class="goal">${esc(title ?? result.goal)}</span><span class="step">step ${s.step} / ${steps.length}</span></div>
  <div class="body">
    <div class="shot"><div class="frame">${s.screenshot ? `<img src="file://${s.screenshot}">` : ""}<div class="tag">${esc(result.backend)} · ${esc(s.url)}</div></div></div>
    <div class="panel">
      <div class="card"><h4>goal_done</h4><div class="big"><span class="n">${pct(s.goalDone)}</span><span class="l">P(goal accomplished on this page)</span></div><div class="gauge"><i style="width:${(s.goalDone ?? 0) * 100}%"></i></div></div>
      <div class="card"><h4>blocker</h4><div class="big"><span class="n" style="font-size:${34*u}px">${esc(s.blocker)}</span><span class="l">${pct(a.blocker?.top3?.[s.blocker])}</span></div></div>
      <div class="card"><h4>action</h4>${bars(a.action?.top3, a.action?.top)}</div>
      ${target ? `<div class="card"><h4>target</h4>${bars(target, Object.keys(target)[0], s.targets)}</div>` : ""}
      ${value}
    </div>
  </div>
  <div class="bottom"><span class="arrow">→</span><span class="act">${esc(label)}</span><span class="cost">${s.usage?.input_tokens ?? "?"} tokens · $${(s.costUsd ?? 0).toFixed(4)} · ${s.ms ?? "?"} ms</span></div>`) });
}
frames.push({ hold: 3.4, html: page(`<div class="title"><img src="${logo}"><h1>${esc(result.status)}</h1><p>${esc(result.finalTitle ?? result.finalUrl ?? "")}</p><small>${result.steps} steps · ${result.usage?.requests ?? "?"} Jev requests · ${result.usage?.inputTokens ?? "?"} input tokens · $${(result.usage?.costUsd ?? 0).toFixed(4)} · ${Math.round((result.elapsedMs ?? 0) / 1000)} s</small></div>`) });

// Render frames with headless Chrome.
const work = await fs.mkdtemp("/tmp/jev-demo-");
const chrome = await launchChrome({ headless: true, userDataDir: path.join(work, "profile"), log: () => {} });
const version = await (await fetch(`${chrome.cdpUrl}/json/version`)).json();
const cdp = new CdpConnection(version.webSocketDebuggerUrl);
await cdp.connect();
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
const send = (m, p) => cdp.send(m, p, sessionId);
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const pngs = [];
for (const [i, f] of frames.entries()) {
  const file = path.join(work, `frame-${String(i).padStart(2, "0")}.html`);
  await fs.writeFile(file, f.html);
  await send("Page.navigate", { url: `file://${file}` });
  await new Promise((r) => setTimeout(r, 650));
  const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  const png = path.join(work, `frame-${String(i).padStart(2, "0")}.png`);
  await fs.writeFile(png, Buffer.from(data, "base64"));
  pngs.push(png);
}
await cdp.send("Browser.close").catch(() => {});
chrome.process.kill();

const ffmpeg = (a) => new Promise((resolve, reject) => {
  const p = spawn("ffmpeg", ["-y", "-loglevel", "error", ...a], { stdio: "inherit" });
  p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
});

if (mp4Out) {
  // One looped input per still, chained crossfades (xfade) into a single 30 fps h264 stream.
  const inputs = [];
  frames.forEach((f, i) => inputs.push("-loop", "1", "-t", String(f.hold + fade), "-i", pngs[i]));
  let filter = "";
  let last = "[0:v]";
  let offset = 0;
  for (let i = 1; i < frames.length; i++) {
    offset += frames[i - 1].hold;
    const out = i === frames.length - 1 ? "[v]" : `[x${i}]`;
    filter += `${last}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}${out};`;
    last = out;
  }
  filter = filter.replace(/;$/, "");
  await ffmpeg([...inputs, "-filter_complex", filter, "-map", "[v]", "-r", "30", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4Out]);
  console.log(`wrote ${mp4Out} (${((await fs.stat(mp4Out)).size / 1024).toFixed(0)} KB, ${frames.length} frames, ${W}x${H})`);
}
if (gifOut) {
  const list = [];
  frames.forEach((f, i) => list.push(`file '${pngs[i]}'`, `duration ${f.hold}`));
  list.push(`file '${pngs.at(-1)}'`);
  await fs.writeFile(path.join(work, "list.txt"), list.join("\n"));
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", path.join(work, "list.txt"), "-vf", `fps=10,scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, "-loop", "0", gifOut]);
  console.log(`wrote ${gifOut} (${((await fs.stat(gifOut)).size / 1024).toFixed(0)} KB)`);
}
await fs.rm(work, { recursive: true, force: true });
