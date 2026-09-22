// The code controller. Jev supplies local judgments; this loop supplies memory,
// budgets, sequencing, loop detection and termination (NanoJev's "code planning").
import path from "node:path";
import { buildSelectOptionQuestions, buildStepQuestions, interpretAnswers } from "./questions.mjs";
import { elementFingerprint, describeElement, observationHash, summarizeObservation } from "./observe.mjs";
import { JsonlWriter, ensureDir, extractQuoted, nowIso, redact, runId as makeRunId, sleep, writeJson } from "./util.mjs";

export const STATUS = Object.freeze({
  success: "success", // goal_done above threshold
  needs_user: "needs_user", // blocker detected; hand the browser to the user
  stuck: "stuck", // repeated no-effect actions, loop, or model chose stop
  max_steps: "max_steps",
  budget_exhausted: "budget_exhausted",
  timeout: "timeout",
  error: "error",
});

/**
 * Driver contract implemented by each backend (all methods async):
 *   start({url}) -> void            observe() -> observation
 *   click(id) / type(id, text, {submit}) / select(id, value) / scroll(dir) / back() / navigate(url) / wait(ms)
 *   settle() -> void                screenshot(file) -> file | null
 *   handOff?() -> object|void       finish({success, keep}) -> void
 *   historyLength?() -> number      describe() -> {backend, ...ids for resume}
 */
export async function runGoal({ driver, client, config, goal, startUrl, inputs = {}, secrets = {}, log = () => {}, onStep, screenshotPath, stepScreenshotsDir, runId = makeRunId() }) {
  const startedAt = Date.now();
  const thr = config.thresholds;
  const allInputs = { ...inputs, ...secrets };
  for (const [i, quoted] of extractQuoted(goal).entries()) {
    const key = `quoted_${i + 1}`;
    if (!(key in allInputs) && !Object.values(allInputs).includes(quoted)) allInputs[key] = quoted;
  }
  const secretKeys = Object.keys(secrets);
  const secretValues = Object.values(secrets).map(String);

  const journalDir = config.keepJournal ? path.join(config.journalDir, runId) : null;
  const journal = journalDir ? new JsonlWriter(path.join(journalDir, "steps.jsonl")) : null;
  if (journalDir) await ensureDir(journalDir);

  // blocked: (state, action) pairs that produced no change or an error.
  // tried:   (state, action) pairs already executed once; untried edges are preferred (edge memory).
  const memory = { blocked: new Set(), tried: new Set(), visits: new Map(), hashes: new Map(), history: [], noChangeStreak: 0 };
  const result = { runId, status: STATUS.error, goal, backend: driver.name, steps: 0, startedAt: nowIso(), journalDir };
  let obs = null;
  let previous = null;
  let lastAction = null;
  let lastActionKey = null;

  const stateKey = (o) => observationHash(o);
  const observe = async () => sanitizeObservation(await driver.observe(), secretValues);
  if (stepScreenshotsDir) await ensureDir(stepScreenshotsDir);
  const snap = async (name) => {
    if (!stepScreenshotsDir) return null;
    try {
      return await driver.screenshot(path.join(stepScreenshotsDir, `${name}.png`));
    } catch (error) {
      log(`step screenshot failed: ${error.message}`);
      return null;
    }
  };
  let handedOff = false;
  /** Screenshot (while the browser is still open), close the browser, then assemble the result. */
  const conclude = async (status, extra = {}, { success = false } = {}) => {
    await snap("final");
    if (screenshotPath && obs) {
      try {
        result.screenshot = await driver.screenshot(screenshotPath);
      } catch (error) {
        result.screenshotError = error.message;
      }
    }
    if (!handedOff) {
      try {
        await driver.finish({ success });
      } catch (error) {
        result.finishError = error.message;
      }
    }
    Object.assign(result, extra, {
      status,
      steps: memory.history.length,
      finalUrl: obs?.url ?? null,
      finalTitle: obs?.title ?? null,
      finalTextExcerpt: obs ? summarizeObservation(obs, 300).text_excerpt : null,
      usage: { ...client.totals, costUsd: Number(client.totals.costUsd.toFixed(6)) },
      elapsedMs: Date.now() - startedAt,
      finishedAt: nowIso(),
      resume: driver.describe?.() ?? null,
    });
    if (journalDir) await writeJson(path.join(journalDir, "run.json"), redact(result, secretValues));
    await journal?.flush();
    return result;
  };

  try {
    await driver.start({ url: startUrl });
    obs = await observe();
    log(`observed ${obs.url} (${obs.elements.length} elements)`);

    for (let step = 1; step <= config.maxSteps; step += 1) {
      if (Date.now() - startedAt > config.maxMs) return await conclude(STATUS.timeout, { reason: `exceeded maxMs=${config.maxMs}` });
      if (client.totals.costUsd >= config.budgetUsd) return await conclude(STATUS.budget_exhausted, { reason: `spent ${client.totals.costUsd.toFixed(4)} USD ≥ budgetUsd=${config.budgetUsd}` });

      const hash = stateKey(obs);
      memory.hashes.set(hash, (memory.hashes.get(hash) ?? 0) + 1);
      memory.visits.set(obs.url, (memory.visits.get(obs.url) ?? 0) + 1);
      if (memory.hashes.get(hash) > 4) return await conclude(STATUS.stuck, { reason: "the same page state was seen more than four times" });

      const stepShot = await snap(`step-${String(step).padStart(2, "0")}`);
      const { state, questions, meta } = buildStepQuestions({
        obs,
        goal,
        inputs: allInputs,
        secretKeys,
        previous,
        lastAction,
        historyLength: (await driver.historyLength?.()) ?? memory.history.length + 1,
        stepsTaken: memory.history.length,
        visitedUrls: memory.history.map((h) => h.url),
      });
      const judged = await client.systemOne({ state, questions });
      const decision = interpretAnswers(judged.answers, meta);
      const stepRow = {
        step,
        ts: nowIso(),
        url: obs.url,
        title: obs.title,
        stateHash: hash,
        elementCount: obs.elements.length,
        questionCount: meta.questionCount,
        answers: compactAnswers(judged.answers),
        goalDone: decision.goalDone,
        blocker: decision.blocker.top,
        usage: judged.usage,
        costUsd: judged.costUsd,
        ms: judged.ms,
        cacheHit: judged.cacheHit,
        targets: describeTargets(judged.answers, obs), // id → description for the top candidates, for humans reading the journal
        ...(stepShot ? { screenshot: stepShot } : {}),
      };
      log(`step ${step}: goal_done=${decision.goalDone.toFixed(2)} blocker=${decision.blocker.top}(${decision.blocker.p.toFixed(2)}) action=${decision.actions[0]?.[0]}(${(decision.actions[0]?.[1] ?? 0).toFixed(2)}) cost=$${client.totals.costUsd.toFixed(4)}`);

      if (decision.goalDone >= thr.goalDone) {
        await journal?.append(redact({ ...stepRow, outcome: "success" }, secretValues));
        memory.history.push({ step, url: obs.url, action: "none (goal done)", key: null, changed: false });
        return await conclude(STATUS.success, { goalDoneProbability: decision.goalDone }, { success: true });
      }
      if (decision.blocker.top !== "none" && decision.blocker.p >= thr.blocker) {
        await journal?.append(redact({ ...stepRow, outcome: "needs_user" }, secretValues));
        const handOff = (await driver.handOff?.()) ?? null;
        handedOff = Boolean(driver.handOff);
        return await conclude(STATUS.needs_user, { blocker: decision.blocker.top, blockerProbability: decision.blocker.p, handOff, reason: `blocker "${decision.blocker.top}" detected; the user must intervene in the browser` });
      }

      const chosen = chooseAction({ decision, obs, meta, blocked: memory.blocked, tried: memory.tried, hash, allInputs, thr });
      if (!chosen || chosen.kind === "stop") {
        await journal?.append(redact({ ...stepRow, outcome: "stop", chosen }, secretValues));
        if (decision.goalDone >= thr.goalDoneFinal) {
          return await conclude(STATUS.success, { goalDoneProbability: decision.goalDone, reason: "model chose stop with the goal likely done" }, { success: true });
        }
        return await conclude(STATUS.stuck, { goalDoneProbability: decision.goalDone, reason: chosen ? "model judged that no listed action can make progress" : "every candidate action is blocked by memory" });
      }

      // Execute the chosen action.
      let actionError = null;
      try {
        await executeAction({ driver, chosen, obs, allInputs, client, goal, secretKeys, log });
      } catch (error) {
        actionError = error.message;
        log(`action failed: ${actionError}`);
      }
      await driver.settle();
      const nextObs = await observe();
      const changed = stateKey(nextObs) !== hash;
      memory.tried.add(`${hash}|${chosen.key}`);
      if (!changed || actionError) {
        memory.blocked.add(`${hash}|${chosen.key}`);
        memory.noChangeStreak += 1;
      } else {
        memory.noChangeStreak = 0;
      }
      lastAction = chosen.label;
      lastActionKey = chosen.key;
      memory.history.push({ step, url: obs.url, action: chosen.label, key: chosen.key, changed, error: actionError });
      await journal?.append(redact({ ...stepRow, chosen: { kind: chosen.kind, label: chosen.label, key: chosen.key }, changed, actionError, nextUrl: nextObs.url }, secretValues));
      onStep?.({ step, chosen, changed, obs: nextObs, decision });
      log(`  → ${chosen.label}${changed ? "" : " (no change)"}${actionError ? ` [error: ${actionError}]` : ""}`);

      if (memory.noChangeStreak >= thr.noChangeLimit) {
        obs = nextObs;
        return await conclude(STATUS.stuck, { reason: `${memory.noChangeStreak} consecutive actions produced no change` });
      }
      previous = obs;
      obs = nextObs;
    }

    // Out of steps: one last verification so a goal completed by the final action still counts.
    const { state, questions } = buildStepQuestions({ obs, goal, inputs: allInputs, secretKeys, previous, lastAction, stepsTaken: memory.history.length });
    const finalJudged = await client.systemOne({ state, questions: { goal_done: questions.goal_done } });
    const p = finalJudged.answers.goal_done.noul;
    await journal?.append(redact({ step: config.maxSteps + 1, ts: nowIso(), url: obs.url, finalCheck: true, goalDone: p }, secretValues));
    if (p >= thr.goalDoneFinal) {
      return await conclude(STATUS.success, { goalDoneProbability: p, reason: "goal verified on the final check" }, { success: true });
    }
    return await conclude(STATUS.max_steps, { goalDoneProbability: p, reason: `reached maxSteps=${config.maxSteps}` });
  } catch (error) {
    log(`error: ${error.message}`);
    return await conclude(STATUS.error, { error: redact(error.message, secretValues), errorCode: error.code ?? null });
  }
}

/** Never let a secret that was typed into the page travel back to the model or the journal. */
export function sanitizeObservation(obs, secretValues = []) {
  const values = secretValues.filter((v) => typeof v === "string" && v.length >= 3);
  if (values.length === 0) return obs;
  const scrub = (text) => (typeof text === "string" ? values.reduce((acc, v) => acc.split(v).join("[secret]"), text) : text);
  return {
    ...obs,
    title: scrub(obs.title),
    text: scrub(obs.text),
    dialog: scrub(obs.dialog),
    headings: (obs.headings ?? []).map((h) => ({ ...h, text: scrub(h.text) })),
    elements: (obs.elements ?? []).map((el) => ({ ...el, name: scrub(el.name), value: scrub(el.value), placeholder: scrub(el.placeholder) })),
  };
}

/**
 * Pick the first candidate action in model preference order that memory has not blocked,
 * preferring edges never tried from this state (so A→B→back→A does not repeat A→B forever).
 */
export function chooseAction({ decision, obs, meta, blocked, tried = new Set(), hash, allInputs, thr }) {
  const byId = new Map(obs.elements.map((el) => [el.id, el]));
  const candidates = [];
  const push = (c) => candidates.push(c);

  // Strong regression signal: prefer going back before anything else.
  if (decision.progress && meta.allowedActions.includes("go_back")) {
    const regressed = decision.progress.probabilities?.["0"] ?? 0;
    if (regressed >= thr.regressed) push({ kind: "go_back", key: "go_back", label: "went back (progress regressed)" });
  }

  for (const [action] of decision.actions) {
    switch (action) {
      case "click": {
        if (decision.clickTargets.length === 0) break;
        const best = decision.clickTargets[0][1];
        if (decision.clickNone > best) break; // the model prefers "none": clicking is not viable now
        for (const [id] of decision.clickTargets) {
          const el = byId.get(id);
          if (!el) continue;
          push({ kind: "click", id, key: `click:${elementFingerprint(el)}`, label: `clicked ${describeElement(el)}` });
        }
        break;
      }
      case "type": {
        if (decision.typeTargets.length === 0 || decision.typeValues.length === 0) break;
        if (decision.typeNone > decision.typeTargets[0][1] || decision.typeValueNone > decision.typeValues[0][1]) break;
        for (const [id] of decision.typeTargets) {
          const el = byId.get(id);
          if (!el) continue;
          for (const [inputKey] of decision.typeValues) {
            if (!(inputKey in allInputs)) continue;
            if (el.value && String(el.value) === String(allInputs[inputKey])) continue; // already filled
            push({ kind: "type", id, inputKey, submit: decision.submitAfterType >= 0.5, key: `type:${elementFingerprint(el)}:${inputKey}`, label: `typed inputs.${inputKey} into ${describeElement(el)}${decision.submitAfterType >= 0.5 ? " and pressed Enter" : ""}` });
          }
        }
        break;
      }
      case "select": {
        if (decision.selectTargets.length === 0 || decision.selectNone > decision.selectTargets[0][1]) break;
        for (const [id] of decision.selectTargets) {
          const el = byId.get(id);
          if (el) push({ kind: "select", id, key: `select:${elementFingerprint(el)}`, label: `changed ${describeElement(el)}` });
        }
        break;
      }
      case "navigate": {
        const keys = decision.navigateTargets.length ? decision.navigateTargets.map(([k]) => k) : meta.urlInputKeys;
        for (const key of keys) push({ kind: "navigate", url: String(allInputs[key]), key: `navigate:${key}`, label: `navigated to inputs.${key}` });
        break;
      }
      case "scroll_down":
      case "scroll_up":
        push({ kind: action, key: action, label: action === "scroll_down" ? "scrolled down" : "scrolled up" });
        break;
      case "go_back":
        push({ kind: "go_back", key: "go_back", label: "went back" });
        break;
      case "wait":
        push({ kind: "wait", key: "wait", label: "waited for the page" });
        break;
      case "stop":
        push({ kind: "stop", key: "stop", label: "stopped" });
        break;
      default:
        break;
    }
  }
  const open = candidates.filter((c) => !blocked.has(`${hash}|${c.key}`));
  // A top-ranked stop is the model saying "done or nothing helps": let the controller judge it now.
  if (open[0]?.kind === "stop" && decision.actions[0]?.[0] === "stop") return open[0];
  return open.find((c) => !tried.has(`${hash}|${c.key}`) && c.kind !== "stop") ?? open[0] ?? null;
}

async function executeAction({ driver, chosen, obs, allInputs, client, goal, secretKeys, log }) {
  switch (chosen.kind) {
    case "click":
      return driver.click(chosen.id, { label: chosen.label });
    case "type":
      return driver.type(chosen.id, String(allInputs[chosen.inputKey]), { submit: chosen.submit });
    case "select": {
      const element = obs.elements.find((el) => el.id === chosen.id);
      const { state, questions, optionValues } = buildSelectOptionQuestions({ obs, element, goal, inputs: allInputs, secretKeys });
      const judged = await client.systemOne({ state, questions });
      const top = judged.answers.option.top;
      if (!top || top === "none") throw new Error("no dropdown option fits the goal");
      const value = optionValues[Number(top.slice(3))];
      log(`  select option ${top} (${value})`);
      return driver.select(chosen.id, value);
    }
    case "navigate":
      return driver.navigate(chosen.url);
    case "scroll_down":
      return driver.scroll("down");
    case "scroll_up":
      return driver.scroll("up");
    case "go_back":
      return driver.back();
    case "wait":
      return driver.wait(1500);
    default:
      return sleep(0);
  }
}

function describeTargets(answers, obs) {
  const byId = new Map(obs.elements.map((el) => [el.id, el]));
  const out = {};
  for (const id of ["click_target", "type_target", "select_target"]) {
    for (const [key] of (answers[id]?.ranked ?? []).slice(0, 3)) {
      const el = byId.get(key);
      if (el) out[key] = describeElement(el);
    }
  }
  return out;
}

function compactAnswers(answers) {
  return Object.fromEntries(
    Object.entries(answers).map(([id, a]) => {
      if (a.type === "noul") return [id, { noul: round(a.noul) }];
      const top3 = Object.fromEntries((a.ranked ?? []).slice(0, 3).map(([k, p]) => [k, round(p)]));
      return [id, { top: a.top, confidence: a.confidence === null ? null : round(a.confidence), top3, ...(a.type === "score" ? { score: round(a.score) } : {}) }];
    }),
  );
}

const round = (n) => (typeof n === "number" ? Math.round(n * 1000) / 1000 : n);
