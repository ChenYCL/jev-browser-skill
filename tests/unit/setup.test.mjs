// `jev-browser setup`: argument validation, status/stop against a scratch home, the clean refusal
// when a prerequisite is missing, and — in-process, with the launcher seams injected — the
// fetch → start → persist → verify path. No test starts a server, downloads a model, or writes
// outside its own temporary home.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BIN } from "../helpers/env.mjs";
import { setupCommand } from "../../skills/jev-browser/lib/setup.mjs";
import { defaultLocalModel } from "../../skills/jev-browser/lib/local.mjs";

const run = promisify(execFile);
const SKILL_DIR = fileURLToPath(new URL("../../skills/jev-browser", import.meta.url));

async function cli(args, { env = {}, home, cwd = home } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, HOME: home, ...env }, cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function scratch(t, prefix = "jev-setup-home-") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test("setup with no argument reports each tier and the command that sets it up", async (t) => {
  const home = await scratch(t);
  const json = await cli(["setup", "--json", "--home", home], { home });
  assert.equal(json.code, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.uses.tier, "hosted", "a clean home still runs on hosted Jev");
  assert.deepEqual(
    report.tiers.map((tier) => tier.tier),
    ["local-readout", "kev"],
  );
  for (const tier of report.tiers) {
    assert.equal(tier.installed, false, `${tier.tier} is not installed in a scratch home`);
    assert.equal(tier.running, false);
    assert.equal(tier.configured, false);
    assert.match(tier.setupCommand, new RegExp(`setup ${tier.tier}$`));
    assert.ok(tier.logFile.startsWith(home), "the log lives under the home that was named");
  }

  const text = await cli(["setup", "--home", home], { home });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /set it up: .*setup local-readout/);
  assert.match(text.stdout, /set it up: .*setup kev/);
});

test("setup status reports not installed / not running / not configured and writes nothing", async (t) => {
  const home = await scratch(t);
  const status = await cli(["setup", "status", "--json", "--home", home], { home });
  assert.equal(status.code, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  for (const tier of report.tiers) {
    assert.deepEqual(
      { installed: tier.installed, running: tier.running, configured: tier.configured },
      { installed: false, running: false, configured: false },
      tier.tier,
    );
    assert.match(tier.installedDetail, /not downloaded|no Kev checkout/);
  }
  assert.deepEqual(await fs.readdir(home), [], "status is read-only: it does not even create the run directory");
});

test("setup stop stops nothing without a pid file, and refuses a pid that is not a launcher", async (t) => {
  const home = await scratch(t);
  const idle = await cli(["setup", "stop", "local-readout", "--json", "--home", home], { home });
  assert.equal(idle.code, 0, idle.stderr);
  const idleReport = JSON.parse(idle.stdout);
  assert.equal(idleReport.stopped, false);
  assert.equal(idleReport.reason, "no pid file");

  // A pid file naming a live process that is not one of our launchers: never killed.
  const runDir = path.join(home, ".jev-browser", "run");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "jev-local-8092.pid"), `${process.pid}\n`);
  const foreign = await cli(["setup", "stop", "local-readout", "--home", home], { home });
  assert.equal(foreign.code, 1);
  assert.match(foreign.stdout, /not a local-readout launcher/);
  assert.doesNotThrow(() => process.kill(process.pid, 0), "the foreign process is untouched");
  assert.equal(await fs.readFile(path.join(runDir, "jev-local-8092.pid"), "utf8"), `${process.pid}\n`, "an ambiguous pid file is left alone");
});

test("setup rejects unknown targets and misplaced flags", async (t) => {
  const home = await scratch(t);
  const unknownTarget = await cli(["setup", "bogus", "--home", home], { home });
  assert.equal(unknownTarget.code, 2);
  assert.match(unknownTarget.stderr, /unknown setup target "bogus"/);
  assert.match(unknownTarget.stderr, /usage: jev-browser setup/);

  const unknownTier = await cli(["setup", "stop", "bogus", "--home", home], { home });
  assert.equal(unknownTier.code, 2);
  assert.match(unknownTier.stderr, /unknown tier "bogus"/);

  const unknownModel = await cli(["setup", "local-readout", "--model-name", "nope", "--home", home], { home });
  assert.equal(unknownModel.code, 2);
  assert.match(unknownModel.stderr, /unknown local model "nope"/);

  const misplacedSkip = await cli(["setup", "local-readout", "--skip-deps", "--home", home], { home });
  assert.equal(misplacedSkip.code, 2);
  assert.match(misplacedSkip.stderr, /--skip-deps applies to `setup kev`/);

  const misplacedModel = await cli(["setup", "kev", "--model-name", "qwen3.5-0.8b-q8", "--home", home], { home });
  assert.equal(misplacedModel.code, 2);
  assert.match(misplacedModel.stderr, /--model-name applies to `setup local-readout`/);
});

test("setup local-readout refuses cleanly when llama.cpp is absent", async (t) => {
  const home = await scratch(t);
  // JEV_LLAMA_SERVER pins the lookup, so this is deterministic even where Homebrew has llama.cpp.
  const out = await cli(["setup", "local-readout", "--home", home], { home, env: { PATH: "/nonexistent", JEV_LLAMA_SERVER: "/nonexistent/llama-server" } });
  assert.equal(out.code, 2, "a missing prerequisite is a usage/config problem");
  assert.match(out.stderr, /brew install llama\.cpp/);
  assert.match(out.stderr, /JEV_LLAMA_SERVER/);
  assert.deepEqual(await fs.readdir(home), [], "nothing is fetched or written when the prerequisite is missing");
});

test("setup kev asks for uv before it touches anything", async (t) => {
  const home = await scratch(t);
  const out = await cli(["setup", "kev", "--home", home], { home, env: { PATH: "/nonexistent" } });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /brew install uv/);
  assert.match(out.stderr, /uv sync --extra serve/);
  assert.deepEqual(await fs.readdir(home), [], "no clone, no cache, no config");
});

test("setup kev --skip-deps refuses without a prepared checkout instead of downloading", async (t) => {
  const home = await scratch(t);
  const out = await cli(["setup", "kev", "--skip-deps", "--home", home], { home });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /Prepare it with/);
  assert.match(out.stderr, /uv sync --extra serve --project .*jev-browser\/kev/);
  assert.deepEqual(await fs.readdir(home), [], "--skip-deps never clones, syncs or fetches");
});

test("a successful local-readout setup fetches, starts, persists both values and verifies", async (t) => {
  const home = await scratch(t);
  const entry = defaultLocalModel();
  const calls = { runStep: [], startDetached: [], verify: [] };
  const pidFile = path.join(home, ".jev-browser", "run", "jev-local-8092.pid");
  const deps = {
    findLlamaServer: () => "/opt/homebrew/bin/llama-server",
    runStep: async (step) => {
      calls.runStep.push(step);
      return { code: 0 };
    },
    startDetached: async (step) => {
      calls.startDetached.push(step);
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, "4242\n");
      return { code: 0, stdout: "TYPESAFE_BASE_URL=http://127.0.0.1:8092 TYPESAFE_API_KEY=local" };
    },
    verify: async (options) => {
      calls.verify.push(options);
      return { answer: { type: "noul", noul: 1 }, detail: "noul: P(yes)=1.00", ms: 12, model: "qwen3.5-4b-q4-k-m" };
    },
    kevRuntime: async () => ({ ok: true, clone: "/none", python: "/none", kind: "ok", detail: "unused" }),
  };

  const out = await setupCommand({ sub: "local-readout", options: { home, env: { HOME: home, PATH: "/nonexistent" }, skillDir: SKILL_DIR, log: () => {} }, deps });
  assert.equal(out.code, 0);
  assert.deepEqual(calls.runStep[0].args, [path.join(SKILL_DIR, "bin", "jev-local.mjs"), "--download-only", "--model-name", entry.id], "the launcher's own --download-only fetches");
  assert.deepEqual(calls.startDetached[0].args, ["--detach", "--model-name", entry.id], "the launcher's own --detach serves");
  for (const call of [...calls.runStep, ...calls.startDetached]) assert.equal(call.env.HOME, home, "children run against the home that was named");
  assert.equal(calls.verify[0].baseUrl, "http://127.0.0.1:8092");
  assert.equal(calls.verify[0].apiKey, "local");

  const config = JSON.parse(await fs.readFile(path.join(home, ".config", "jev-browser", "config.json"), "utf8"));
  assert.equal(config.baseUrl, "http://127.0.0.1:8092");
  assert.equal(config.apiKey, "local");
  assert.equal(out.json.pid, 4242);
  assert.match(out.text, /verified\s+noul: P\(yes\)=1\.00/);
  assert.match(out.text, /log\s+.*jev-local-8092\.log/);
  assert.match(out.text, /setup stop local-readout/);
});

test("a setup whose endpoint cannot answer still persists the config and names the log", async (t) => {
  const home = await scratch(t);
  const deps = {
    findLlamaServer: () => "/opt/homebrew/bin/llama-server",
    runStep: async () => ({ code: 0 }),
    startDetached: async () => ({ code: 0, stdout: "" }),
    verify: async () => {
      throw new Error("TypeSafe connection failed: fetch failed");
    },
    kevRuntime: async () => ({ ok: true, clone: "/none", python: "/none", kind: "ok", detail: "unused" }),
  };

  await assert.rejects(
    setupCommand({ sub: "local-readout", options: { home, env: { HOME: home, PATH: "/nonexistent" }, skillDir: SKILL_DIR, log: () => {} }, deps }),
    /did not answer the verification question: TypeSafe connection failed[\s\S]*log: .*jev-local-8092\.log/,
  );
  const config = JSON.parse(await fs.readFile(path.join(home, ".config", "jev-browser", "config.json"), "utf8"));
  assert.deepEqual(config, { version: 1, baseUrl: "http://127.0.0.1:8092", apiKey: "local" }, "the config is written before the endpoint is asked");
});
