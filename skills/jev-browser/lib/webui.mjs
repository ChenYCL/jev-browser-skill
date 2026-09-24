// The local WebUI: a loopback-only page over the same lib/ every CLI command uses.
//
// Every panel is an adapter, never a second implementation: the tiers and the resolved goal_done
// bar come from lib/tiers.mjs (describeTier + probeEndpoint), health from lib/doctor.mjs, config
// reads and writes from lib/config.mjs, the model registry from lib/local.mjs. That is why the page
// can never disagree with `jev-browser tier status`, `doctor` or `config show`.
//
// A local tool that spawns processes on request is the one genuinely dangerous part of a WebUI, so
// every field is treated as hostile input: the scripts come from this module's own bin/ (never from
// a request body), arguments are validated and enumerated (tier from TIERS, model from the
// registry, paths under one root, ports as integers in range), and children are spawned with an
// argv array — never a shell, so no value can be re-parsed into a command.
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULTS, PROFILE_NAMES, THRESHOLD_PROFILES, describeConfig, loadConfig, saveUserConfig, unsetUserConfig } from "./config.mjs";
import { DEFAULT_TIER, TIERS, describeTier, fetchModels, formatTierStatus, formatTierUse, launcherCommand, probeEndpoint, tierByName, tierEnv, tierRows } from "./tiers.mjs";
import { doctor, formatDoctor } from "./doctor.mjs";
import { TypeSafeClient, isLoopbackBaseUrl, validateQuestions } from "./typesafe.mjs";
import { expandHome, readJson } from "./util.mjs";
import { WEBUI_PAGE } from "./webui-page.mjs";

/** The only address this server ever binds. */
export const LOOPBACK = "127.0.0.1";
export const DEFAULT_WEBUI_PORT = 8765;

/** The skill directory this module belongs to; every script the WebUI spawns is resolved under it. */
const MODULE_SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The channels a client may read logs from. Anything else is a 400, not a file read. */
export const LOG_CHANNELS = Object.freeze(["run", ...TIERS.filter((tier) => tier.launcher).map((tier) => `tier:${tier.name}`)]);

/**
 * The route table, as data: the dispatcher and the 405 answer are both built from it, so the
 * documented list and the served list cannot drift apart.
 */
export const ROUTES = Object.freeze([
  { method: "GET", path: "/", purpose: "the page itself (static, no config in it)" },
  { method: "GET", path: "/api/tiers", purpose: "the three tiers + the live tier/endpoint/bar a run would use" },
  { method: "POST", path: "/api/tiers/start", purpose: "start a local tier's launcher (argv array, pinned script)" },
  { method: "POST", path: "/api/tiers/stop", purpose: "stop the launcher this server started (whole process group)" },
  { method: "GET", path: "/api/tiers/use", purpose: "what `tier use` prints, without writing anything" },
  { method: "POST", path: "/api/tiers/use", purpose: "store that tier's baseUrl in the user config (explicit write)" },
  { method: "GET", path: "/api/logs", purpose: "buffered stdout/stderr of a child, from a cursor" },
  { method: "GET", path: "/api/config", purpose: "effective config (key value never sent) + sources + user-set keys" },
  { method: "POST", path: "/api/config", purpose: "save an allow-listed patch through lib/config.mjs" },
  { method: "POST", path: "/api/config/unset", purpose: "remove one key from the user config" },
  { method: "GET", path: "/api/doctor", purpose: "lib/doctor.mjs, live or offline" },
  { method: "GET", path: "/api/models", purpose: "the local registry, what is on disk, what is serving" },
  { method: "POST", path: "/api/models/start", purpose: "start the GGUF launcher for a chosen registry id or file" },
  { method: "POST", path: "/api/judge", purpose: "one TypeSafe System One call against the effective endpoint" },
  { method: "POST", path: "/api/run", purpose: "spawn `jev-browser run --json` (argv array, never a shell)" },
  { method: "GET", path: "/api/run", purpose: "the last run's state, result JSON and journal rows" },
  { method: "POST", path: "/api/run/stop", purpose: "kill the run child" },
]);

const MAX_LOG_LINES = 500;
const MAX_BODY_BYTES = 1 << 20;
const MAX_CHILD_OUTPUT = 2 << 20;

/** A usage/config problem the user has to fix: 4xx, with the message shown as-is. */
export class WebUiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "WebUiError";
    this.status = status;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** True when `child` is `parent` or lives inside it (after both are resolved). */
const isWithin = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);

/**
 * ~/.jev-browser/models — the one directory a `--model <path>` may name. It is the same directory
 * lib/local.mjs's localPaths() builds, kept as an expression here so validation needs no registry
 * import (a half-edited local-models.json must not be able to widen it).
 */
export const modelRoot = (home = os.homedir()) => path.join(home, ".jev-browser", "models");

// ----------------------------------------------------------------------------- validation

export function parsePort(raw, { name = "port", min = 1024, max = 65535 } = {}) {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (!Number.isInteger(value)) throw new WebUiError(`${name} must be a whole number (got ${JSON.stringify(raw)})`);
  if (value < min || value > max) throw new WebUiError(`${name} must be between ${min} and ${max} (got ${value})`);
  return value;
}

export function requireNumber(raw, name, { min, max, integer = false } = {}) {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new WebUiError(`${name} must be a number (got ${JSON.stringify(raw)})`);
  if (integer && !Number.isInteger(value)) throw new WebUiError(`${name} must be a whole number (got ${value})`);
  if (min !== undefined && value < min) throw new WebUiError(`${name} must be at least ${min} (got ${value})`);
  if (max !== undefined && value > max) throw new WebUiError(`${name} must be at most ${max} (got ${value})`);
  return value;
}

export function requireChoice(raw, name, options) {
  if (typeof raw !== "string" || !options.includes(raw)) throw new WebUiError(`${name} must be one of ${options.join(", ")} (got ${JSON.stringify(raw)})`);
  return raw;
}

export function requireText(raw, name, maxChars) {
  if (typeof raw !== "string" || !raw.trim()) throw new WebUiError(`${name} is required`);
  if (raw.length > maxChars) throw new WebUiError(`${name} is longer than ${maxChars} characters`);
  return raw.trim();
}

export function requireUrl(raw, name = "url") {
  const value = requireText(raw, name, 4000);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new WebUiError(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new WebUiError(`${name} must be an http(s) URL`);
  return value;
}

export function requireToken(raw, name) {
  const value = requireText(raw, name, 128);
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) throw new WebUiError(`${name} must be letters, digits, ".", ":", "_" or "-" (got ${JSON.stringify(value)})`);
  return value;
}

export function requireApiKey(raw) {
  const value = requireText(raw, "apiKey", 512);
  if (/[\r\n]/.test(value)) throw new WebUiError("apiKey must be a single line");
  return value;
}

/** One tier of TIERS, or a 400 naming the ones that exist. */
export function requireTier(raw) {
  const tier = tierByName(raw);
  if (!tier) throw new WebUiError(`unknown tier ${JSON.stringify(raw)} (expected ${TIERS.map((tier) => tier.name).join(", ")})`);
  return tier;
}

/** A registry id, checked against the registry itself rather than a hard-coded list. */
export function requireModelId(raw, registry) {
  const id = requireToken(raw, "modelName");
  if (!registry?.models?.[id]) {
    throw new WebUiError(`unknown model id ${JSON.stringify(id)} (the registry has ${Object.keys(registry?.models ?? {}).join(", ") || "no models"})`);
  }
  return id;
}

/**
 * A `--model <path>` value: a .gguf file inside MODEL_ROOTS. Anything else — a relative path, a
 * symlink target outside the root, a shell-ish string — is rejected before a process exists.
 */
export function resolveModelPath(raw, { home = os.homedir() } = {}) {
  const value = requireText(raw, "modelPath", 4096);
  if (!value.endsWith(".gguf")) throw new WebUiError("modelPath must name a .gguf file");
  const resolved = path.resolve(expandHome(value, home));
  const root = modelRoot(home);
  if (!isWithin(resolved, root)) throw new WebUiError(`modelPath must be under ${root}`);
  return resolved;
}

/** Request key=value rows: an array of {key, value}, as `--input` / `--secret` see them. */
export function requirePairs(raw, name) {
  if (raw === undefined || raw === null) return {};
  const list = Array.isArray(raw) ? raw : isPlainObject(raw) ? Object.entries(raw).map(([key, value]) => ({ key, value })) : null;
  if (!list) throw new WebUiError(`${name} must be an array of { key, value } rows`);
  const out = {};
  for (const row of list) {
    if (!isPlainObject(row)) throw new WebUiError(`${name} rows must be objects with key and value`);
    const { key, value } = row;
    if (key === undefined || key === "" || value === undefined || value === null || value === "") continue; // an empty row is not an error
    if (typeof key !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(key)) throw new WebUiError(`${name} key ${JSON.stringify(key)} must match [A-Za-z0-9_.-]{1,64}`);
    if (typeof value !== "string") throw new WebUiError(`${name}.${key} must be a string`);
    if (value.length > 2000) throw new WebUiError(`${name}.${key} is longer than 2000 characters`);
    out[key] = value;
  }
  return out;
}

/** A path like "a.b.c" must not be able to reach Object.prototype. */
function assertSafeKeyPath(key) {
  for (const part of key.split(".")) {
    if (part === "__proto__" || part === "constructor" || part === "prototype") throw new WebUiError(`config key ${JSON.stringify(key)} is not allowed`);
  }
}

/**
 * The config keys the WebUI may write, each with its own validator. Everything else is refused, so
 * a request cannot reach a config field the panel does not show (chrome.extraArgs, say).
 */
export const EDITABLE_KEYS = Object.freeze({
  baseUrl: (value) => requireUrl(value, "baseUrl"),
  model: (value) => requireToken(value, "model"),
  backend: (value) => requireChoice(value, "backend", ["ego", "chrome", "safari"]),
  maxSteps: (value) => requireNumber(value, "maxSteps", { min: 1, max: 1000, integer: true }),
  budgetUsd: (value) => requireNumber(value, "budgetUsd", { min: 0.0001, max: 1000 }),
  "thresholds.profile": (value) => requireChoice(value, "thresholds.profile", PROFILE_NAMES),
  "thresholds.goalDone": (value) => requireNumber(value, "thresholds.goalDone", { min: 0, max: 1 }),
  "thresholds.goalDoneFinal": (value) => requireNumber(value, "thresholds.goalDoneFinal", { min: 0, max: 1 }),
});

/** "a.b" -> {a:{b:value}}, refusing prototype paths first. */
export function nestPatch(flat) {
  const out = {};
  for (const [key, value] of Object.entries(flat)) {
    assertSafeKeyPath(key);
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = value;
  }
  return out;
}

/** Validate a {dotted.path: value} patch; empty strings mean "leave this field alone". */
export function normalizePatch(raw) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw new WebUiError("patch must be an object keyed by config path");
  const flat = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(EDITABLE_KEYS, key)) {
      throw new WebUiError(`config key ${JSON.stringify(key)} is not editable from the WebUI (editable: ${Object.keys(EDITABLE_KEYS).join(", ")})`);
    }
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) continue;
    flat[key] = EDITABLE_KEYS[key](value);
  }
  return nestPatch(flat);
}

// ----------------------------------------------------------------------------- config views

/** Flatten a nested config into {dotted.path: leaf}; arrays and nulls are leaves. */
export function flattenConfig(node, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(isPlainObject(node) ? node : {})) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) flattenConfig(value, p, out);
    else out[p] = value;
  }
  return out;
}

/** The config a browser may see: describeConfig's shape, with the key reduced to "is one set". */
export function viewConfig(config) {
  const view = describeConfig(config);
  view.apiKey = config.apiKey ? "(set)" : null;
  return view;
}

/** Every leaf that differs between two views — what "the resulting diff" means. */
export function diffConfig(before, after) {
  const a = flattenConfig(before);
  const b = flattenConfig(after);
  const out = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (JSON.stringify(a[key] ?? null) === JSON.stringify(b[key] ?? null)) continue;
    out.push({ path: key, from: a[key] ?? null, to: b[key] ?? null });
  }
  return out;
}

/**
 * A scrubber for anything that leaves the server. The API key and every secret typed into the Run
 * panel are replaced wherever they appear — including inside a child's output or an error message
 * that echoed a request — so "no route returns the key" holds for every response, not just the
 * config one.
 */
export function makeScrubber(values = []) {
  const needles = [...new Set(values.filter((value) => typeof value === "string" && value.length >= 3))];
  if (!needles.length) return (text) => text;
  return (text) => {
    let out = String(text);
    for (const needle of needles) out = out.split(needle).join("‹redacted›");
    return out;
  };
}

// ----------------------------------------------------------------------------- http plumbing

export function assertLoopbackHost(host) {
  if (host !== LOOPBACK && host !== "localhost" && host !== "::1") {
    throw new WebUiError(`refusing to bind ${host}: this WebUI is loopback-only (${LOOPBACK})`, 500);
  }
  return host;
}

/** Bind the server, refusing anything but a loopback host. `port: 0` picks a free port. */
export async function listenWebUi(server, { port = DEFAULT_WEBUI_PORT, host = LOOPBACK } = {}) {
  assertLoopbackHost(host);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return server.address();
}

/** Best-effort: open the printed URL. Never throws, never blocks. */
export function openBrowser(url, { spawn = nodeSpawn } = {}) {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

function sendJson(res, status, body, scrub = (text) => text) {
  const text = scrub(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

function sendHtml(res, html) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html), "cache-control": "no-store" });
  res.end(html);
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
      req.destroy();
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) return fail(new WebUiError(`request body larger than ${limit} bytes`, 413));
      chunks.push(chunk);
    });
    req.on("error", (error) => fail(new WebUiError(`request failed: ${error.message}`)));
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return reject(new WebUiError(`request body must be JSON (${error.message})`));
      }
      if (!isPlainObject(parsed)) return reject(new WebUiError("request body must be a JSON object"));
      resolve(parsed);
    });
  });
}

/** The CLI's `parseMaybeJson`: JSON when it parses, the raw string when it does not. */
function parseMaybeJson(text) {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ----------------------------------------------------------------------------- the server

/**
 * Build the server without starting it.
 *
 * @param {object} [options]
 * @param {string} [options.skillDir]   the skill root the spawned scripts are resolved under
 * @param {string} [options.home]       the HOME whose config file is read and written
 * @param {object} [options.env]        environment for loadConfig and for every child
 * @param {string} [options.cwd]        working directory for every child
 * @param {Function} [options.spawn]    child_process.spawn, injectable so tests can assert argv
 * @param {boolean} [options.detached]  put children in their own process group (see killGroup)
 * @param {(message: string) => void} [options.log]
 */
export function createWebUiServer({ skillDir = MODULE_SKILL_DIR, home = os.homedir(), env = process.env, cwd = process.cwd(), spawn = nodeSpawn, detached = spawn === nodeSpawn, log = () => {} } = {}) {
  const channels = new Map(); // name -> { cursor, lines, partial }
  const children = new Map(); // name -> record
  const spawned = []; // { name, script, args } — what this server actually launched
  const redactions = new Set(); // values that must never reach the browser
  let redactionsAt = 0;

  /**
   * The literal key a local tier's launcher prints (`TYPESAFE_API_KEY=local`) is not a secret: it is
   * a constant the launchers publish on stdout and it also sits inside every local tier name, so
   * putting it in the redaction set would rewrite half the page. Any other configured key goes in,
   * whatever it looks like.
   */
  const LOCAL_API_KEY = "local";
  function addApiKeyRedaction(apiKey) {
    if (typeof apiKey === "string" && apiKey && apiKey !== LOCAL_API_KEY) redactions.add(apiKey);
  }

  // ---------------------------------------------------------------- log buffers

  function channelFor(name) {
    let channel = channels.get(name);
    if (!channel) {
      channel = { cursor: 0, lines: [], partial: { stdout: "", stderr: "" } };
      channels.set(name, channel);
    }
    return channel;
  }

  function appendLine(name, stream, text) {
    const channel = channelFor(name);
    channel.lines.push({ i: ++channel.cursor, stream, text });
    if (channel.lines.length > MAX_LOG_LINES) channel.lines.splice(0, channel.lines.length - MAX_LOG_LINES);
    log(text);
  }

  function writeChunk(name, stream, chunk) {
    const channel = channelFor(name);
    const text = channel.partial[stream] + chunk.toString("utf8");
    const parts = text.split(/\r?\n/);
    channel.partial[stream] = parts.pop() ?? "";
    for (const part of parts) if (part !== "") appendLine(name, stream, part);
  }

  function flushChannel(name) {
    const channel = channelFor(name);
    for (const stream of ["stdout", "stderr"]) {
      const rest = channel.partial[stream];
      channel.partial[stream] = "";
      if (rest) appendLine(name, stream, rest);
    }
  }

  // ---------------------------------------------------------------- children

  const cap = (text) => (text.length > MAX_CHILD_OUTPUT ? text.slice(-MAX_CHILD_OUTPUT) : text);

  /**
   * Kill a child and everything it started. The launchers spawn llama-server / the MLX server
   * themselves, so a signal to the launcher alone would orphan the model server: children run
   * detached (their own process group) and the whole group is signalled instead.
   */
  function killTree(record, signal) {
    const child = record?.child;
    if (!child || typeof child.kill !== "function") return;
    if (record.detached && Number.isInteger(child.pid) && child.pid > 1) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // no such group (already gone, or a platform without them) — fall back to the child
      }
    }
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }

  function isRunning(name) {
    return Boolean(children.get(name)?.running);
  }

  function startChild(name, script, args, extra = {}) {
    if (!isWithin(script, skillDir)) throw new WebUiError(`refusing to run ${script}: outside the skill directory`, 500);
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached });
    const record = { name, script, args, child, pid: child.pid ?? null, startedAt: Date.now(), running: true, ready: false, exitCode: null, signal: null, error: null, detached, stdout: "", stdoutToLog: true, ...extra };
    children.set(name, record);
    spawned.push({ name, script, args: [...args] });
    if (spawned.length > 100) spawned.shift();
    child.stdout?.on("data", (chunk) => {
      record.stdout = cap(record.stdout + chunk.toString("utf8"));
      // The run child's stdout is its JSON result, which the panel renders separately; only a
      // launcher's stdout (its download progress and env line) belongs in the log pane.
      if (record.stdoutToLog) writeChunk(name, "stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => writeChunk(name, "stderr", chunk));
    child.on?.("error", (error) => {
      record.error = error.message;
      record.running = false;
      record.ready = true;
      appendLine(name, "stderr", `spawn failed: ${error.message}`);
    });
    child.on?.("close", (code, signal) => {
      record.exitCode = code;
      record.signal = signal ?? null;
      record.running = false;
      flushChannel(name);
      appendLine(name, "stderr", `[exited: code=${code === null ? "?" : code} signal=${signal ?? "none"}]`);
      void afterExit(record);
    });
    return record;
  }

  /** The run channel parses its result and journal once the child is gone. */
  async function afterExit(record) {
    if (record.name === "run") {
      const text = record.stdout.trim();
      if (text) {
        try {
          record.result = JSON.parse(text.slice(text.indexOf("{")));
        } catch (error) {
          record.resultError = `could not parse the run result: ${error.message}`;
        }
      } else if (!record.error) {
        record.resultError = `the run wrote nothing to stdout (exit code ${record.exitCode})`;
      }
      record.journal = await readJournal(record.journalDir);
    }
    record.ready = true;
  }

  /**
   * The run journal under the temp directory: `<base>/<runId>/{run.json,steps.jsonl}`. Compacted to
   * the row the panel prints (goal_done / action / choice per step), never the whole state.
   */
  async function readJournal(baseDir) {
    if (!baseDir) return null;
    const entries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(baseDir, entry.name)).sort();
    const dir = dirs.at(-1);
    if (!dir) return { dir: baseDir, run: null, rows: [], error: `no journal was written under ${baseDir}` };
    const run = await readJson(path.join(dir, "run.json"), null);
    const steps = await fs.readFile(path.join(dir, "steps.jsonl"), "utf8").catch(() => "");
    const rows = [];
    for (const line of steps.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      rows.push({
        step: row.step,
        url: row.url ?? null,
        title: row.title ?? null,
        goalDone: row.goalDone ?? row.answers?.goal_done?.noul ?? null,
        blocker: row.blocker ?? row.answers?.blocker?.top ?? null,
        action: row.chosen?.kind ?? null,
        label: row.chosen?.label ?? null,
        changed: row.changed ?? null,
        finalCheck: Boolean(row.finalCheck),
      });
    }
    return { dir, run, rows };
  }

  // ---------------------------------------------------------------- config + scrub

  async function currentConfig({ refreshRedactions = true } = {}) {
    let loaded;
    try {
      loaded = await loadConfig({ env, cwd, home });
    } catch (error) {
      throw new WebUiError(error.message, 400);
    }
    if (refreshRedactions) addApiKeyRedaction(loaded.config.apiKey);
    return loaded;
  }

  /**
   * Refresh the redaction set at most once a second: the key can change under us (the Config panel
   * writes it) and every response must already know it, but a log poll should not re-read config
   * three times a second.
   */
  async function refreshRedactions(force = false) {
    if (!force && Date.now() - redactionsAt < 1000) return;
    redactionsAt = Date.now();
    try {
      const { config } = await loadConfig({ env, cwd, home });
      addApiKeyRedaction(config.apiKey);
    } catch {
      // a broken config is reported by the route that needs it
    }
  }

  /** The scrubber for the current request: the key plus every secret typed into the Run panel. */
  const scrubber = () => makeScrubber([...redactions]);

  // ---------------------------------------------------------------- api handlers

  async function apiTiers() {
    const { config } = await currentConfig();
    const models = await fetchModels({ config });
    const classification = await probeEndpoint({ config, models });
    const status = describeTier({ config, classification, skillDir });
    return {
      defaultTier: DEFAULT_TIER,
      tiers: tierRows({ skillDir }),
      status,
      statusText: formatTierStatus(status),
      classification,
      baseUrl: config.baseUrl,
      keySet: Boolean(config.apiKey),
      local: TIERS.filter((tier) => tier.launcher).map((tier) => {
        const record = children.get(`tier:${tier.name}`);
        return {
          tier: tier.name,
          port: tier.port,
          command: launcherCommand(tier, skillDir),
          env: tierEnv(tier),
          running: Boolean(record?.running),
          startedAt: record?.startedAt ?? null,
          exitCode: record?.exitCode ?? null,
        };
      }),
    };
  }

  async function loadRegistry() {
    try {
      const { loadLocalModels } = await import("./local.mjs");
      return loadLocalModels();
    } catch (error) {
      throw new WebUiError(`the local model registry could not be read: ${error.message}`, 500);
    }
  }

  /** Shared by /api/tiers/start and /api/models/start: start bin/jev-local.mjs with validated args. */
  async function startLocalTier(tier, body) {
    if (!tier.launcher) throw new WebUiError(`${tier.name} has no local server to start — it is a hosted service`);
    const name = `tier:${tier.name}`;
    if (isRunning(name)) throw new WebUiError(`${tier.name} is already running (started by this WebUI) — stop it first`, 409);
    const port = body.port === undefined || body.port === "" ? tier.port : parsePort(body.port, { name: "port" });
    const args = ["--port", String(port)];
    if (tier.name !== "local-readout") {
      if (body.modelName || body.modelPath) throw new WebUiError(`${tier.name} serves its own checkpoint: modelName/modelPath apply to jev-local only`);
    } else {
      if (body.llamaPort !== undefined && body.llamaPort !== "") args.push("--llama-port", String(parsePort(body.llamaPort, { name: "llamaPort" })));
      if (body.modelName) args.push("--model-name", requireModelId(body.modelName, await loadRegistry()));
      if (body.modelPath) {
        const file = resolveModelPath(body.modelPath, { home });
        const stat = await fs.stat(file).catch(() => null);
        if (!stat?.isFile()) throw new WebUiError(`no such model file: ${file} (only ${modelRoot(home)} may be named)`, 404);
        args.push("--model", file);
      }
    }
    const script = path.join(skillDir, tier.launcher);
    const record = startChild(name, script, args);
    return { tier: tier.name, channel: name, pid: record.pid, port, command: `node ${script} ${args.join(" ")}` };
  }

  async function apiTiersStart(body) {
    return startLocalTier(requireTier(body.tier), body);
  }

  async function apiTiersStop(body) {
    const tier = requireTier(body.tier);
    const name = `tier:${tier.name}`;
    const record = children.get(name);
    if (!record || !record.running) throw new WebUiError(`${tier.name} is not running (only a launcher this WebUI started can be stopped here)`, 409);
    killTree(record, "SIGTERM");
    return { tier: tier.name, stopped: true, pid: record.pid };
  }

  /** `tier use` as data, plus the canonical export line for that tier. */
  function apiTierUse(url) {
    const tier = requireTier(url.searchParams.get("tier"));
    const rows = tierRows({ skillDir });
    return {
      tier: tier.name,
      text: formatTierUse(tier, { skillDir, configPath: path.join(home, ".config", "jev-browser", "config.json") }),
      env: tierEnv(tier),
      command: launcherCommand(tier, skillDir),
      baseUrl: tier.baseUrl,
      port: tier.port,
      apiKey: tier.apiKey,
      row: rows.find((row) => row.tier === tier.name) ?? null,
    };
  }

  /** The explicit write behind the "save baseUrl" button — the only config write this route does. */
  async function apiTierUsePersist(body) {
    const tier = requireTier(body.tier);
    const port = body.port === undefined || body.port === "" ? tier.port : parsePort(body.port, { name: "port" });
    const baseUrl = tier.port && port !== tier.port ? `http://${LOOPBACK}:${port}` : tier.baseUrl;
    // A local tier is only half configured by baseUrl: its key is the literal placeholder the client
    // requires and the server ignores, so — exactly like `tier use --persist` — both are stored.
    const file = await saveUserConfig({ baseUrl, ...(tier.apiKey ? { apiKey: tier.apiKey } : {}) }, { home });
    const { config } = await currentConfig({ refreshRedactions: false });
    addApiKeyRedaction(config.apiKey);
    return { tier: tier.name, baseUrl, apiKey: tier.apiKey ?? null, persisted: file, text: formatTierUse(tier, { skillDir, persisted: file, configPath: file }), config: viewConfig(config) };
  }

  function apiLogs(url) {
    const channel = url.searchParams.get("channel") ?? "";
    if (!LOG_CHANNELS.includes(channel)) throw new WebUiError(`unknown log channel ${JSON.stringify(channel)} (expected ${LOG_CHANNELS.join(", ")})`);
    const since = Number(url.searchParams.get("since") ?? 0);
    if (!Number.isFinite(since) || since < 0) throw new WebUiError("since must be a non-negative number");
    const buffer = channelFor(channel);
    const record = children.get(channel);
    return {
      channel,
      lines: buffer.lines.filter((line) => line.i > since),
      next: buffer.cursor,
      running: Boolean(record?.running),
      ready: record ? record.ready : false,
      exitCode: record?.exitCode ?? null,
    };
  }

  async function apiConfigGet() {
    const { config, sources, paths } = await currentConfig();
    const userFile = await readJson(paths.userFile, null);
    return {
      config: viewConfig(config),
      keySet: Boolean(config.apiKey),
      sources,
      paths,
      userSetKeys: Object.keys(flattenConfig(userFile)),
      editable: Object.keys(EDITABLE_KEYS),
      profiles: PROFILE_NAMES,
      thresholds: THRESHOLD_PROFILES,
      backends: ["ego", "chrome", "safari"],
      defaults: {
        baseUrl: DEFAULTS.baseUrl,
        model: DEFAULTS.model,
        backend: DEFAULTS.backend,
        maxSteps: DEFAULTS.maxSteps,
        budgetUsd: DEFAULTS.budgetUsd,
        profile: DEFAULTS.thresholds.profile,
      },
    };
  }

  async function apiConfigPost(body) {
    const before = viewConfig((await currentConfig()).config);
    const patch = normalizePatch(body.patch);
    if (body.apiKey !== undefined && body.apiKey !== null && String(body.apiKey).trim() !== "") patch.apiKey = requireApiKey(String(body.apiKey));
    const saved = Object.keys(flattenConfig(patch));
    if (!saved.length) throw new WebUiError("nothing to save: send a patch (and/or apiKey) with at least one value");
    const file = await saveUserConfig(patch, { home });
    const after = viewConfig((await currentConfig()).config);
    return { saved, file, config: after, keySet: Boolean(after.apiKey), diff: diffConfig(before, after) };
  }

  async function apiConfigUnset(body) {
    const key = requireText(body.key, "key", 128);
    if (!Object.hasOwn(EDITABLE_KEYS, key) && key !== "apiKey") {
      throw new WebUiError(`config key ${JSON.stringify(key)} is not editable from the WebUI (editable: ${[...Object.keys(EDITABLE_KEYS), "apiKey"].join(", ")})`);
    }
    const before = viewConfig((await currentConfig()).config);
    const file = await unsetUserConfig(key, { home });
    const after = viewConfig((await currentConfig()).config);
    return { removed: key, file, config: after, keySet: Boolean(after.apiKey), diff: diffConfig(before, after) };
  }

  async function apiDoctor(url) {
    const { config, sources } = await currentConfig();
    const live = url.searchParams.get("live") !== "0";
    const report = await doctor({ config, sources, skillDir, home, live });
    return { report, text: formatDoctor(report) };
  }

  async function apiModels() {
    const root = modelRoot(home);
    let registry = null;
    let registryError = null;
    let registryModels = {};
    try {
      const { loadLocalModels } = await import("./local.mjs");
      const loaded = loadLocalModels();
      registry = { path: loaded.path, default: loaded.default, ids: Object.keys(loaded.models) };
      registryModels = loaded.models;
    } catch (error) {
      registryError = error.message;
    }
    const entries = [];
    for (const [id, entry] of Object.entries(registryModels)) {
      const file = path.join(root, entry.file);
      const stat = await fs.stat(file).catch(() => null);
      entries.push({
        id,
        label: entry.label,
        file,
        expectedBytes: entry.bytes,
        bytesOnDisk: stat?.size ?? 0,
        downloaded: Boolean(stat && stat.size === entry.bytes),
        partial: Boolean(stat && stat.size !== entry.bytes),
        default: registry.default === id,
      });
    }
    let onDisk = [];
    const files = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of files.slice(0, 200)) {
      if (!entry.isFile() || !entry.name.endsWith(".gguf")) continue;
      const stat = await fs.stat(path.join(root, entry.name)).catch(() => null);
      onDisk.push({ name: entry.name, path: path.join(root, entry.name), bytes: stat?.size ?? 0 });
    }
    onDisk.sort((a, b) => a.name.localeCompare(b.name));
    let status = null;
    let statusError = null;
    try {
      const { localStatus } = await import("./local.mjs");
      status = await localStatus({ home });
    } catch (error) {
      statusError = error.message;
    }
    return { root, registry, registryError, entries, onDisk, status, statusError };
  }

  async function apiModelsStart(body) {
    return startLocalTier(tierByName("local-readout"), body);
  }

  async function apiJudge(body) {
    const { config } = await currentConfig();
    const apiKey = config.apiKey ?? (isLoopbackBaseUrl(config.baseUrl) ? "local" : null);
    if (!apiKey) throw new WebUiError("no TypeSafe API key: store one in the Config panel, or point baseUrl at a local tier", 400);
    if (body.state === undefined || body.state === null) throw new WebUiError("state is required");
    const stateText = typeof body.state === "string" ? body.state : JSON.stringify(body.state);
    if (stateText.length > 200_000) throw new WebUiError("state is longer than 200000 characters");
    const questionsRaw = typeof body.questions === "string" ? parseMaybeJson(body.questions) : body.questions;
    if (!isPlainObject(questionsRaw)) throw new WebUiError("questions must be a JSON object keyed by question id");
    try {
      validateQuestions(questionsRaw);
    } catch (error) {
      throw new WebUiError(error.message, 400);
    }
    const model = body.model ? requireToken(body.model, "model") : config.model;
    const client = new TypeSafeClient({
      apiKey,
      baseUrl: config.baseUrl,
      model,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      pricePerMtok: config.pricePerMtok,
    });
    const result = await client.systemOne({ state: parseMaybeJson(stateText), questions: questionsRaw });
    return {
      model: result.model,
      answers: result.answers,
      usage: result.usage,
      costUsd: result.costUsd,
      ms: result.ms,
      cacheHit: result.cacheHit,
      baseUrl: config.baseUrl,
      profile: config.thresholds.profile,
    };
  }

  async function apiRun(body) {
    if (isRunning("run")) throw new WebUiError("a run is already in progress — stop it first", 409);
    const goal = requireText(body.goal, "goal", 2000);
    const url = requireUrl(body.url, "url");
    const inputs = requirePairs(body.inputs, "inputs");
    const secrets = requirePairs(body.secrets, "secrets");
    const backend = body.backend === undefined || body.backend === "" ? null : requireChoice(body.backend, "backend", ["ego", "chrome", "safari"]);
    const maxSteps = body.maxSteps === undefined || body.maxSteps === "" ? null : requireNumber(body.maxSteps, "maxSteps", { min: 1, max: 1000, integer: true });
    const budgetUsd = body.budgetUsd === undefined || body.budgetUsd === "" ? null : requireNumber(body.budgetUsd, "budgetUsd", { min: 0.0001, max: 1000 });
    // The journal goes under the OS temp directory: the WebUI writes nothing of its own anywhere
    // else, and `--journal-dir` is how the CLI is told where to put it.
    const runId = `webui-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const journalDir = path.join(os.tmpdir(), "jev-browser-webui", runId);
    const args = ["run", "--json", "--goal", goal, "--url", url, "--journal-dir", journalDir];
    if (backend) args.push("--backend", backend);
    if (maxSteps !== null) args.push("--max-steps", String(maxSteps));
    if (budgetUsd !== null) args.push("--budget-usd", String(budgetUsd));
    for (const [key, value] of Object.entries(inputs)) args.push("--input", `${key}=${value}`);
    for (const [key, value] of Object.entries(secrets)) args.push("--secret", `${key}=${value}`);
    for (const value of Object.values(secrets)) redactions.add(value);
    const script = path.join(skillDir, "bin", "jev-browser.mjs");
    const record = startChild("run", script, args, { runId, journalDir, goal, url, secretKeys: Object.keys(secrets), stdoutToLog: false });
    return {
      runId,
      channel: "run",
      pid: record.pid,
      journalDir,
      // The command line the panel shows, with every secret value replaced.
      command: [`node ${script}`, "run", "--json", "--goal", JSON.stringify(goal), "--url", JSON.stringify(url), `--journal-dir ${journalDir}`]
        .concat(backend ? ["--backend", backend] : [])
        .concat(maxSteps !== null ? ["--max-steps", String(maxSteps)] : [])
        .concat(budgetUsd !== null ? ["--budget-usd", String(budgetUsd)] : [])
        .concat(Object.entries(inputs).map(([key, value]) => `--input ${key}=${JSON.stringify(value)}`))
        .concat(Object.keys(secrets).map((key) => `--secret ${key}=‹secret›`))
        .join(" "),
    };
  }

  function apiRunGet() {
    const record = children.get("run");
    if (!record) return { running: false, ready: false, result: null, resultError: null, journal: null, exitCode: null };
    return {
      runId: record.runId ?? null,
      goal: record.goal ?? null,
      url: record.url ?? null,
      startedAt: record.startedAt,
      running: Boolean(record.running),
      ready: Boolean(record.ready),
      exitCode: record.exitCode ?? null,
      signal: record.signal ?? null,
      error: record.error ?? null,
      result: record.result ?? null,
      resultError: record.resultError ?? null,
      journal: record.journal ?? null,
    };
  }

  function apiRunStop() {
    const record = children.get("run");
    if (!record || !record.running) throw new WebUiError("no run is in progress", 409);
    killTree(record, "SIGTERM");
    return { stopped: true, pid: record.pid };
  }

  // ---------------------------------------------------------------- dispatch

  const HANDLERS = {
    "GET /": (_url, _req, res) => sendHtml(res, WEBUI_PAGE),
    "GET /api/tiers": () => apiTiers(),
    "POST /api/tiers/start": (_url, req) => readJsonBody(req).then(apiTiersStart),
    "POST /api/tiers/stop": (_url, req) => readJsonBody(req).then(apiTiersStop),
    "GET /api/tiers/use": (url) => apiTierUse(url),
    "POST /api/tiers/use": (_url, req) => readJsonBody(req).then(apiTierUsePersist),
    "GET /api/logs": (url) => apiLogs(url),
    "GET /api/config": () => apiConfigGet(),
    "POST /api/config": (_url, req) => readJsonBody(req).then(apiConfigPost),
    "POST /api/config/unset": (_url, req) => readJsonBody(req).then(apiConfigUnset),
    "GET /api/doctor": (url) => apiDoctor(url),
    "GET /api/models": () => apiModels(),
    "POST /api/models/start": (_url, req) => readJsonBody(req).then(apiModelsStart),
    "POST /api/judge": (_url, req) => readJsonBody(req).then(apiJudge),
    "POST /api/run": (_url, req) => readJsonBody(req).then(apiRun),
    "GET /api/run": () => apiRunGet(),
    "POST /api/run/stop": () => apiRunStop(),
  };

  async function handle(req, res) {
    let scrub = (text) => text;
    try {
      await refreshRedactions();
      scrub = scrubber();
      const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
      const key = `${req.method} ${url.pathname}`;
      const handler = HANDLERS[key];
      if (!handler) {
        const allowed = ROUTES.filter((route) => route.path === url.pathname).map((route) => route.method);
        if (allowed.length) throw new WebUiError(`method ${req.method} is not allowed on ${url.pathname} (allowed: ${allowed.join(", ")})`, 405);
        throw new WebUiError(`unknown route ${key}`, 404);
      }
      const body = await handler(url, req, res);
      if (body !== undefined && !res.headersSent) sendJson(res, 200, body, scrub);
    } catch (error) {
      const status = error instanceof WebUiError ? error.status : Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: error?.message ?? "internal error" }, scrub);
      else res.end();
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  /** Stop every child this server started, then close the socket. */
  async function close({ timeoutMs = 2000 } = {}) {
    const living = [...children.values()].filter((record) => record.running);
    for (const record of living) killTree(record, "SIGTERM");
    if (living.length) {
      await Promise.race([
        Promise.all(living.map((record) => new Promise((resolve) => (record.running ? record.child.once?.("close", resolve) : resolve())))),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
      for (const record of living) if (record.running) killTree(record, "SIGKILL");
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { server, channels, children, spawned, state: { redactions }, close, url: (port) => `http://${LOOPBACK}:${port}/` };
}
