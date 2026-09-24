// Binds a job (goal + inputs + mode) to a backend driver and the controller.
import path from "node:path";
import { classifyModelsCard, thresholdProfile } from "./config.mjs";
import { runGoal } from "./controller.mjs";
import { buildStepQuestions } from "./questions.mjs";
import { keywordsFor, pageStateForModel } from "./observe.mjs";
import { TypeSafeClient, isLoopbackBaseUrl, pricePerMtokFor } from "./typesafe.mjs";
import { JsonlWriter, ensureDir, runId as makeRunId } from "./util.mjs";

/** Estimate tokens for a JSON payload (rough: 1 token ≈ 3.6 chars of JSON). */
export const estimateTokens = (value) => Math.ceil(JSON.stringify(value).length / 3.6);

/**
 * Resolve the `goal_done` bar for this run and apply it to `config.thresholds`.
 *
 * `auto` needs one GET /v1/models to tell a Kev endpoint from the GGUF readout — the two have
 * measured bars 0.482 and 0.174 apart (experiments/kev-4b/README.md) and the hosted default (0.85)
 * is wrong for both. This is the only place that asks, so it lives at run start rather than in
 * loadConfig: no key, no endpoint, no network call for a hosted or pinned configuration.
 *
 * A value any configuration layer set always wins; otherwise the profile's pair is applied.
 * An unreachable or unrecognised loopback endpoint resolves to the HIGHEST bar (FALLBACK_PROFILE).
 *
 * @returns {Promise<{profile: string, reason: string, goalDone: number, goalDoneFinal: number, source: string}>}
 */
export async function resolveThresholds({ config, client, log = () => {} }) {
  const configuredThresholds = config.thresholds.configured ?? [];
  const auto = (config.thresholds.profile ?? "auto") === "auto";
  const loopback = isLoopbackBaseUrl(config.baseUrl);
  let classification = null;
  if (auto && loopback) {
    try {
      classification = classifyModelsCard(await client.models());
    } catch (error) {
      classification = { profile: null, reason: `the endpoint did not answer GET /v1/models (${error?.code ?? error.message})` };
    }
  }
  const bar = thresholdProfile(config, { classification });
  const applied = {};
  for (const key of ["goalDone", "goalDoneFinal"]) {
    if (configuredThresholds.includes(key)) continue;
    if (config.thresholds[key] === bar.defaults[key]) continue;
    config.thresholds[key] = bar.defaults[key];
    applied[key] = bar.defaults[key];
  }
  const record = {
    profile: bar.profile,
    reason: bar.reason,
    goalDone: config.thresholds.goalDone,
    goalDoneFinal: config.thresholds.goalDoneFinal,
    applied,
    custom: bar.custom,
    classification: classification ? { kind: classification.kind, profile: classification.profile, reason: classification.reason, names: classification.names } : null,
  };
  const configured = configuredThresholds.length ? `, configured: ${configuredThresholds.map((key) => `thresholds.${key}`).join(", ")}` : "";
  log(`thresholds: goal_done >= ${record.goalDone} per step, ${record.goalDoneFinal} final — ${bar.profile} profile${configured ? " (pinned per key)" : ""} — ${bar.reason}`);
  return record;
}

export async function executeJob({ config, job, log = () => {} }) {
  if (config.backend === "ego") {
    const { runEgoJob } = await import("./backends/ego.mjs");
    return runEgoJob({ config, job, log });
  }
  let driver;
  if (config.backend === "chrome") {
    const { createChromeDriver } = await import("./backends/chrome.mjs");
    driver = await createChromeDriver({ config, job, log });
  } else if (config.backend === "safari") {
    const { createSafariDriver } = await import("./backends/safari.mjs");
    driver = await createSafariDriver({ config, job, log });
  } else {
    throw new Error(`unknown backend ${config.backend}`);
  }
  return runWithDriver({ driver, config, job, log });
}

/** Shared by in-process backends and the ego child process. */
export async function runWithDriver({ driver, config, job, log = () => {} }) {
  const mode = job.mode ?? "run";
  if (mode === "observe") {
    await driver.start({ url: job.startUrl });
    const observation = await driver.observe(job.goal ? { keywords: keywordsFor(job.goal, job.inputs ?? {}) } : {});
    if (job.screenshotPath) await driver.screenshot(job.screenshotPath).catch(() => {});
    await driver.finish({ success: true, keep: job.keep ?? false });
    return { mode, backend: driver.name, observation, page: pageStateForModel(observation), resume: driver.describe?.() ?? null };
  }
  if (mode === "dry-run") {
    await driver.start({ url: job.startUrl });
    const observation = await driver.observe({ keywords: keywordsFor(job.goal, { ...(job.inputs ?? {}), ...(job.secrets ?? {}) }, Object.keys(job.secrets ?? {})) });
    const { state, questions, meta } = buildStepQuestions({ obs: observation, goal: job.goal, inputs: { ...(job.inputs ?? {}), ...(job.secrets ?? {}) }, secretKeys: Object.keys(job.secrets ?? {}) });
    await driver.finish({ success: true, keep: job.keep ?? false });
    return { mode, backend: driver.name, state, questions, meta, estimatedInputTokens: estimateTokens({ state, questions }), estimatedCostUsd: (estimateTokens({ state, questions }) * pricePerMtokFor(config.baseUrl, config.pricePerMtok)) / 1e6 };
  }
  if (!job.goal) throw new Error("a goal is required");
  const runId = job.runId ?? makeRunId();
  let requestJournal = null;
  if (config.keepJournal) {
    const dir = path.join(config.journalDir, runId);
    await ensureDir(dir);
    requestJournal = new JsonlWriter(path.join(dir, "requests.jsonl"));
  }
  const client = new TypeSafeClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    pricePerMtok: config.pricePerMtok,
    onRequest: requestJournal ? (row) => requestJournal.append(row) : undefined,
  });
  const thresholds = await resolveThresholds({ config, client, log });
  const result = await runGoal({
    driver,
    client,
    config,
    goal: job.goal,
    startUrl: job.startUrl,
    inputs: job.inputs ?? {},
    secrets: job.secrets ?? {},
    log,
    screenshotPath: job.screenshotPath,
    stepScreenshotsDir: job.stepScreenshotsDir,
    runId,
    thresholds,
  });
  await requestJournal?.flush();
  return result;
}
