// Chrome backend over the Chrome DevTools Protocol. Attaches to a Chrome started with
// --remote-debugging-port, or launches a dedicated instance with its own profile
// directory (Chrome refuses remote debugging on the default profile).
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { enumeratorExpression } from "../observe.mjs";
import { ensureDir, sleep } from "../util.mjs";

export const CHROME_CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

export async function findChromeExecutable(configured) {
  const candidates = [configured, process.env.CHROME_PATH, ...(CHROME_CANDIDATES[process.platform] ?? [])].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return response.json();
}

/** Launch a dedicated Chrome instance. Returns { process, cdpUrl, port, profile }. */
export async function launchChrome({ executable, userDataDir, headless = false, windowSize = "1280,900", extraArgs = [], log = () => {}, detached = false } = {}) {
  const exe = await findChromeExecutable(executable);
  if (!exe) throw new Error("Chrome not found. Set chrome.executable in the config or CHROME_PATH.");
  const profile = userDataDir ?? path.join(os.tmpdir(), `jev-browser-chrome-${process.pid}`);
  await ensureDir(profile);
  const portFile = path.join(profile, "DevToolsActivePort");
  await fs.rm(portFile, { force: true });
  const args = [
    "--remote-debugging-port=0", // Chrome picks a free port and writes DevToolsActivePort: no race between parallel runs
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain", // macOS: never touch the user's keychain (avoids the "Keychain Not Found" dialog)
    "--password-store=basic", // Linux: same idea for gnome-keyring / kwallet
    "--disable-background-timer-throttling",
    "--disable-features=Translate,MediaRouter",
    `--window-size=${windowSize}`,
    ...(headless ? ["--headless=new", "--hide-scrollbars"] : []),
    ...(process.platform === "linux" ? ["--disable-dev-shm-usage", "--disable-gpu"] : []),
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []), // CI containers often lack user namespaces
    ...extraArgs,
    "about:blank",
  ];
  const child = spawn(exe, args, { stdio: "ignore", detached });
  if (detached) child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chrome exited immediately (code ${child.exitCode}). Is another instance using ${profile}?`);
    try {
      const [portLine] = (await fs.readFile(portFile, "utf8")).split("\n");
      const port = Number(portLine);
      if (port > 0) {
        const cdpUrl = `http://127.0.0.1:${port}`;
        await fetchJson(`${cdpUrl}/json/version`, 1500);
        log(`chrome launched (pid ${child.pid}, cdp ${cdpUrl}${headless ? ", headless" : ""})`);
        return { process: child, cdpUrl, port, profile };
      }
    } catch {
      /* not ready yet */
    }
    await sleep(150);
  }
  child.kill();
  throw new Error("Chrome did not expose the DevTools endpoint in time");
}

/** Tiny CDP client with flattened sessions. */
export class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    if (typeof WebSocket !== "function") throw new Error("global WebSocket is required (Node 22+)");
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP websocket did not open within 10s (${this.wsUrl})`)), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP websocket error: ${event.message ?? "connect failed"}`));
      }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.#handle(String(event.data)));
    this.ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  #handle(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(Object.assign(new Error(message.error.message ?? "CDP error"), { cdp: message.error }));
      else resolve(message.result ?? {});
      return;
    }
    if (message.method) {
      const key = `${message.sessionId ?? ""}:${message.method}`;
      for (const handler of [...(this.listeners.get(key) ?? []), ...(this.listeners.get(`*:${message.method}`) ?? [])]) handler(message.params ?? {}, message.sessionId);
    }
  }

  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(method, handler, sessionId = "*") {
    const key = `${sessionId}:${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(handler);
    return () => this.listeners.get(key)?.delete(handler);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Wait for a child to exit; escalate to SIGKILL after the grace period. */
async function terminate(child, graceMs) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const deadline = Date.now() + graceMs;
  while (child.exitCode === null && !child.signalCode && Date.now() < deadline) await sleep(100);
  if (child.exitCode === null && !child.signalCode) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
    await Promise.race([exited, sleep(1000)]);
  }
}

export async function createChromeDriver({ config, job, log = () => {} }) {
  const driver = new ChromeDriver({ config, job, log });
  await driver.connect();
  return driver;
}

export class ChromeDriver {
  name = "chrome";

  constructor({ config, job, log }) {
    this.config = config;
    this.job = job;
    this.log = log;
    this.launched = null;
    this.cdp = null;
    this.sessionId = null;
    this.targetId = null;
    this.loading = false;
    this.mainFrameId = null;
  }

  async connect() {
    const chrome = this.config.chrome ?? {};
    let cdpUrl = this.job.cdpUrl ?? chrome.cdpUrl;
    if (cdpUrl) {
      this.log(`attaching to chrome at ${cdpUrl}`);
    } else {
      const headless = this.job.headless ?? chrome.headless ?? false;
      this.launched = await launchChrome({
        executable: chrome.executable,
        userDataDir: this.job.userDataDir ?? chrome.userDataDir,
        headless,
        windowSize: chrome.windowSize,
        extraArgs: chrome.extraArgs ?? [],
        log: this.log,
        detached: !headless,
      });
      cdpUrl = this.launched.cdpUrl;
    }
    const version = await fetchJson(`${cdpUrl.replace(/\/$/, "")}/json/version`);
    this.cdp = new CdpConnection(version.webSocketDebuggerUrl);
    await this.cdp.connect();
    const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank" });
    this.targetId = targetId;
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    const tree = await this.send("Page.getFrameTree");
    this.mainFrameId = tree.frameTree.frame.id;
    this.cdp.on("Page.frameStartedLoading", ({ frameId }) => {
      if (frameId === this.mainFrameId) this.loading = true;
    }, sessionId);
    this.cdp.on("Page.frameStoppedLoading", ({ frameId }) => {
      if (frameId === this.mainFrameId) this.loading = false;
    }, sessionId);
    this.cdp.on("Page.loadEventFired", () => {
      this.loading = false;
    }, sessionId);
    if (this.launched && !(this.job.headless ?? chrome.headless)) {
      await this.send("Target.activateTarget", { targetId }).catch(() => {});
    }
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? "evaluate failed");
    return result?.value;
  }

  async waitForLoad(timeoutMs = this.config.loadTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.loading) {
        const state = await this.evaluate("document.readyState").catch(() => "loading");
        if (state === "complete" || state === "interactive") return true;
      }
      await sleep(100);
    }
    return false;
  }

  async start({ url } = {}) {
    if (url) await this.navigate(url);
    else throw new Error("the chrome backend needs a start URL; pass --url");
  }

  async navigate(url) {
    this.loading = true;
    const { errorText } = await this.send("Page.navigate", { url });
    if (errorText) throw new Error(`navigation failed: ${errorText}`);
    await this.waitForLoad();
    await sleep(this.config.settleMs);
  }

  async observe() {
    return this.evaluate(enumeratorExpression(this.config.observation));
  }

  async #center(id) {
    const rect = await this.evaluate(`(() => {
      const el = document.querySelector('[data-jev-id="${id}"]');
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
    })()`);
    if (!rect) throw new Error(`element ${id} is no longer on the page`);
    await sleep(50);
    return rect;
  }

  async click(id) {
    const { x, y } = await this.#center(id);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async type(id, text, { submit } = {}) {
    await this.#center(id);
    const focused = await this.evaluate(`(() => {
      const el = document.querySelector('[data-jev-id="${id}"]');
      if (!el) return false;
      el.focus();
      if (el.isContentEditable) { document.execCommand("selectAll", false, null); }
      else if (typeof el.select === "function") { el.select(); }
      return document.activeElement === el || el.contains(document.activeElement);
    })()`);
    if (!focused) throw new Error(`could not focus element ${id}`);
    await this.send("Input.insertText", { text });
    if (submit) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
  }

  async select(id, value) {
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector('[data-jev-id="${id}"]');
      if (!el) return false;
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value === ${JSON.stringify(value)};
    })()`);
    if (!ok) throw new Error(`could not select "${value}" in ${id}`);
  }

  async scroll(direction) {
    await this.evaluate(`window.scrollBy(0, ${direction === "down" ? "" : "-"}Math.round(window.innerHeight * 0.8))`);
  }

  async back() {
    const { currentIndex, entries } = await this.send("Page.getNavigationHistory");
    if (currentIndex <= 0) throw new Error("no previous page in history");
    this.loading = true;
    await this.send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id });
    await this.waitForLoad();
  }

  async wait(ms) {
    await sleep(ms);
  }

  async settle() {
    await sleep(150);
    await this.waitForLoad();
    await sleep(this.config.settleMs);
  }

  async screenshot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await ensureDir(path.dirname(file));
    await fs.writeFile(file, Buffer.from(data, "base64"));
    return file;
  }

  async historyLength() {
    try {
      const { entries } = await this.send("Page.getNavigationHistory");
      return entries.length;
    } catch {
      return 1;
    }
  }

  async finish({ success, keep } = {}) {
    const chrome = this.config.chrome ?? {};
    const headless = this.job.headless ?? chrome.headless ?? false;
    const keepPage = keep ?? (success && chrome.keepOnSuccess !== false && !headless);
    try {
      if (this.launched) {
        if (keepPage) {
          this.log(`leaving chrome open (pid ${this.launched.process.pid}) for you to continue`);
        } else {
          await this.cdp.send("Browser.close", {}, undefined, 5000).catch(() => {});
        }
      } else if (!keepPage && this.targetId) {
        await this.cdp.send("Target.closeTarget", { targetId: this.targetId }, undefined, 5000).catch(() => {});
      }
    } finally {
      this.cdp?.close();
      if (this.launched && !keepPage) await terminate(this.launched.process, 3000);
    }
  }

  describe() {
    return { backend: "chrome", cdpUrl: this.launched?.cdpUrl ?? this.job.cdpUrl ?? this.config.chrome?.cdpUrl ?? null, targetId: this.targetId };
  }
}
