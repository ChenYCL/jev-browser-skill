// The judging tiers a jev-browser run can talk to, as data, plus the one resolution every command
// that describes "what a run would use" shares — the CLI's `tier list|status|use` and `doctor`.
//
// Hosted Jev is the default and stays the default: nothing in this file, in DEFAULTS or in fromEnv()
// may point a clean configuration at a loopback URL. The two local tiers are opt-in — one export
// line each, printed by their own launchers — and exist so the choice is discoverable from the CLI
// instead of being folklore in a doc.
import { DEFAULTS, THRESHOLD_PROFILES, classifyModelsCard, thresholdProfile, userConfigPath } from "./config.mjs";
import { TypeSafeClient, isLoopbackBaseUrl } from "./typesafe.mjs";

/** The tier a clean configuration (no config file, no env, no flags) uses. */
export const DEFAULT_TIER = "hosted";

/**
 * Every tier `tier list` prints, in order: the default first, then the two local ones by weight.
 *
 * `bar` is deliberately NOT written here — it is read from THRESHOLD_PROFILES so this table and
 * `doctor` can never disagree about a number. `score` and `notes` carry only numbers measured and
 * recorded in the repo: docs/local-backend-run-smoke.md, experiments/gguf-provider/RESULTS.md,
 * experiments/kev-4b/README.md.
 */
export const TIERS = Object.freeze([
  Object.freeze({
    name: "hosted",
    what: "TypeSafe Jev (System One) over HTTPS — the shipped default",
    needs: "a TYPESAFE_API_KEY and network access",
    launcher: null, // nothing to start: it is a service
    baseUrl: DEFAULTS.baseUrl,
    port: null,
    apiKey: null, // a real key, not a local placeholder
    score: "0.95",
    notes: ["a step costs roughly $0.0002 at a few thousand input tokens"],
  }),
  Object.freeze({
    name: "local-readout",
    what: "first-token logprob readout on llama.cpp (jev-local)",
    needs: "Homebrew llama.cpp; no Python; the registry's 2.6 GiB GGUF",
    launcher: "bin/jev-local.mjs",
    baseUrl: "http://127.0.0.1:8092",
    port: 8092,
    apiKey: "local",
    score: "0.80",
    notes: ["p50 ≈4.3 s per step (measured max 18.2 s); $0, nothing leaves the machine", "the registry's 0.8B entry scores 0.50"],
  }),
  Object.freeze({
    name: "kev",
    what: "Kev 4B trained pointer-head checkpoint on its own MLX runtime (jev-kev)",
    needs: "a Python venv with MLX; a 9.34 GB base checkpoint",
    launcher: "bin/jev-kev.mjs",
    baseUrl: "http://127.0.0.1:8008",
    port: 8008,
    apiKey: "local",
    score: "0.95 / 0.90",
    notes: [
      "0.95 (19/20) with --patch-row-limit, 0.90 (18/20) at the released row limit",
      "mean 2.2 s per item (12.2 s worst); ~18 GB idle, ~36 GB under load",
    ],
  }),
]);

/** What `tier status` reports when a loopback endpoint answered nothing it could identify. */
export const UNCLASSIFIED_TIER = "unclassified";

export const tierByName = (name) => TIERS.find((tier) => tier.name === name) ?? null;
export const tierByPort = (port) => TIERS.find((tier) => tier.port === Number(port)) ?? null;

const skillPrefix = (skillDir) => (skillDir ? `${String(skillDir).replace(/\/+$/, "")}/` : "<skill-dir>/");

/** The command that starts a local tier's server (null for hosted). */
export function launcherCommand(tier, skillDir) {
  return tier.launcher ? `node ${skillPrefix(skillDir)}${tier.launcher}` : null;
}

/** The environment a tier needs: the two variables, with a placeholder where a real key goes. */
export const tierEnv = (tier) => ({ TYPESAFE_BASE_URL: tier.baseUrl, TYPESAFE_API_KEY: tier.apiKey ?? "<your key>" });

/** The line both launchers print on stdout once they are serving. */
export const envLine = (tier) => `TYPESAFE_BASE_URL=${tier.baseUrl} TYPESAFE_API_KEY=${tier.apiKey ?? "<your key>"}`;

/** One row per tier for `tier list` (and its `--json` form). */
export function tierRows({ skillDir = null } = {}) {
  return TIERS.map((tier) => ({
    tier: tier.name,
    default: tier.name === DEFAULT_TIER,
    what: tier.what,
    needs: tier.needs,
    baseUrl: tier.baseUrl,
    port: tier.port,
    env: tierEnv(tier),
    command: launcherCommand(tier, skillDir),
    start: tier.launcher ? `node ${skillPrefix(skillDir)}${tier.launcher} (serves 127.0.0.1:${tier.port})` : `nothing to start — ${tier.baseUrl}`,
    score: tier.score,
    bar: { profile: tier.name, ...THRESHOLD_PROFILES[tier.name] },
    notes: [...tier.notes],
  }));
}

/** The port a loopback baseUrl points at, or null. */
export function loopbackPort(baseUrl) {
  if (!isLoopbackBaseUrl(baseUrl)) return null;
  try {
    const url = new URL(String(baseUrl));
    return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Which backend answers on `config.baseUrl`, from the card it serves.
 *
 * `models` is the response a caller already fetched (a run asks once at start; `doctor` and
 * `tier status` ask for the same reason), so the common path costs no extra request. Without one,
 * a loopback endpoint is asked directly — with the same short timeout as `doctor` — and a
 * non-loopback one is never probed at all: hosted Jev is not a local backend to classify.
 *
 * @returns {Promise<{profile: string|null, kind: string, reason: string, names: string[]}|null>}
 *   null = not probed (hosted baseUrl, or no live probe was wanted).
 */
export async function probeEndpoint({ config, live = true, models = null, timeoutMs = 2500 } = {}) {
  if (models) return classifyModelsCard(models);
  if (!live || !isLoopbackBaseUrl(config.baseUrl)) return null;
  const url = `${String(config.baseUrl).replace(/\/+$/, "")}/v1/models`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { profile: null, kind: "http-error", reason: `${url} answered HTTP ${response.status}`, names: [] };
    return classifyModelsCard(await response.json());
  } catch (error) {
    return { profile: null, kind: "unreachable", reason: `${url} unreachable (${error.message})`, names: [] };
  }
}

/**
 * One GET /v1/models from the endpoint a run would use, when the answer can matter: a loopback
 * baseUrl with a key configured. Anything else returns null and `probeEndpoint` probes directly
 * (or not at all). Failures are silent — "could not ask" is a state `tier status` reports, not one
 * it throws on.
 */
export async function fetchModels({ config, timeoutMs = 10_000 } = {}) {
  if (!config.apiKey || !isLoopbackBaseUrl(config.baseUrl)) return null;
  try {
    return await new TypeSafeClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, timeoutMs, maxRetries: 0 }).models();
  } catch {
    return null;
  }
}

/**
 * What a run would use right now: the tier, the bar, and the endpoint behind them.
 *
 * The tier is the resolved `thresholds.profile`, except when that profile came from the
 * unclassified-loopback fallback — then the tier is `unclassified` and the profile name is still
 * reported, because claiming "kev" would assert an identity nobody established. A pinned
 * `thresholds.profile` always names the tier, whatever the endpoint is.
 *
 * @param {{config: object, classification?: object|null, skillDir?: string|null}} options
 */
export function describeTier({ config, classification = null, skillDir = null }) {
  const loopback = isLoopbackBaseUrl(config.baseUrl);
  const record = thresholdProfile(config, { classification });
  const pinnedKeys = config.thresholds.configured ?? [];
  const effective = {};
  for (const key of ["goalDone", "goalDoneFinal"]) effective[key] = pinnedKeys.includes(key) ? config.thresholds[key] : record.defaults[key];
  const unclassified = record.pinned === "auto" && loopback && !classification?.profile;
  const name = unclassified ? UNCLASSIFIED_TIER : record.profile;
  const port = loopbackPort(config.baseUrl);
  const launcher = port ? tierByPort(port) : null;
  return {
    tier: name,
    default: name === DEFAULT_TIER,
    baseUrl: config.baseUrl,
    loopback,
    port,
    pinned: record.pinned !== "auto",
    profile: { name: record.profile, pinned: record.pinned, reason: record.reason, measured: record.measured, custom: record.custom },
    bar: { ...record.defaults },
    effective,
    pinnedKeys,
    classification,
    start: launcher ? { tier: launcher.name, port, command: launcherCommand(launcher, skillDir) } : null,
  };
}

/** Human line for what `tier status` found on the endpoint. */
function endpointLine(status) {
  const c = status.classification;
  if (!c) {
    return status.loopback
      ? "not probed — the probe was skipped (offline)"
      : "not probed — hosted Jev is reached over HTTPS; there is no local backend to classify";
  }
  if (c.profile) return `ANSWERING — classified as ${c.profile}: ${c.reason}`;
  const verdict = c.kind === "unreachable" ? "NOT ANSWERING" : c.kind === "http-error" ? "ANSWERED, but not with usable model cards" : "NO USABLE ANSWER";
  return `${verdict} — ${c.reason}`;
}

/** `tier list` — one table: what each tier is, what it needs, how to start it, what it scored. */
export function formatTierList(rows) {
  const columns = [
    { header: "tier", cell: (r) => `${r.default ? "*" : " "} ${r.tier}` },
    { header: "what it is", cell: (r) => r.what },
    { header: "needs", cell: (r) => r.needs },
    { header: "port", cell: (r) => (r.port ? String(r.port) : "—") },
    { header: "20 items", cell: (r) => r.score },
    { header: "goal_done bar", cell: (r) => `${r.bar.goalDone} / ${r.bar.goalDoneFinal}` },
  ];
  const width = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => c.cell(r).length)));
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(width[i])).join("  ").replace(/\s+$/, "");
  const out = ["jev-browser judging tiers — hosted Jev is the default", "", line(columns.map((c) => c.header)), line(width.map((w) => "-".repeat(w)))];
  for (const row of rows) {
    out.push(line(columns.map((c) => c.cell(row))));
    out.push(`      start: ${row.start}`);
    for (const note of row.notes) out.push(`             ${note}`);
  }
  out.push("");
  out.push("* = the default: with no config file, no environment and no flags, a run uses hosted Jev.");
  out.push("20 items = the graded set in experiments/ (hosted 0.95; kev 0.95 patched / 0.90 released).");
  out.push("goal_done bar = noul probability per step / final check — see references/config.md for the profiles.");
  out.push(`Pick one for a shell with: jev-browser tier use <${TIERS.map((t) => t.name).join("|")}>   —   what a run would use now: jev-browser tier status`);
  return out.join("\n");
}

/** `tier status` — what a run would use right now, and why. */
export function formatTierStatus(status) {
  const out = ["jev-browser tier status", ""];
  const row = (key, value) => out.push(`  ${String(key).padEnd(11)} ${value}`);
  row(
    "tier",
    status.tier === UNCLASSIFIED_TIER
      ? `${UNCLASSIFIED_TIER} — the loopback endpoint did not answer with a card this build knows`
      : `${status.tier}${status.default ? " (the default)" : ""}`,
  );
  row("baseUrl", `${status.baseUrl} ${status.loopback ? "(loopback)" : "(not loopback)"}`);
  row("endpoint", endpointLine(status));
  row("profile", `${status.profile.name}${status.profile.pinned !== "auto" ? ` (pinned: thresholds.profile=${status.profile.pinned})` : ""} — ${status.profile.reason}`);
  row(
    "goal_done",
    `${status.effective.goalDone} per step / ${status.effective.goalDoneFinal} final` +
      `${status.pinnedKeys.length ? ` (${status.pinnedKeys.map((key) => `thresholds.${key}`).join(", ")} pinned)` : ""}` +
      ` — measured on ${status.profile.measured}`,
  );
  if (status.start) row("start it", `${status.start.command}    (serves 127.0.0.1:${status.start.port})`);
  out.push("");
  const uses = status.pinned
    ? `the ${status.profile.name} profile (pinned by thresholds.profile)`
    : status.tier === UNCLASSIFIED_TIER
      ? `the ${status.profile.name} profile (fallback — the endpoint was not classified)`
      : `the ${status.tier} tier`;
  out.push(`A run right now uses: ${uses}, against ${status.baseUrl}`);
  return out.join("\n");
}

/**
 * `tier use` — the export line, the way both launchers print it. Nothing is written to disk here;
 * only `--persist` (or `config set baseUrl`) stores anything: a local tier's baseUrl and its
 * placeholder apiKey, because a key the client can see is what a local run still needs; hosted
 * stores its baseUrl alone. The text says which either way.
 */
export function formatTierUse(tier, { skillDir = null, persisted = null, configPath = userConfigPath() } = {}) {
  const out = [];
  if (tier.name === DEFAULT_TIER) {
    out.push("Hosted Jev is already the default — nothing to start and nothing to change.");
    out.push("");
    out.push(`  ${envLine(tier)}`);
    out.push("");
    out.push("If a config file, an environment variable or a flag points baseUrl somewhere else, drop the override:");
    out.push("");
    out.push(`  export TYPESAFE_BASE_URL=${tier.baseUrl}`);
    out.push(`  jev-browser config unset baseUrl      # or: jev-browser config set baseUrl ${tier.baseUrl}`);
  } else {
    out.push(`Start ${tier.name} in one terminal — it downloads what is missing on the first run:`);
    out.push("");
    out.push(`  ${launcherCommand(tier, skillDir)}`);
    out.push("");
    out.push("It prints this line once it is serving (only that line goes to stdout):");
    out.push("");
    out.push(`  ${envLine(tier)}`);
    out.push("");
    out.push("Then, in the shell that runs jev-browser:");
    out.push("");
    out.push(`  export TYPESAFE_BASE_URL=${tier.baseUrl}`);
    out.push(`  export TYPESAFE_API_KEY=${tier.apiKey}`);
    out.push("");
    out.push(
      `The endpoint is classified at run start, so the right goal_done bar (${THRESHOLD_PROFILES[tier.name].goalDone}) is applied without pinning anything.`,
    );
  }
  out.push("");
  out.push(
    persisted
      ? `Stored ${tier.apiKey ? `apiKey=${tier.apiKey} and baseUrl=${tier.baseUrl}` : `baseUrl=${tier.baseUrl}`} in ${persisted} — runs use it without the export.`
      : `Nothing was written: add --persist to store ${tier.apiKey ? "that tier's baseUrl and apiKey" : "baseUrl"} in ${configPath} instead of exporting it.`,
  );
  return out.join("\n");
}
