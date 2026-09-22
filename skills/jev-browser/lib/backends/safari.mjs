// Safari backend via safaridriver (W3C WebDriver over HTTP). Safari must have
// "Allow Remote Automation" enabled (Develop menu) or `sudo safaridriver --enable`.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { ENUMERATOR_SOURCE } from "../observe.mjs";
import { ensureDir, sleep } from "../util.mjs";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
export const SAFARI_ENABLE_HINT =
  "Enable Safari automation once: Safari → Settings → Advanced → 'Show features for web developers', then Develop → 'Allow Remote Automation' (or run `sudo safaridriver --enable`).";

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

export class WebDriverClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.sessionId = null;
  }

  async request(method, route, body, timeoutMs = 30_000) {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json?.value?.error) {
      const message = json?.value?.message ?? `${method} ${route} → ${response.status}`;
      const error = new Error(message);
      error.webdriver = json?.value?.error;
      throw error;
    }
    return json.value;
  }

  session(route = "") {
    return `/session/${this.sessionId}${route}`;
  }
}

export async function createSafariDriver({ config, job, log = () => {} }) {
  const driver = new SafariDriver({ config, job, log });
  await driver.connect();
  return driver;
}

export class SafariDriver {
  name = "safari";

  constructor({ config, job, log }) {
    this.config = config;
    this.job = job;
    this.log = log;
    this.process = null;
    this.client = null;
  }

  async connect() {
    const port = this.config.safari?.port || (await freePort());
    this.process = spawn("safaridriver", ["-p", String(port)], { stdio: "ignore" });
    this.process.on("error", () => {});
    this.client = new WebDriverClient(`http://127.0.0.1:${port}`);
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        await this.client.request("GET", "/status", undefined, 1500);
        ready = true;
      } catch {
        if (this.process.exitCode !== null) throw new Error("safaridriver exited immediately. Is Safari installed?");
        await sleep(200);
      }
    }
    if (!ready) throw new Error("safaridriver did not start");
    try {
      const value = await this.client.request("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
      this.client.sessionId = value.sessionId;
    } catch (error) {
      this.process.kill();
      if (/remote automation/i.test(error.message)) {
        throw Object.assign(new Error(`Safari remote automation is disabled. ${SAFARI_ENABLE_HINT}`), { code: "SAFARI_AUTOMATION_DISABLED" });
      }
      throw error;
    }
    this.log(`safari session ${this.client.sessionId} on port ${port}`);
  }

  async execute(script, args = []) {
    return this.client.request("POST", this.client.session("/execute/sync"), { script, args });
  }

  async start({ url } = {}) {
    if (!url) throw new Error("the safari backend needs a start URL; pass --url");
    await this.navigate(url);
  }

  async navigate(url) {
    await this.client.request("POST", this.client.session("/url"), { url }, this.config.loadTimeoutMs + 5000);
    await this.settle();
  }

  async observe(extra = {}) {
    return this.execute(`return (${ENUMERATOR_SOURCE})(arguments[0]);`, [{ ...this.config.observation, ...extra }]);
  }

  async element(id) {
    const value = await this.client.request("POST", this.client.session("/element"), { using: "css selector", value: `[data-jev-id="${id}"]` });
    const ref = value?.[ELEMENT_KEY];
    if (!ref) throw new Error(`element ${id} is no longer on the page`);
    return ref;
  }

  async click(id) {
    const ref = await this.element(id);
    await this.execute(`arguments[0].scrollIntoView({block: "center"});`, [{ [ELEMENT_KEY]: ref }]);
    await this.client.request("POST", this.client.session(`/element/${ref}/click`), {});
  }

  async type(id, text, { submit } = {}) {
    const ref = await this.element(id);
    await this.client.request("POST", this.client.session(`/element/${ref}/clear`), {}).catch(() => {});
    await this.client.request("POST", this.client.session(`/element/${ref}/value`), { text: submit ? `${text}\uE007` : text });
  }

  async select(id, value) {
    const ok = await this.execute(
      `var el = document.querySelector('[data-jev-id="' + arguments[0] + '"]'); if (!el) return false; el.value = arguments[1]; el.dispatchEvent(new Event("input", {bubbles: true})); el.dispatchEvent(new Event("change", {bubbles: true})); return el.value === arguments[1];`,
      [id, value],
    );
    if (!ok) throw new Error(`could not select "${value}" in ${id}`);
  }

  async scroll(direction) {
    await this.execute(`window.scrollBy(0, ${direction === "down" ? "" : "-"}Math.round(window.innerHeight * 0.8));`);
  }

  async back() {
    await this.client.request("POST", this.client.session("/back"), {});
  }

  async wait(ms) {
    await sleep(ms);
  }

  async settle() {
    const deadline = Date.now() + this.config.loadTimeoutMs;
    while (Date.now() < deadline) {
      const state = await this.execute("return document.readyState;").catch(() => "loading");
      if (state === "complete") break;
      await sleep(100);
    }
    await sleep(this.config.settleMs);
  }

  async screenshot(file) {
    const data = await this.client.request("GET", this.client.session("/screenshot"));
    await ensureDir(path.dirname(file));
    await fs.writeFile(file, Buffer.from(data, "base64"));
    return file;
  }

  async historyLength() {
    try {
      return Number(await this.execute("return history.length;")) || 1;
    } catch {
      return 1;
    }
  }

  async finish({ success, keep } = {}) {
    const keepPage = keep ?? (success && this.config.safari?.keepOnSuccess !== false);
    if (!this.client?.sessionId) {
      this.process?.kill();
      return;
    }
    if (keepPage) {
      this.log("leaving the Safari window open for you to continue (safaridriver keeps running)");
      this.process.unref?.();
      return;
    }
    await this.client.request("DELETE", this.client.session()).catch(() => {});
    this.process?.kill();
  }

  describe() {
    return { backend: "safari", sessionId: this.client?.sessionId ?? null };
  }
}
