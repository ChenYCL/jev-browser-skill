// Configuration: defaults < user file < project file < environment < CLI flags.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deepMerge, expandHome, isRecord, readJson, writeJson } from "./util.mjs";
import { isLoopbackBaseUrl } from "./typesafe.mjs";

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
    profile: "auto", // auto | hosted | local-readout | kev — which goal_done bar to use; auto resolves from the endpoint
    goalDone: 0.85, // noul probability required to declare success
    goalDoneFinal: 0.7, // looser check used only for the final verification pass
    configured: [], // filled by loadConfig: the keys some layer set, so the run never overrides them
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

/**
 * The `goal_done` bar for the *GGUF readout* backend. Scored as a termination rule over 15 recorded
 * local runs (docs/local-backend-run-smoke.md §9), the question does separate the two populations —
 * but the hosted value 0.85 does not: every run that reached the goal crossed 0.25, and no run that
 * never reached it crossed 0.111. The value below is the geometric midpoint √(0.111 × 0.273) of
 * the two observed sides, which maximises the minimum relative margin on both (1.57× each).
 */
export const LOCAL_GOAL_DONE = 0.174;

/**
 * The same measurement replayed against the Kev checkpoint (experiments/kev-4b/README.md, same 15
 * goals, same scoring, 46 readings): the readout's band does NOT transfer — at 0.174 Kev calls four
 * not-met pages a success. Kev's own sides are 0.341 (worst not-met) and 0.683 (lowest met), so the
 * bar below is again the geometric midpoint √(0.341 × 0.683), which sits 1.41× from each side.
 */
export const KEV_GOAL_DONE = 0.482;

/**
 * A named bar per backend. `auto` (the default, see thresholds.profile) picks one of these from the
 * endpoint; an explicit name pins it. `hosted` is the measured hosted-Jev pair; the two local ones
 * are per-backend measurements and are NOT interchangeable — that is the whole reason this is a map.
 */
export const THRESHOLD_PROFILES = Object.freeze({
  hosted: Object.freeze({ goalDone: 0.85, goalDoneFinal: 0.7 }),
  "local-readout": Object.freeze({ goalDone: LOCAL_GOAL_DONE, goalDoneFinal: LOCAL_GOAL_DONE }),
  kev: Object.freeze({ goalDone: KEV_GOAL_DONE, goalDoneFinal: KEV_GOAL_DONE }),
});

/** Where each profile's pair was measured — printed by doctor so the bar never looks arbitrary. */
export const PROFILE_MEASURED = Object.freeze({
  hosted: "the shipped Jev default",
  "local-readout": "docs/local-backend-run-smoke.md §9 (band 0.111 – 0.273)",
  kev: "experiments/kev-4b/README.md (band 0.341 – 0.683)",
});

export const PROFILE_NAMES = Object.freeze(["auto", ...Object.keys(THRESHOLD_PROFILES)]);

/**
 * What `auto` falls back to when a loopback endpoint cannot be classified (unreachable, or a card
 * this build does not recognise): the HIGHEST bar. A false `stuck` is visible and recoverable — the
 * run stops and says so — while a false success is silent, so an unknown backend never gets the
 * benefit of the doubt.
 */
export const FALLBACK_PROFILE = "kev";
export const FALLBACK_REASON = "loopback endpoint not classified (unreachable or unrecognised) → the highest bar; a false stuck is visible, a false success is not";

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

/** True when a config patch explicitly provides a (possibly nested) key. */
function hasKeyPath(node, keyPath) {
  let current = node;
  for (const part of keyPath.split(".")) {
    if (!isRecord(current) || !(part in current)) return false;
    current = current[part];
  }
  return current !== undefined;
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

  // Which bar is in force depends on the backend, and only the run knows which backend it is
  // talking to (one GET /v1/models — see thresholdProfile/classifyModelsCard and runner.mjs). What
  // loadConfig can settle without a network call is a *pinned* profile: `thresholds.profile` set to
  // a concrete name means its values, for any threshold no layer configured.
  const layers = [user, project, envPatch, flagPatch];
  const configuredThresholds = ["goalDone", "goalDoneFinal"].filter((key) => layers.some((layer) => hasKeyPath(layer, `thresholds.${key}`)));
  if (!PROFILE_NAMES.includes(merged.thresholds.profile)) {
    throw new Error(`Unknown thresholds.profile "${merged.thresholds.profile}" (expected ${PROFILE_NAMES.join(", ")})`);
  }
  if (merged.thresholds.profile !== "auto") {
    const profile = THRESHOLD_PROFILES[merged.thresholds.profile];
    const applied = {};
    for (const key of ["goalDone", "goalDoneFinal"]) {
      if (configuredThresholds.includes(key)) continue;
      merged.thresholds[key] = profile[key];
      applied[`thresholds.${key}`] = profile[key];
    }
    if (Object.keys(applied).length) {
      sources.push({
        kind: "thresholds-profile",
        keys: Object.keys(applied),
        values: applied,
        reason: `thresholds.profile=${merged.thresholds.profile} (pinned by configuration)`,
      });
    }
  }

  merged.journalDir = expandHome(merged.journalDir, home);
  merged.chrome.userDataDir = expandHome(merged.chrome.userDataDir, home);
  if (!["ego", "chrome", "safari"].includes(merged.backend)) {
    throw new Error(`Unknown backend "${merged.backend}" (expected ego, chrome or safari)`);
  }
  merged.thresholds.configured = configuredThresholds;
  for (const key of ["maxSteps", "budgetUsd", "maxMs", "timeoutMs"]) {
    if (!Number.isFinite(merged[key]) || merged[key] <= 0) throw new Error(`Config ${key} must be a positive number`);
  }
  return { config: merged, sources, paths: { userFile, projectFile }, configuredThresholds };
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

/**
 * Which backend a served `/v1/models` card says it is, from the card the endpoint itself returns.
 *
 * Pure on purpose: the network call belongs to the run (runner.mjs) and to doctor, so this stays
 * unit-testable and cannot make `loadConfig` depend on a live endpoint.
 *
 *  - Kev (and hosted Jev) cards carry `run` and `base` beside `name` — a checkpoint the runtime
 *    loads, which is what makes Kev's scale so different from a first-token readout's.
 *  - The GGUF launcher's card carries only `name` (the registry id), description and modalities.
 *
 * @returns {{profile: string|null, kind: string, reason: string, names: string[]}}
 */
export function classifyModelsCard(cards) {
  const list = cards?.models ?? cards?.data ?? [];
  const names = list.map((card) => card?.name ?? card?.id).filter(Boolean);
  if (list.length === 0) return { profile: null, kind: "empty", reason: "the endpoint returned no model cards", names: [] };
  const loaded = list.find((card) => card?.run || card?.base);
  if (loaded) {
    const bits = [loaded.run && `run=${loaded.run}`, loaded.base && `base=${loaded.base}`].filter(Boolean).join(" ");
    return { profile: "kev", kind: "kev", reason: `model card "${loaded.name ?? names[0]}" names a loaded checkpoint (${bits})`, names };
  }
  const readout = list.find((card) => card?.name || card?.id);
  if (readout) return { profile: "local-readout", kind: "readout", reason: `model card "${readout.name ?? readout.id}" is name-only (the GGUF readout)`, names };
  return { profile: null, kind: "unknown", reason: "model cards carry neither a name nor a checkpoint", names };
}

/**
 * Which `goal_done` bar the effective configuration uses, and why.
 *
 * Order: an explicitly pinned `thresholds.profile` first (it never needs the endpoint), then the
 * backend scale — a non-loopback baseUrl is hosted, a loopback one is whatever `classification`
 * says it is — and finally, for a loopback endpoint nobody could classify, the highest bar.
 *
 * @param {object} config effective configuration
 * @param {{classification?: {profile: string|null, reason: string}|null}} [options]
 */
export function thresholdProfile(config, { classification = null } = {}) {
  const pinned = config.thresholds.profile ?? "auto";
  const loopback = isLoopbackBaseUrl(config.baseUrl);
  let profile;
  let reason;
  if (pinned !== "auto") {
    profile = pinned;
    reason = `thresholds.profile=${pinned} (pinned by configuration)`;
  } else if (!loopback) {
    profile = "hosted";
    reason = `baseUrl ${config.baseUrl} is not loopback`;
  } else if (classification?.profile) {
    profile = classification.profile;
    reason = classification.reason;
  } else {
    profile = FALLBACK_PROFILE;
    reason = classification?.reason ? `${FALLBACK_REASON} (${classification.reason})` : FALLBACK_REASON;
  }
  const defaults = THRESHOLD_PROFILES[profile];
  const custom = ["goalDone", "goalDoneFinal"].filter((key) => config.thresholds[key] !== defaults[key]);
  return {
    profile,
    pinned,
    reason,
    measured: PROFILE_MEASURED[profile],
    goalDone: config.thresholds.goalDone,
    goalDoneFinal: config.thresholds.goalDoneFinal,
    defaults,
    custom,
  };
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
