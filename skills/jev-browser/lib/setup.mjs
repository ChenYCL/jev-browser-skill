// `jev-browser setup`: the one-click path to a local judging backend. It composes the launchers —
// their `--download-only` to fetch, their `--detach` to serve — and never re-implements them, then
// proves the endpoint answers one real question before it reports success.
//
// Every write lands under the effective home directory (the user config, ~/.jev-browser/run, the
// model cache, and by default the Kev checkout), so `--home <dir>` isolates a scratch setup.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIER, describeTier, tierByName } from "./tiers.mjs";
import { defaultLocalModel, findLlamaServer, llamaMissingHint, localModel, localPaths } from "./local.mjs";
import { KEV_UV_HINT, kevSetupCommands, probeKevRuntime } from "./kev.mjs";
import { saveUserConfig, userConfigPath } from "./config.mjs";
import { TypeSafeClient } from "./typesafe.mjs";
import { runPaths, waitUntilReady } from "./detach.mjs";

const exec = promisify(execFile);
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The tiers `setup` can install. Hosted Jev is the default and needs nothing. */
export const SETUP_TIERS = ["local-readout", "kev"];
export const SETUP_USAGE = "usage: jev-browser setup [local-readout | kev | status | stop <tier>] [--model-name <id>] [--skip-deps] [--json]";

const configError = (message) => Object.assign(new Error(message), { config: true });

/** The question a fresh setup asks through the endpoint it just started: the proof it prints. */
export const VERIFY_STATE = { ticket: "My card was charged twice" };
export const VERIFY_QUESTIONS = { refund: { type: "noul", instructions: "Does `ticket` ask for a refund?" } };

/** Ask the endpoint one real question and return its parsed answer. Throws when it cannot answer. */
export async function verifyEndpoint({ baseUrl, apiKey, model, timeoutMs = 120_000 }) {
  const client = new TypeSafeClient({ apiKey, baseUrl, model, timeoutMs, maxRetries: 0 });
  const started = performance.now();
  const result = await client.systemOne({ state: VERIFY_STATE, questions: VERIFY_QUESTIONS });
  const answer = result.answers.refund;
  const detail = answer.type === "noul" ? `noul: P(yes)=${answer.noul.toFixed(2)}` : `${answer.type}: ${answer.choice ?? answer.score}`;
  return { answer, detail, ms: Math.round(performance.now() - started), model: result.model, costUsd: result.costUsd };
}

/** Run a child with the terminal attached, printing the command first (clone / uv sync / fetch). */
async function runStepStreaming({ command, args, env, cwd, log }) {
  log(`$ ${command} ${args.join(" ")}`);
  return {
    code: await new Promise((resolve) => {
      const child = spawn(command, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
      child.once("error", () => resolve(1));
      child.once("exit", (code) => resolve(code ?? 1));
    }),
  };
}

/** Start a launcher detached: it returns once it printed its env line, or failed with a log. */
async function startLauncherDetached({ script, args, env, cwd, timeoutMs }) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      resolve(124);
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(1);
    });
    child.once("exit", (exit) => {
      clearTimeout(timer);
      resolve(exit ?? 1);
    });
  });
  return { code, stdout: stdout.trim() };
}

/** `uv` on PATH, or null. uv builds Kev's venv and is not a Node dependency. */
async function findUv({ env = process.env } = {}) {
  try {
    const { stdout } = await exec("uv", ["--version"], { env, timeout: 20_000 });
    return { path: "uv", version: String(stdout).trim() };
  } catch {
    return null;
  }
}

function defaultDeps(env) {
  return {
    findLlamaServer: () => findLlamaServer({ env }),
    findUv: () => findUv({ env }),
    runStep: runStepStreaming,
    startDetached: startLauncherDetached,
    verify: (options) => verifyEndpoint(options),
    kevRuntime: (options = {}) => probeKevRuntime(options),
  };
}

const exists = (file) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false);

const statOrNull = (file) => fs.stat(file).catch(() => null);

const readJsonOrNull = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
};

async function readPid(file) {
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Is `pid` alive, and does its command line look like the launcher that wrote the pid file? */
async function pidState(pid, expect = null) {
  if (!pid) return { pid, alive: false, ours: false, command: null };
  try {
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "command="], { timeout: 5000 });
    const command = String(stdout).trim();
    if (!command) return { pid, alive: false, ours: false, command: null };
    return { pid, alive: true, ours: expect ? command.includes(expect) : true, command };
  } catch {
    return { pid, alive: false, ours: false, command: null };
  }
}

async function getJsonOrNull(url, timeoutMs = 1500) {
  try {
    return await (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).json();
  } catch {
    return null;
  }
}

const launcherPath = (tier, skillDir) => path.join(skillDir, "bin", tier === "kev" ? "jev-kev.mjs" : "jev-local.mjs");
const pidName = (tier) => (tier === "kev" ? "jev-kev" : "jev-local");
const kevClone = (home) => path.join(home, ".local", "share", "jev-browser", "kev");
const humanBytes = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`);

/** What either endpoint answers when it is up. */
async function endpointServing(tier, port) {
  if (tier === "kev") {
    const card = await getJsonOrNull(`http://127.0.0.1:${port}/v1/models`);
    return Boolean(card?.models?.length);
  }
  const health = await getJsonOrNull(`http://127.0.0.1:${port}/health`);
  return health?.service === "jev-local";
}

/** Installed (and verified) state for one tier, from the files this machine actually has. */
async function installedState({ tier, home, deps }) {
  if (tier === "kev") {
    const clone = kevClone(home);
    const runtime = await deps.kevRuntime({ clone });
    const checkpoint = await exists(path.join(home, ".cache", "huggingface", "hub", "models--jaredpalmer--kev-4b"));
    const base = await exists(path.join(home, ".cache", "huggingface", "hub", "models--Qwen--Qwen3.5-4B-Base"));
    return { installed: runtime.ok && checkpoint && base, detail: `${runtime.detail} · assets ${checkpoint && base ? "cached" : "not cached (the launcher verifies them with --verify-only)"}` };
  }
  let entry;
  try {
    entry = defaultLocalModel();
  } catch (error) {
    return { installed: false, detail: `registry problem: ${error.message}` };
  }
  const { modelFile } = localPaths(home, entry);
  const stat = await statOrNull(modelFile);
  const bytes = stat?.size ?? 0;
  return {
    installed: bytes > 0 && bytes === entry.bytes,
    detail:
      bytes === 0
        ? `${entry.id} not downloaded (${humanBytes(entry.bytes)} expected)`
        : bytes === entry.bytes
          ? `${entry.id} verified (${humanBytes(bytes)})`
          : `${entry.id} truncated (${bytes} of ${entry.bytes} bytes)`,
  };
}

/** installed / running / configured / serving for one tier. */
async function tierState({ tier: name, home, skillDir, deps }) {
  const tier = tierByName(name);
  const paths = runPaths(home, pidName(name), tier.port);
  const pid = await readPid(paths.pidFile);
  const alive = await pidState(pid, path.basename(launcherPath(name, skillDir)));
  const userConfig = await readJsonOrNull(userConfigPath(home));
  const installed = await installedState({ tier: name, home, deps });
  return {
    tier: name,
    baseUrl: tier.baseUrl,
    port: tier.port,
    installed: installed.installed,
    installedDetail: installed.detail,
    running: alive.alive,
    serving: await endpointServing(name, tier.port),
    configured: userConfig?.baseUrl === tier.baseUrl && Boolean(userConfig?.apiKey),
    pid: alive.alive ? pid : null,
    pidFile: paths.pidFile,
    logFile: paths.logFile,
    setupCommand: `node ${path.join(skillDir, "bin", "jev-browser.mjs")} setup ${name}`,
  };
}

const stateFlags = (state) => `${state.installed ? "installed" : "not installed"} · ${state.running || state.serving ? "running" : "not running"} · ${state.configured ? "configured" : "not configured"}`;
const stateText = (state) => [`${state.tier.padEnd(15)} ${stateFlags(state)}`, `                ${state.installedDetail}`, `                log ${state.logFile}`];

/** `jev-browser setup` — what is installed, what is running, what a run uses, and what to type next. */
async function overview({ home, config, skillDir, deps }) {
  const states = [];
  for (const tier of SETUP_TIERS) states.push(await tierState({ tier, home, skillDir, deps }));
  const using = describeTier({ config, classification: null, skillDir });
  const lines = ["jev-browser setup — the local judging backends", "", `a run right now uses: ${using.tier} — ${config.baseUrl}`, ""];
  for (const state of states) {
    lines.push(...stateText(state));
    if (!(state.installed && state.configured)) lines.push(`                set it up: ${state.setupCommand}`);
    lines.push("");
  }
  lines.push(`details: jev-browser setup status   ·   stop one: jev-browser setup stop <${SETUP_TIERS.join("|")}>`);
  lines.push("hosted Jev is the default and needs no setup.");
  return { code: 0, text: lines.join("\n"), json: { uses: { tier: using.tier, baseUrl: config.baseUrl }, tiers: states } };
}

/** `jev-browser setup status` — per local tier: installed, running, configured, log. */
async function statusReport({ home, skillDir, deps }) {
  const states = [];
  for (const tier of SETUP_TIERS) states.push(await tierState({ tier, home, skillDir, deps }));
  const lines = ["jev-browser setup status", ""];
  for (const state of states) {
    lines.push(...stateText(state));
    lines.push("");
  }
  const next = states.filter((state) => !(state.installed && state.configured));
  lines.push(next.length ? `not set up yet: ${next.map((state) => state.setupCommand).join("   ·   ")}` : "every local tier is installed and configured.");
  return { code: 0, text: lines.join("\n"), json: { tiers: states } };
}

/** `jev-browser setup stop <tier>` — stop the process this pid file names, and nothing else. */
async function stopTier({ tier: name, home, skillDir, log }) {
  const tier = tierByName(name);
  if (!tier || !SETUP_TIERS.includes(name)) throw configError(`unknown tier "${name}" (expected ${SETUP_TIERS.join(", ")})`);
  const paths = runPaths(home, pidName(name), tier.port);
  const pid = await readPid(paths.pidFile);
  if (!pid) {
    return {
      code: 0,
      text: `nothing to stop: no pid file at ${paths.pidFile}\n${name} was not started by setup (or it already exited); a server you started by hand is stopped with Ctrl-C.`,
      json: { tier: name, stopped: false, reason: "no pid file", pidFile: paths.pidFile },
    };
  }
  const live = await pidState(pid, path.basename(launcherPath(name, skillDir)));
  if (!live.alive) {
    await fs.rm(paths.pidFile, { force: true });
    return { code: 0, text: `removed a stale pid file: pid ${pid} is gone (${paths.pidFile})`, json: { tier: name, stopped: false, reason: "stale pid file", pid } };
  }
  if (!live.ours) {
    return {
      code: 1,
      text: `pid ${pid} is not a ${name} launcher (${live.command}); leaving it alone.\nDelete ${paths.pidFile} if that file is stale.`,
      json: { tier: name, stopped: false, reason: "pid is not ours", pid, command: live.command },
    };
  }
  log(`stopping ${name} (pid ${pid})…`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return { code: 1, text: `could not signal pid ${pid}: ${error.message}`, json: { tier: name, stopped: false, pid, error: error.message } };
  }
  const gone = await waitUntilReady(async () => !(await pidState(pid)).alive, { timeoutMs: 15_000, intervalMs: 250 });
  if (!gone) return { code: 1, text: `sent SIGTERM to pid ${pid} but it is still running after 15s — see ${paths.logFile}`, json: { tier: name, stopped: false, pid, logFile: paths.logFile } };
  await fs.rm(paths.pidFile, { force: true });
  return { code: 0, text: `stopped ${name} (pid ${pid}).\nlog: ${paths.logFile}`, json: { tier: name, stopped: true, pid, logFile: paths.logFile } };
}

/** A failed child: exit 2 stays a usage/config problem, anything else is a runtime failure. */
function stepFailure(what, code, logFile) {
  const message = `${what} failed (exit ${code})${logFile ? `; log: ${logFile}` : ""}`;
  return code === 2 ? configError(message) : new Error(message);
}

/** Write baseUrl+apiKey, then prove the endpoint answers. Shared by both tiers. */
async function finishTier({ tier, home, skillDir, deps, paths, started, model, log }) {
  const configFile = await saveUserConfig({ baseUrl: tier.baseUrl, apiKey: tier.apiKey }, { home });
  const verified = await deps.verify({ baseUrl: tier.baseUrl, apiKey: tier.apiKey, model }).catch((error) => {
    throw new Error(`the endpoint is up but did not answer the verification question: ${error.message}\nlog: ${paths.logFile}`);
  });
  const pid = await readPid(paths.pidFile);
  log(`verified ${tier.baseUrl}: ${verified.detail} in ${verified.ms} ms`);
  const lines = [
    `jev-browser setup ${tier.name}`,
    "",
    `  server          127.0.0.1:${tier.port}${pid ? ` (pid ${pid})` : ""}`,
    `  config          ${configFile} — baseUrl + apiKey=${tier.apiKey}`,
    `  log             ${paths.logFile}`,
    `  verified        ${verified.detail} — ${verified.ms} ms through ${tier.baseUrl}`,
    "",
    `A run right now uses the ${tier.name} tier:`,
    "",
    `  node ${path.join(skillDir, "bin", "jev-browser.mjs")} run --goal "…" --url https://example.com`,
    "",
    `stop it with: jev-browser setup stop ${tier.name}`,
  ];
  return {
    code: 0,
    text: lines.join("\n"),
    json: {
      tier: tier.name,
      baseUrl: tier.baseUrl,
      apiKey: tier.apiKey,
      port: tier.port,
      pid,
      pidFile: paths.pidFile,
      logFile: paths.logFile,
      configFile,
      verified: { detail: verified.detail, ms: verified.ms, answer: verified.answer, model: verified.model },
    },
  };
}

/** `jev-browser setup local-readout` — llama.cpp check, unattended fetch, detached serve, verify. */
async function setupLocalReadout({ tier, home, skillDir, env, deps, options, log }) {
  let entry;
  try {
    entry = options.modelName ? localModel(options.modelName) : defaultLocalModel();
  } catch (error) {
    throw error?.name === "LocalModelRegistryError" ? configError(error.message) : error;
  }
  const llama = deps.findLlamaServer();
  if (!llama) throw configError(llamaMissingHint({ env }));

  const launcher = launcherPath(tier.name, skillDir);
  const paths = runPaths(home, pidName(tier.name), tier.port);
  const { modelFile } = localPaths(home, entry);
  const stat = await statOrNull(modelFile);
  const onDisk = stat?.size ?? 0;
  const ready = onDisk > 0 && onDisk === entry.bytes;
  log(`[setup] llama.cpp: ${llama}`);
  log(
    `[setup] model ${entry.id}: ${
      ready ? `already on disk (${humanBytes(onDisk)})` : onDisk === 0 ? `not downloaded (${humanBytes(entry.bytes)})` : `truncated (${onDisk} of ${entry.bytes} bytes)`
    }`,
  );

  if (!ready) {
    const fetch = await deps.runStep({ command: process.execPath, args: [launcher, "--download-only", "--model-name", entry.id], env: { ...env, HOME: home }, cwd: skillDir, log });
    if (fetch.code !== 0) throw stepFailure(`fetching ${entry.id}`, fetch.code, paths.logFile);
  }

  const started = await deps.startDetached({ script: launcher, args: ["--detach", "--model-name", entry.id], env: { ...env, HOME: home }, cwd: skillDir, timeoutMs: options.timeoutMs ?? 300_000 });
  if (started.code !== 0) throw stepFailure("starting jev-local", started.code, paths.logFile);
  log(`[setup] serving on 127.0.0.1:${tier.port} (${started.stdout || "env line printed"})`);

  const out = await finishTier({ tier, home, skillDir, deps, paths, started, model: options.config?.model, log });
  out.json.model = { id: entry.id, file: entry.file, bytes: entry.bytes, url: entry.url };
  return out;
}

/** `jev-browser setup kev` — uv check, clone + uv sync (unless --skip-deps), fetch, serve, verify. */
async function setupKev({ tier, home, skillDir, env, deps, options, log }) {
  const launcher = launcherPath(tier.name, skillDir);
  const paths = runPaths(home, pidName(tier.name), tier.port);
  const clone = kevClone(home);

  if (!options.skipDeps) {
    const uv = await deps.findUv();
    if (!uv) throw configError(`uv not found on PATH — ${KEV_UV_HINT}\n\nKev's venv is built with uv:\n\n  ${kevSetupCommands(clone).join("\n  ")}`);
    log(`[setup] ${uv.version}`);
    if (!(await exists(clone))) {
      const step = await deps.runStep({ command: "git", args: ["clone", "--depth", "1", "https://github.com/jaredpalmer/kev.git", clone], env, cwd: home, log });
      if (step.code !== 0) throw stepFailure("cloning the Kev checkout", step.code);
    }
    const sync = await deps.runStep({ command: uv.path, args: ["sync", "--extra", "serve", "--project", clone], env, cwd: home, log });
    if (sync.code !== 0) throw stepFailure("uv sync --extra serve", sync.code);
  }

  const runtime = await deps.kevRuntime({ clone });
  if (!runtime.ok) throw configError(`${runtime.detail}\n\nPrepare it with:\n\n  ${kevSetupCommands(clone).join("\n  ")}\n\n(${KEV_UV_HINT})`);
  log(`[setup] ${runtime.detail}`);

  const fetch = await deps.runStep({ command: process.execPath, args: [launcher, "--download-only", "--clone", clone], env: { ...env, HOME: home }, cwd: skillDir, log });
  if (fetch.code !== 0) throw stepFailure("fetching the Kev checkpoint", fetch.code, paths.logFile);

  const started = await deps.startDetached({ script: launcher, args: ["--detach", "--clone", clone], env: { ...env, HOME: home }, cwd: skillDir, timeoutMs: options.timeoutMs ?? 900_000 });
  if (started.code !== 0) throw stepFailure("starting jev-kev", started.code, paths.logFile);
  log(`[setup] serving on 127.0.0.1:${tier.port} (${started.stdout || "env line printed"})`);

  const out = await finishTier({ tier, home, skillDir, deps, paths, started, model: options.config?.model, log });
  out.json.clone = clone;
  return out;
}

/**
 * The `setup` command. Throws a `config: true` error for anything the user has to change (exit 2),
 * a plain error for a runtime failure (exit 1), and returns `{ code, text, json }` otherwise.
 */
export async function setupCommand({ sub, rest = [], options = {}, deps = {} } = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const skillDir = options.skillDir ?? SKILL_DIR;
  const log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  const seams = { ...defaultDeps(env), ...deps };

  if (sub === undefined) {
    if (!options.config) throw configError(`${SETUP_USAGE} (setup needs the effective configuration, which only the CLI loads)`);
    return overview({ home, config: options.config, skillDir, deps: seams });
  }
  if (sub === "status") return statusReport({ home, skillDir, deps: seams });
  if (sub === "stop") return stopTier({ tier: rest[0], home, skillDir, log });
  if (sub === DEFAULT_TIER) {
    return {
      code: 0,
      text: `hosted Jev needs no setup — it is the default.\n\n  export TYPESAFE_API_KEY=...    # https://console.typesafe.ai\n  node ${path.join(skillDir, "bin", "jev-browser.mjs")} doctor\n\nA local tier is optional: jev-browser setup ${SETUP_TIERS.join(" | ")}`,
      json: { tier: DEFAULT_TIER, needsSetup: false },
    };
  }
  const tier = SETUP_TIERS.includes(sub) ? tierByName(sub) : null;
  if (!tier) throw configError(`unknown setup target "${sub}"\n${SETUP_USAGE}`);
  if (options.modelName && sub !== "local-readout") throw configError("--model-name applies to `setup local-readout` (Kev serves its pinned checkpoint)");
  if (options.skipDeps && sub !== "kev") throw configError("--skip-deps applies to `setup kev`");
  return sub === "kev" ? setupKev({ tier, home, skillDir, env, deps: seams, options, log }) : setupLocalReadout({ tier, home, skillDir, env, deps: seams, options, log });
}
