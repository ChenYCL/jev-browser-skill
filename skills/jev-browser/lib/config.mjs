// Configuration: defaults < user file < project file < environment < CLI flags.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deepMerge, expandHome, isRecord, readJson, writeJson } from "./util.mjs";

export const CONFIG_VERSION = 1;

export const DEFAULTS = Object.freeze({
  version: CONFIG_VERSION,
  // TypeSafe / Jev
  apiKey: null, // prefer the TYPESAFE_API_KEY environment variable
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  timeoutMs: 20_000,
  maxRetries: 2,
  pricePerMtok: 0.042, // USD per million input tokens (billing is input-only)
  // Browser
  backend: "ego", // ego | chrome | safari
  // Controller budgets
  maxSteps: 25,
  budgetUsd: 0.25,
  maxMs: 300_000,
  settleMs: 400,
  loadTimeoutMs: 15_000,
  thresholds: {
    goalDone: 0.85, // noul probability required to declare success
    goalDoneFinal: 0.7, // looser check used only for the final verification pass
    blocker: 0.6, // choice probability of a non-"none" blocker that pauses for the user
    noChangeLimit: 3, // consecutive no-effect actions before giving up
    regressed: 0.6, // probability mass on "moved away" that triggers go_back
  },
  observation: {
    maxCandidates: 100, // interactive elements offered as Choice options (API max 255)
    maxTextChars: 3000,
    maxHeadings: 12,
    maxNameChars: 80,
  },
  journalDir: "~/.config/jev-browser/journal",
  keepJournal: true,
  ego: {
    serverName: null, // --ego-server-name
    keepOnSuccess: true, // leave the result page open for the user
    spaceName: null,
  },
  chrome: {
    cdpUrl: null, // attach to an existing Chrome started with --remote-debugging-port
    executable: null,
    userDataDir: "~/.config/jev-browser/chrome-profile",
    headless: false,
    windowSize: "1280,900",
    keepOnSuccess: true,
    extraArgs: [],
  },
  safari: {
    port: 0, // 0 = pick a free port
    keepOnSuccess: true,
  },
});

export const ENV = Object.freeze({
  apiKey: "TYPESAFE_API_KEY",
  baseUrl: "TYPESAFE_BASE_URL",
  model: "TYPESAFE_DEFAULT_MODEL",
  configFile: "JEV_BROWSER_CONFIG",
  backend: "JEV_BROWSER_BACKEND",
  maxSteps: "JEV_BROWSER_MAX_STEPS",
  budgetUsd: "JEV_BROWSER_BUDGET_USD",
  journalDir: "JEV_BROWSER_JOURNAL_DIR",
  chromeCdpUrl: "JEV_BROWSER_CHROME_CDP_URL",
  headless: "JEV_BROWSER_HEADLESS",
  egoServerName: "JEV_BROWSER_EGO_SERVER_NAME",
});

export function userConfigPath(home = os.homedir()) {
  return path.join(home, ".config", "jev-browser", "config.json");
}

export function projectConfigPath(cwd = process.cwd()) {
  return path.join(cwd, "jev-browser.config.json");
}

function fromEnv(env) {
  const out = {};
  if (env[ENV.apiKey]) out.apiKey = env[ENV.apiKey];
  if (env[ENV.baseUrl]) out.baseUrl = env[ENV.baseUrl];
  if (env[ENV.model]) out.model = env[ENV.model];
  if (env[ENV.backend]) out.backend = env[ENV.backend];
  if (env[ENV.maxSteps]) out.maxSteps = Number(env[ENV.maxSteps]);
  if (env[ENV.budgetUsd]) out.budgetUsd = Number(env[ENV.budgetUsd]);
  if (env[ENV.journalDir]) out.journalDir = env[ENV.journalDir];
  if (env[ENV.chromeCdpUrl]) out.chrome = { cdpUrl: env[ENV.chromeCdpUrl] };
  if (env[ENV.headless] !== undefined && env[ENV.headless] !== "") {
    out.chrome = { ...(out.chrome ?? {}), headless: /^(1|true|yes)$/i.test(env[ENV.headless]) };
  }
  if (env[ENV.egoServerName]) out.ego = { serverName: env[ENV.egoServerName] };
  return out;
}

/**
 * Load the effective configuration.
 * @param {object} options
 * @param {object} [options.flags] CLI-level overrides (already typed)
 * @param {object} [options.env] environment (defaults to process.env)
 * @param {string} [options.cwd]
 * @param {string} [options.home]
 */
export async function loadConfig({ flags = {}, env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  const sources = [];
  let merged = structuredClone(DEFAULTS);

  const userFile = userConfigPath(home);
  const user = await readJson(userFile, null);
  if (isRecord(user)) {
    merged = deepMerge(merged, user);
    sources.push({ kind: "user-file", path: userFile });
  }

  const projectFile = env[ENV.configFile] ? expandHome(env[ENV.configFile], home) : projectConfigPath(cwd);
  const project = await readJson(projectFile, null);
  if (isRecord(project)) {
    merged = deepMerge(merged, project);
    sources.push({ kind: "project-file", path: projectFile });
  }

  const envPatch = fromEnv(env);
  if (Object.keys(envPatch).length) {
    merged = deepMerge(merged, envPatch);
    sources.push({ kind: "env", keys: Object.keys(envPatch) });
  }

  const flagPatch = Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined));
  if (Object.keys(flagPatch).length) {
    merged = deepMerge(merged, flagPatch);
    sources.push({ kind: "flags", keys: Object.keys(flagPatch) });
  }

  merged.journalDir = expandHome(merged.journalDir, home);
  merged.chrome.userDataDir = expandHome(merged.chrome.userDataDir, home);
  if (!["ego", "chrome", "safari"].includes(merged.backend)) {
    throw new Error(`Unknown backend "${merged.backend}" (expected ego, chrome or safari)`);
  }
  for (const key of ["maxSteps", "budgetUsd", "maxMs", "timeoutMs"]) {
    if (!Number.isFinite(merged[key]) || merged[key] <= 0) throw new Error(`Config ${key} must be a positive number`);
  }
  return { config: merged, sources, paths: { userFile, projectFile } };
}

/** Persist a patch into the user config file (0600, never printed). */
export async function saveUserConfig(patch, { home = os.homedir() } = {}) {
  const file = userConfigPath(home);
  const current = (await readJson(file, null)) ?? { version: CONFIG_VERSION };
  const next = deepMerge(current, patch);
  await writeJson(file, next, { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
  return file;
}

export async function unsetUserConfig(keyPath, { home = os.homedir() } = {}) {
  const file = userConfigPath(home);
  const current = (await readJson(file, null)) ?? { version: CONFIG_VERSION };
  const parts = keyPath.split(".");
  let node = current;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(node[part])) return file;
    node = node[part];
  }
  delete node[parts.at(-1)];
  await writeJson(file, current, { mode: 0o600 });
  return file;
}

/** Copy of the config safe to print (secrets masked). */
export function describeConfig(config) {
  const copy = structuredClone(config);
  if (copy.apiKey) copy.apiKey = `${copy.apiKey.slice(0, 6)}…(${copy.apiKey.length} chars)`;
  return copy;
}

/** Parse "a.b.c" = value assignments from the CLI into a nested patch. */
export function patchFromKeyPath(keyPath, rawValue) {
  let value = rawValue;
  if (rawValue === "true") value = true;
  else if (rawValue === "false") value = false;
  else if (rawValue === "null") value = null;
  else if (rawValue !== "" && !Number.isNaN(Number(rawValue))) value = Number(rawValue);
  return keyPath.split(".").reduceRight((acc, key) => ({ [key]: acc }), value);
}
