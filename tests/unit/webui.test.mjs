// The local WebUI: what it refuses, what it never sends to a browser, and that its answers are the
// CLI's answers. Offline throughout — the only endpoint any test needs is the mock TypeSafe
// fixture, and every child process is a stub, so no test can start a real model server.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { loadConfig } from "../../skills/jev-browser/lib/config.mjs";
import { describeTier, fetchModels, formatTierStatus, probeEndpoint, tierRows } from "../../skills/jev-browser/lib/tiers.mjs";
import { WebUiError, assertLoopbackHost, createWebUiServer, listenWebUi, modelRoot, parsePort, requireModelId, resolveModelPath } from "../../skills/jev-browser/lib/webui.mjs";
import { createMockTypeSafe } from "../helpers/mock-typesafe.mjs";

const SKILL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "skills", "jev-browser");
const KEY = "sk-webui-test-0f3a9c2b7d1e4a5f";
const DEAD_ENDPOINT = "http://127.0.0.1:9/";

async function tempHome(config = null) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jev-webui-home-"));
  if (config) {
    const dir = path.join(home, ".config", "jev-browser");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ version: 1, ...config }), { mode: 0o600 });
  }
  return home;
}

/** A child_process.spawn stand-in: every test asserts on `calls` instead of starting anything. */
function stubSpawn(calls) {
  return (file, args, options) => {
    calls.push({ file, args: [...args], options });
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      child.emit("close", 0, signal ?? null);
      return true;
    };
    return child;
  };
}

async function startUi({ home, env, ...options } = {}) {
  const calls = [];
  const ui = createWebUiServer({
    skillDir: SKILL_DIR,
    home,
    env: env ?? { HOME: home, PATH: process.env.PATH },
    cwd: home,
    spawn: stubSpawn(calls),
    log: () => {},
    ...options,
  });
  const address = await listenWebUi(ui.server, { port: 0 });
  return { ui, calls, address, base: `http://127.0.0.1:${address.port}` };
}

const get = (base, url) => fetch(base + url, { cache: "no-store" });
const post = (base, url, body) =>
  fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

async function withUi(home, fn, options = {}) {
  const context = await startUi({ home, ...options });
  try {
    return await fn(context);
  } finally {
    await context.ui.close();
  }
}

test("the server binds loopback only, and the served page carries no secret", async () => {
  assert.throws(() => assertLoopbackHost("0.0.0.0"), /loopback-only/);
  assert.throws(() => assertLoopbackHost("192.168.1.10"), /loopback-only/);
  assert.equal(assertLoopbackHost("127.0.0.1"), "127.0.0.1");

  const home = await tempHome({ apiKey: KEY });
  try {
    await withUi(home, async ({ base, address }) => {
      assert.equal(address.address, "127.0.0.1", "the listening socket must be loopback");
      const never = createWebUiServer({ home });
      await assert.rejects(listenWebUi(never.server, { port: 0, host: "0.0.0.0" }), /loopback-only/);
      assert.equal(never.server.listening, false);

      const response = await get(base, "/");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/html/);
      const html = await response.text();
      assert.ok(!html.includes(KEY), "the served page must not contain the API key");
      assert.ok(!/src="https?:|href="https?:|@import\s|cdn\./i.test(html), "the page must not reference any external asset");
      assert.match(html, /<script>/, "the page is self-contained");
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("no route returns the API key value, in any shape", async () => {
  const mock = createMockTypeSafe();
  await mock.listen();
  const home = await tempHome({ apiKey: KEY, baseUrl: mock.baseUrl });
  try {
    await withUi(home, async ({ base }) => {
      const bodies = [];
      for (const url of ["/", "/api/tiers", "/api/config", "/api/doctor?live=1", "/api/doctor?live=0", "/api/models", "/api/logs?channel=run", "/api/tiers/use?tier=kev", "/api/run"]) {
        const response = await get(base, url);
        bodies.push(`${url} ${response.status} ${await response.text()}`);
      }
      const writes = [
        ["/api/tiers/start", { tier: "nope" }],
        ["/api/tiers/stop", { tier: "nope" }],
        ["/api/tiers/use", { tier: "nope" }],
        ["/api/config", { patch: { nope: 1 } }],
        ["/api/config/unset", { key: "nope" }],
        ["/api/models/start", { modelName: "nope" }],
        ["/api/run", { goal: "anything" }],
        ["/api/run/stop", {}],
        ["/api/judge", { state: '{"ticket":"My card was charged twice"}', questions: { refund: { type: "noul", instructions: "Does `ticket` ask for a refund?" } } }],
      ];
      for (const [url, body] of writes) {
        const response = await post(base, url, body);
        bodies.push(`${url} ${response.status} ${await response.text()}`);
      }
      for (const body of bodies) assert.ok(!body.includes(KEY), `a key leaked in: ${body.slice(0, 240)}`);
      // The judge route really did answer from the endpoint, so the scan above covered a live body.
      assert.ok(mock.requests.length >= 1, "the judge route must have called the configured endpoint");
      assert.ok(bodies.some((body) => body.includes('"answers"')), "…and its answers must have been scanned");
    });
  } finally {
    await mock.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("POST /api/config writes the user config through lib/config.mjs and never echoes the key", async () => {
  const home = await tempHome({ baseUrl: DEAD_ENDPOINT });
  try {
    await withUi(home, async ({ base, calls }) => {
      const response = await post(base, "/api/config", {
        patch: { baseUrl: "http://127.0.0.1:8092", "thresholds.profile": "kev", maxSteps: 7 },
        apiKey: KEY,
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!text.includes(KEY), "the key must never come back");
      const body = JSON.parse(text);
      assert.equal(body.keySet, true);
      assert.equal(body.config.apiKey, "(set)", "the browser learns only that a key is set");
      assert.deepEqual(
        body.diff.map((entry) => entry.path).sort(),
        ["apiKey", "baseUrl", "maxSteps", "thresholds.goalDone", "thresholds.goalDoneFinal", "thresholds.profile"],
      );
      assert.deepEqual(body.diff.find((entry) => entry.path === "apiKey"), { path: "apiKey", from: null, to: "(set)" });
      assert.equal(calls.length, 0, "a config write must not spawn anything");

      // Read it back through the module the CLI uses — the file, not the route's own memory.
      const { config } = await loadConfig({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: home });
      assert.equal(config.apiKey, KEY);
      assert.equal(config.baseUrl, "http://127.0.0.1:8092");
      assert.equal(config.thresholds.profile, "kev");
      assert.equal(config.maxSteps, 7);
      assert.equal(config.thresholds.goalDone, 0.482, "the pinned profile's bar is applied by loadConfig");
      const mode = (await fs.stat(path.join(home, ".config", "jev-browser", "config.json"))).mode & 0o777;
      assert.equal(mode, 0o600);

      const unset = await post(base, "/api/config/unset", { key: "thresholds.profile" });
      assert.equal(unset.status, 200);
      const after = await loadConfig({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: home });
      assert.equal(after.config.thresholds.profile, "auto");
      assert.equal(after.config.maxSteps, 7, "unset touches one key only");

      const refusedKey = await post(base, "/api/config", { patch: { "chrome.extraArgs": ["--no-sandbox"] } });
      assert.equal(refusedKey.status, 400);
      assert.match((await refusedKey.json()).error, /not editable/);
      const refusedProfile = await post(base, "/api/config", { patch: { "thresholds.profile": "nope" } });
      assert.equal(refusedProfile.status, 400);
      const refusedUnset = await post(base, "/api/config/unset", { key: "chrome.executable" });
      assert.equal(refusedUnset.status, 400);
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("hostile request fields are rejected with a 4xx and never spawn a process", async () => {
  const home = await tempHome();
  try {
    await withUi(home, async ({ base, calls }) => {
      const cases = [
        ["an unknown tier", "/api/tiers/start", { tier: "hosted" }],
        ["an unknown tier name", "/api/tiers/start", { tier: "local" }],
        ["a fractional port", "/api/tiers/start", { tier: "kev", port: "8092.5" }],
        ["an out-of-range port", "/api/tiers/start", { tier: "kev", port: 70000 }],
        ["a port below the floor", "/api/tiers/start", { tier: "kev", port: 80 }],
        ["a port that is not a number", "/api/tiers/start", { tier: "kev", port: "8092; rm -rf /" }],
        ["a model id outside the registry", "/api/tiers/start", { tier: "local-readout", modelName: "gpt-4" }],
        ["a model id outside the registry", "/api/models/start", { modelName: "../../etc/passwd" }],
        ["a model path outside the allowed root", "/api/models/start", { modelPath: "/etc/passwd.gguf" }],
        ["a model path outside the allowed root", "/api/models/start", { modelPath: "~/../.ssh/id_rsa.gguf" }],
        ["a relative model path", "/api/models/start", { modelPath: "model.gguf" }],
        ["a model path that is not a .gguf", "/api/models/start", { modelPath: path.join(modelRoot(home), "notes.txt") }],
        ["an unknown log channel", null, null],
        ["a goal that is not a URL", "/api/run", { goal: "go", url: "not a url" }],
        ["a backend outside the list", "/api/run", { goal: "go", url: "https://example.com", backend: "firefox" }],
        ["a step count that is not a number", "/api/run", { goal: "go", url: "https://example.com", maxSteps: "many" }],
        ["a config key outside the allow list", "/api/config", { patch: { "thresholds.blocker": 0.1 } }],
      ];
      for (const [label, url, body] of cases) {
        if (url === null) {
          const response = await get(base, "/api/logs?channel=../../etc/passwd");
          assert.equal(response.status, 400, label);
          continue;
        }
        const response = await post(base, url, body);
        assert.ok(response.status >= 400 && response.status < 500, `${label}: expected 4xx, got ${response.status}`);
        assert.ok((await response.json()).error, `${label}: a 4xx must say why`);
      }
      assert.equal(calls.length, 0, "no rejected request may spawn a process");

      // …and the validators say the same thing when called directly.
      assert.throws(() => parsePort("8092.5"), WebUiError);
      assert.throws(() => parsePort(-1), /between 1024 and 65535/);
      assert.throws(() => resolveModelPath("/etc/passwd.gguf", { home }), /must be under/);
      assert.throws(() => resolveModelPath(path.join(modelRoot(home), "a.txt"), { home }), /\.gguf/);
      assert.throws(() => requireModelId("gpt-4", { models: { "qwen3.5-0.8b-q8": {} } }), /unknown model id/);
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("every command is spawned as an argv array, so a value can never reach a shell", async () => {
  const home = await tempHome();
  const payload = "Open the cart; rm -rf /tmp/pwned";
  try {
    await withUi(home, async ({ base, calls, ui }) => {
      const response = await post(base, "/api/run", {
        goal: payload,
        url: "https://example.com/",
        inputs: [{ key: "note", value: "a && b" }],
        secrets: [{ key: "password", value: "hunter2" }],
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(!body.command.includes("hunter2"), "the echoed command line must not carry a secret");
      assert.ok(body.command.includes("‹secret›"));

      assert.equal(calls.length, 1);
      const call = calls.at(-1);
      assert.equal(call.file, process.execPath, "the runner is node itself, not a shell");
      assert.ok(call.args[0].endsWith(path.join("bin", "jev-browser.mjs")), "the script is the skill's own bin");
      assert.notEqual(call.options.shell, true);
      assert.ok(!call.args.some((arg) => ["sh", "bash", "zsh", "-c"].includes(arg)), "no argument may name a shell");
      assert.equal(call.args.filter((arg) => arg === payload).length, 1, "the goal is one argv element, verbatim");
      assert.ok(call.args.includes("note=a && b"), "an input value is one argv element");
      assert.ok(call.args.includes("password=hunter2"), "a secret is one argv element");
      assert.ok(call.args.includes("--journal-dir"));
      const journalDir = call.args[call.args.indexOf("--journal-dir") + 1];
      assert.ok(journalDir.startsWith(os.tmpdir()), "the journal stays under the OS temp directory");

      // The progress pane carries stderr; stdout is the JSON result and must not be mixed into it.
      const runChild = ui.children.get("run").child;
      runChild.stdout.write('{"status":"success","steps":1}\n');
      runChild.stderr.write("step 1: goal_done=0.02\n");
      const runLog = await (await get(base, "/api/logs?channel=run&since=0")).json();
      assert.deepEqual(runLog.lines.map((line) => line.text), ["step 1: goal_done=0.02"]);
      runChild.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const finished = await (await get(base, "/api/run")).json();
      assert.equal(finished.ready, true);
      assert.equal(finished.result.status, "success", "stdout is parsed as the result instead");

      const model = await post(base, "/api/models/start", { modelName: "qwen3.5-0.8b-q8" });
      assert.equal(model.status, 200);
      const modelCall = calls.at(-1);
      assert.equal(modelCall.file, process.execPath);
      assert.ok(modelCall.args[0].endsWith(path.join("bin", "jev-local.mjs")));
      assert.deepEqual(modelCall.args.slice(1), ["--port", "8092", "--model-name", "qwen3.5-0.8b-q8"]);

      const kev = await post(base, "/api/tiers/start", { tier: "kev" });
      assert.equal(kev.status, 200);
      const kevCall = calls.at(-1);
      assert.ok(kevCall.args[0].endsWith(path.join("bin", "jev-kev.mjs")));
      assert.deepEqual(kevCall.args.slice(1), ["--port", "8008"]);
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("the log pane streams a child's output from a cursor", async () => {
  const home = await tempHome();
  try {
    await withUi(home, async ({ base, ui }) => {
      const started = await (await post(base, "/api/tiers/start", { tier: "local-readout" })).json();
      assert.equal(started.channel, "tier:local-readout");
      const child = [...ui.children.values()].at(-1).child;
      child.stdout.write("downloading Qwen3.5-4B-Q4_K_M.gguf\n");
      child.stdout.write("  50% of 2614 MiB\n");
      child.stderr.write("starting llama-server on 127.0.0.1:8090\n");

      const first = await (await get(base, "/api/logs?channel=tier:local-readout&since=0")).json();
      assert.deepEqual(
        first.lines.map((line) => `${line.stream}:${line.text}`),
        ["stdout:downloading Qwen3.5-4B-Q4_K_M.gguf", "stdout:  50% of 2614 MiB", "stderr:starting llama-server on 127.0.0.1:8090"],
      );
      assert.equal(first.running, true);
      assert.equal(first.ready, false);

      const empty = await (await get(base, `/api/logs?channel=tier:local-readout&since=${first.next}`)).json();
      assert.deepEqual(empty.lines, [], "a cursor past the end returns nothing, so nothing repeats");

      child.kill("SIGTERM");
      const closed = await (await get(base, `/api/logs?channel=tier:local-readout&since=${first.next}`)).json();
      assert.equal(closed.lines.at(-1).text, "[exited: code=0 signal=SIGTERM]");
      assert.equal(closed.running, false);
      assert.equal(closed.ready, true);
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("`use this tier` prints the CLI text and writes only when asked to", async () => {
  const home = await tempHome();
  const env = { HOME: home, PATH: process.env.PATH };
  try {
    await withUi(home, async ({ base, calls }) => {
      const shown = await (await get(base, "/api/tiers/use?tier=kev")).json();
      assert.equal(shown.baseUrl, "http://127.0.0.1:8008");
      assert.equal(shown.command, `node ${path.join(SKILL_DIR, "bin", "jev-kev.mjs")}`);
      assert.match(shown.text, /TYPESAFE_BASE_URL=http:\/\/127\.0\.0\.1:8008/);
      assert.equal((await loadConfig({ home, env, cwd: home })).config.baseUrl, "https://api.typesafe.ai", "showing must write nothing");

      const saved = await (await post(base, "/api/tiers/use", { tier: "kev" })).json();
      assert.equal(saved.persisted, path.join(home, ".config", "jev-browser", "config.json"));
      assert.equal(saved.baseUrl, "http://127.0.0.1:8008");
      assert.match(saved.text, /Stored apiKey=local and baseUrl=http:\/\/127\.0\.0\.1:8008/);
      const after = (await loadConfig({ home, env, cwd: home })).config;
      assert.equal(after.baseUrl, "http://127.0.0.1:8008");
      assert.equal(after.apiKey, "local", "a local tier stores its placeholder key too, exactly like `tier use --persist`");
      assert.equal(calls.length, 0, "picking a tier starts nothing");

      const hosted = await (await post(base, "/api/tiers/use", { tier: "hosted" })).json();
      assert.equal(hosted.baseUrl, "https://api.typesafe.ai");
      assert.equal(hosted.apiKey, null, "hosted stores no key");
      assert.match(hosted.text, /Stored baseUrl=https:\/\/api\.typesafe\.ai/);
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("closing the WebUI stops every child it started", async () => {
  const home = await tempHome();
  const ctx = await startUi({ home });
  try {
    assert.equal((await post(ctx.base, "/api/tiers/start", { tier: "kev" })).status, 200);
    assert.equal((await post(ctx.base, "/api/run", { goal: "go", url: "https://example.com" })).status, 200);
    assert.equal([...ctx.ui.children.values()].every((record) => record.running), true);

    const killed = [];
    for (const record of ctx.ui.children.values()) {
      const kill = record.child.kill.bind(record.child);
      record.child.kill = (signal) => {
        killed.push(signal);
        return kill(signal);
      };
    }
    await ctx.ui.close();
    assert.deepEqual(killed, ["SIGTERM", "SIGTERM"], "shutdown signals the launcher and the run");
    assert.equal([...ctx.ui.children.values()].every((record) => !record.running), true);
    assert.equal(ctx.ui.server.listening, false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("the tier panel is the CLI's own resolution, not a copy", async () => {
  const mock = createMockTypeSafe();
  await mock.listen();
  try {
    // A clean home: no config, no key, no environment — hosted Jev, exactly as `tier status` says.
    const clean = await tempHome();
    await withUi(clean, async ({ base }) => {
      const { config } = await loadConfig({ home: clean, env: { HOME: clean, PATH: process.env.PATH }, cwd: clean });
      const models = await fetchModels({ config });
      const classification = await probeEndpoint({ config, models });
      const status = describeTier({ config, classification, skillDir: SKILL_DIR });
      assert.equal(status.tier, "hosted");
      const body = await (await get(base, "/api/tiers")).json();
      assert.deepEqual(body.status, status);
      assert.equal(body.statusText, formatTierStatus(status));
      assert.deepEqual(body.tiers, tierRows({ skillDir: SKILL_DIR }));
      assert.equal(body.defaultTier, "hosted");
      assert.equal(body.local.length, 2, "both local tiers get a start/stop control");
    });
    await fs.rm(clean, { recursive: true, force: true });

    // A loopback baseUrl with a key: the endpoint is classified live, and the same numbers come out.
    const home = await tempHome({ apiKey: KEY, baseUrl: mock.baseUrl });
    await withUi(home, async ({ base }) => {
      const { config } = await loadConfig({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: home });
      const models = await fetchModels({ config });
      const classification = await probeEndpoint({ config, models });
      const status = describeTier({ config, classification, skillDir: SKILL_DIR });
      assert.equal(status.tier, "local-readout", "the mock card is name-only, so the GGUF readout profile applies");
      const body = await (await get(base, "/api/tiers")).json();
      assert.deepEqual(body.status, status);
      assert.equal(body.statusText, formatTierStatus(status));
      assert.equal(body.status.effective.goalDone, 0.174);
    });
    await fs.rm(home, { recursive: true, force: true });
  } finally {
    await mock.close();
  }
});
