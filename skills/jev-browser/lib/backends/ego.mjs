// ego lite backend. The ego-browser API is only available inside `ego-browser nodejs`,
// so the parent process spawns that runtime with a tiny bootstrap script and the whole
// controller loop runs inside it (one process per job, not per step).
//
// The ego runtime does not inherit environment variables, so the job (including the
// API key) is handed over through a 0600 temp file that is deleted afterwards.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enumeratorExpression } from "../observe.mjs";

const MARK = "@@JEV@@ ";
const HERE = fileURLToPath(import.meta.url);

/** Parent side: run a job inside the ego runtime and return its result. */
export async function runEgoJob({ config, job, log = () => {}, egoBin = "ego-browser" }) {
  const tmp = path.join(os.tmpdir(), `jev-browser-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await fs.writeFile(tmp, JSON.stringify({ config, job }), { mode: 0o600 });
  const bootstrap = [
    `const mod = await import(${JSON.stringify(pathToFileURL(HERE).href)});`,
    `await mod.egoMain(${JSON.stringify(tmp)}, { taskSpace, takeOverTaskSpace, listTaskSpaces, claimTaskSpace });`,
  ].join("\n");
  const args = [];
  if (config.ego?.serverName) args.push(`--ego-server-name=${config.ego.serverName}`);
  args.push("nodejs");
  try {
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(egoBin, args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }
      let result = null;
      let failure = null;
      let stderrTail = "";
      const handleLine = (line) => {
        if (!line.trim()) return;
        if (line.startsWith(MARK)) {
          let event;
          try {
            event = JSON.parse(line.slice(MARK.length));
          } catch {
            log(line);
            return;
          }
          if (event.type === "log") log(event.message);
          else if (event.type === "result") result = event.result;
          else if (event.type === "error") failure = event;
          return;
        }
        if (line.includes("[ego-browser:notice]")) log(line);
        else log(`[ego] ${line}`);
      };
      // The ego runtime may forward script output on either stream: parse both.
      const buffers = { stdout: "", stderr: "" };
      const feed = (name) => (chunk) => {
        if (name === "stderr") stderrTail = (stderrTail + chunk).slice(-4000);
        buffers[name] += chunk;
        const lines = buffers[name].split("\n");
        buffers[name] = lines.pop();
        lines.forEach(handleLine);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", feed("stdout"));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", feed("stderr"));
      child.on("error", (error) => reject(new Error(`could not start ${egoBin}: ${error.message}. Install ego lite and the ego-browser CLI (see references/backends.md).`)));
      child.on("close", (code) => {
        for (const rest of Object.values(buffers)) if (rest) handleLine(rest);
        if (result) resolve(result);
        else if (failure) reject(Object.assign(new Error(failure.message), { code: failure.code ?? "EGO_JOB_FAILED" }));
        else reject(new Error(`ego-browser exited with code ${code} without a result${stderrTail ? `: ${stderrTail.trim().slice(-800)}` : ""}`));
      });
      child.stdin.end(bootstrap);
    });
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/**
 * Parent side: finish (close) a task space by id, taking it over first when it was handed
 * to the user (ownership "agentDelegatedToUser") or claiming it when the user owns it.
 * Used for cleanup after a needs_user result once the user is done.
 */
export async function closeEgoSpace({ spaceId, config = {}, egoBin = "ego-browser", timeoutMs = 30_000 }) {
  const id = Number(spaceId);
  const script = [
    "const spaces = await listTaskSpaces();",
    `const target = spaces.find((s) => Number(s.id ?? s.spaceId) === ${id});`,
    `const emit = (result) => console.log(${JSON.stringify(MARK)} + JSON.stringify({ type: "result", result }));`,
    "if (!target) { emit({ closed: false, reason: \"not found\" }); }",
    "else {",
    `  const task = target.ownership === "agentDelegatedToUser" ? await takeOverTaskSpace(${id}) : target.ownership === "user" ? await claimTaskSpace(${id}) : await taskSpace(${id});`,
    "  await task.finish({ keep: [] });",
    "  emit({ closed: true, ownership: target.ownership });",
    "}",
  ].join("\n");
  const args = [];
  if (config.ego?.serverName) args.push(`--ego-server-name=${config.ego.serverName}`);
  args.push("nodejs");
  return new Promise((resolve, reject) => {
    const child = spawn(egoBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`closing ego space ${id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.split("\n").find((l) => l.startsWith(MARK));
      if (!line) return reject(new Error(`could not close ego space ${id}: ${out.trim().slice(-300)}`));
      resolve(JSON.parse(line.slice(MARK.length)).result);
    });
    child.stdin.end(script);
  });
}

/** Child side (runs inside `ego-browser nodejs`). */
export async function egoMain(jobPath, api) {
  const emit = (event) => process.stdout.write(`${MARK}${JSON.stringify(event)}\n`);
  const log = (message) => emit({ type: "log", message });
  try {
    const { config, job } = JSON.parse(await fs.readFile(jobPath, "utf8"));
    await fs.rm(jobPath, { force: true }); // the secret-bearing file is no longer needed
    const { runWithDriver } = await import("../runner.mjs");
    const driver = new EgoDriver({ api, config, job, log });
    const result = await runWithDriver({ driver, config, job, log });
    emit({ type: "result", result });
  } catch (error) {
    emit({ type: "error", message: error?.message ?? String(error), code: error?.code });
    process.exitCode = 1;
  }
}

export class EgoDriver {
  name = "ego";

  constructor({ api, config, job, log }) {
    this.api = api;
    this.config = config;
    this.job = job;
    this.log = log;
    this.task = null;
    this.page = null;
    this.handedOff = false;
  }

  selector(id) {
    return `[data-jev-id="${id}"]`;
  }

  async start({ url } = {}) {
    if (this.job.spaceId) {
      // Resume: a space handed to the user must be taken over, a user-created one claimed.
      const id = Number(this.job.spaceId);
      const spaces = await this.api.listTaskSpaces();
      const target = spaces.find((s) => Number(s.id ?? s.spaceId) === id);
      if (!target) throw new Error(`ego task space ${id} does not exist (it may have been closed)`);
      this.task =
        target.ownership === "agentDelegatedToUser"
          ? await this.api.takeOverTaskSpace(id)
          : target.ownership === "user"
            ? await this.api.claimTaskSpace(id)
            : await this.api.taskSpace(id);
      this.log(`resumed ego task space ${id} (was ${target.ownership})`);
      const label = this.job.pageLabel ?? "p1";
      this.page = this.task.page(label);
      if (!this.page || typeof this.page.goto !== "function") {
        const tabs = await this.task.tabs();
        const active = tabs.find((t) => t.active) ?? tabs[0];
        if (!active) throw new Error(`task space ${this.job.spaceId} has no pages`);
        this.page = active.label ? this.task.page(active.label) : await this.task.adopt(active.page);
      }
    } else {
      // A fresh, uniquely named space per run: reusing a name can resume a space the user now owns.
      const base = this.job.spaceName ?? this.config.ego?.spaceName ?? `jev-browser: ${String(this.job.goal ?? "observe").slice(0, 60)}`;
      this.task = await this.api.taskSpace(`${base} #${Math.random().toString(36).slice(2, 6)}`);
      this.page = this.task.page("p1");
    }
    this.log(`ego task space ${this.task.spaceId}, page ${this.page.label}`);
    if (url) {
      await this.page.goto(url, { waitUntil: "load", timeout: this.config.loadTimeoutMs });
    } else {
      const current = await this.page.url();
      if (!current || current === "about:blank") throw new Error("no start URL given and the page is blank; pass --url");
    }
  }

  async observe(extra = {}) {
    return this.page.evaluate(enumeratorExpression({ ...this.config.observation, ...extra }));
  }

  async click(id, { label } = {}) {
    const selector = this.selector(id);
    const options = { timeout: 5000, label: shortLabel(label ?? "click element") };
    try {
      await this.page.click(selector, options);
    } catch (error) {
      // Typical on image links and overlays: "<img> intercepts pointer events". Force the pointer, then fall back to a DOM click.
      if (!/intercepts pointer events|none can receive input|not visible|outside of the viewport/i.test(error.message)) throw error;
      try {
        await this.page.click(selector, { ...options, force: true });
      } catch {
        const clicked = await this.page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
        if (!clicked) throw error;
      }
    }
  }

  async type(id, text, { submit } = {}) {
    await this.page.fill(this.selector(id), text, { clearFirst: true, timeout: 5000 });
    if (submit) await this.page.press(this.selector(id), "Enter");
  }

  async select(id, value) {
    await this.page.selectOption(this.selector(id), { value }, { timeout: 5000 });
  }

  async scroll(direction) {
    await this.page.evaluate(`window.scrollBy(0, ${direction === "down" ? "" : "-"}Math.round(window.innerHeight * 0.8))`);
  }

  async back() {
    await this.page.evaluate("history.back()");
  }

  async navigate(url) {
    await this.page.goto(url, { waitUntil: "load", timeout: this.config.loadTimeoutMs });
  }

  async wait(ms) {
    await this.page.waitForTimeout(ms);
  }

  async settle() {
    await this.page.waitForTimeout(150);
    await this.page.waitForLoadState("load", { timeout: this.config.loadTimeoutMs }).catch(() => {});
    await this.page.waitForTimeout(this.config.settleMs);
  }

  async screenshot(file) {
    await this.page.screenshot({ path: file });
    return file;
  }

  async historyLength() {
    try {
      return Number(await this.page.evaluate("history.length")) || 1;
    } catch {
      return 1;
    }
  }

  async handOff() {
    this.handedOff = true;
    await this.task.handOff();
    return { spaceId: this.task.spaceId, pageLabel: this.page.label, howToResume: `jev-browser run --backend ego --space-id ${this.task.spaceId} --goal "..."` };
  }

  async finish({ success, keep } = {}) {
    if (this.handedOff || !this.task) return;
    const keepPage = keep ?? (success && this.config.ego?.keepOnSuccess !== false);
    await this.task.finish({ keep: keepPage ? [this.page.label] : [] });
  }

  describe() {
    return { backend: "ego", spaceId: this.task?.spaceId ?? null, pageLabel: this.page?.label ?? null };
  }
}

function shortLabel(text) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ");
  return words.slice(0, 6).join(" ").slice(0, 60);
}
