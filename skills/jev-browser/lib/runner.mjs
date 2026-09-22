// Binds a job (goal + inputs + mode) to a backend driver and the controller.
import path from "node:path";
import { runGoal } from "./controller.mjs";
import { buildStepQuestions } from "./questions.mjs";
import { keywordsFor, pageStateForModel } from "./observe.mjs";
import { TypeSafeClient } from "./typesafe.mjs";
import { JsonlWriter, ensureDir, runId as makeRunId } from "./util.mjs";

/** Estimate tokens for a JSON payload (rough: 1 token ≈ 3.6 chars of JSON). */
export const estimateTokens = (value) => Math.ceil(JSON.stringify(value).length / 3.6);

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
    return { mode, backend: driver.name, state, questions, meta, estimatedInputTokens: estimateTokens({ state, questions }), estimatedCostUsd: (estimateTokens({ state, questions }) * config.pricePerMtok) / 1e6 };
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
  });
  await requestJournal?.flush();
  return result;
}
