#!/usr/bin/env node
// EXPERIMENTAL — not part of the jev-browser skill.
//
// Grade a Kev (/v1/systemone) server on the SAME 20 construction-graded items the local
// GGUF backend was measured on, plus the same real captured fixture step.
//
// The item set is reused verbatim from ../gguf-provider/eval/items.mjs (read-only import —
// nothing under eval/ is modified), and the request path is the skill's own client
// (skills/jev-browser/lib/typesafe.mjs), i.e. exactly the path hosted Jev used.
//
//   # Kev 0.8B (control row)
//   node ~/.local/share/jev-browser/kev/.venv/bin/python -m kev.serve --run jaredpalmer/kev-0.8b --port 8008
//   TYPESAFE_API_KEY=local node experiments/kev-4b/run.mjs
//
//   # Kev 4B (once its weights exist locally)
//   node ~/.local/share/jev-browser/kev/.venv/bin/python -m kev.serve --run jaredpalmer/kev-4b --port 8008
//   TYPESAFE_API_KEY=local node experiments/kev-4b/run.mjs --run jaredpalmer/kev-4b
//
// Options:
//   --base-url <url>     default http://127.0.0.1:8008
//   --model <name>       request/alias name                 default kev-latest
//   --run <hub-id>       checkpoint that MUST be served     default jaredpalmer/kev-0.8b
//   --label <slug>       result file/label slug             default: last path segment of --run
//   --out <dir>          result directory                   default results
//   --timeout <seconds>  per-call bound                     default 60
//   --set <all|browser|noul>
//   --no-fixture         skip the real captured fixture step
//   --json               dump the combined result to stdout
//
// Loud failure: before scoring anything, the runner reads GET /v1/models and refuses to
// run unless the served checkpoint equals --run. serve.py silently falls back to runs/smoke
// when a run id is not resolvable (see docs/local-kev-bringup.md, trap 7), so without this
// check a missing 4B checkpoint would be scored as whatever happens to be on the port.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BROWSER_ITEMS, NOUL_ITEMS, PROGRESS_ITEM, requestFor } from "../gguf-provider/eval/items.mjs";
import { TypeSafeClient } from "../../skills/jev-browser/lib/typesafe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "gguf-provider", "fixtures");

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const flag = (name) => process.argv.includes(name);

const BASE_URL = arg("--base-url", "http://127.0.0.1:8008");
const MODEL = arg("--model", "kev-latest");
const EXPECT_RUN = arg("--run", "jaredpalmer/kev-0.8b");
const LABEL = arg("--label", EXPECT_RUN.split("/").pop() || "kev");
const OUT = join(HERE, arg("--out", "results"));
const TIMEOUT_MS = Math.round(Number(arg("--timeout", "60")) * 1000);
const SET = arg("--set", "all");
const ONLY = arg("--only", null)?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const WITH_FIXTURE = !flag("--no-fixture");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// ---------------------------------------------------------------- answer analysis

const sum = (list) => list.reduce((a, b) => a + b, 0);
const entropyBits = (probs) => -sum(Object.values(probs).filter((p) => p > 0).map((p) => p * Math.log2(p)));

/** The option keys the question defines (choice criteria / score levels / noul sides). */
function optionKeys(question) {
  if (question.type === "noul") return ["true", "false"];
  if (question.type === "choice") return Object.keys(question.criteria);
  return question.criteria.map((_, i) => String(i));
}

const P_SUM_TOLERANCE = 1e-3;
const NEAR_UNIFORM_NORM = 0.95; // normalized entropy at/above this = the answer carries almost no preference
const COINFLIP_MARGIN = 0.05; // top1 - top2 at/below this = "almost a coin toss" (the click_target signature)
const NEAR_HALF = 0.05; // |p - 0.5| for a noul = pinned at chance

/**
 * Everything the brief asks to record per item: the returned probabilities, whether they sum
 * conventionally, and the degeneracy signature (near-uniform choice distribution, noul at chance).
 */
function analyzeAnswer(answer, question) {
  const keys = optionKeys(question);
  const n = keys.length;

  if (question.type === "noul") {
    const p = Number(answer.noul);
    const probabilities = { true: p, false: 1 - p };
    const H = entropyBits(probabilities);
    return {
      type: "noul",
      noul: p,
      probabilities,
      p_sum: p + (1 - p),
      p_sum_dev: 0,
      sums_conventionally: true,
      missing_keys: [],
      extra_keys: Object.keys(answer.probabilities ?? {}).filter((k) => !keys.includes(k)),
      n_options: n,
      top: p >= 0.5 ? "true" : "false",
      top_p: Math.max(p, 1 - p),
      margin: Math.abs(p - (1 - p)),
      entropy_bits: H,
      entropy_norm: H / Math.log2(n),
      dev_from_half: Math.abs(p - 0.5),
      near_half: Math.abs(p - 0.5) <= NEAR_HALF,
      pinned_high: p >= 0.8,
      confidence: typeof answer.confidence === "number" ? answer.confidence : null,
    };
  }

  const returned = answer.probabilities ?? {};
  const probabilities = {};
  for (const k of keys) probabilities[k] = Number(returned[k] ?? 0);
  const missing = keys.filter((k) => !(k in returned));
  const pSum = sum(Object.values(probabilities));
  const ranked = keys.map((k) => [k, probabilities[k]]).sort((a, b) => b[1] - a[1]);
  const H = entropyBits(probabilities);
  return {
    type: question.type,
    probabilities,
    p_sum: pSum,
    p_sum_dev: Math.abs(pSum - 1),
    sums_conventionally: Math.abs(pSum - 1) <= P_SUM_TOLERANCE,
    missing_keys: missing,
    extra_keys: Object.keys(returned).filter((k) => !keys.includes(k)),
    n_options: n,
    choice: answer.choice ?? ranked[0]?.[0] ?? null,
    reported_choice: answer.choice ?? null,
    choice_is_argmax: answer.choice == null ? null : answer.choice === (ranked[0]?.[0] ?? null),
    score: question.type === "score" ? answer.score : undefined,
    top: ranked[0]?.[0] ?? null,
    top_p: ranked[0]?.[1] ?? null,
    second_p: ranked[1]?.[1] ?? null,
    margin: ranked.length > 1 ? ranked[0][1] - ranked[1][1] : null,
    entropy_bits: H,
    entropy_norm: H / Math.log2(n),
    near_uniform: n >= 3 && H / Math.log2(n) >= NEAR_UNIFORM_NORM,
    coinflip_margin: ranked.length > 1 && ranked[0][1] - ranked[1][1] <= COINFLIP_MARGIN,
    confidence: typeof answer.confidence === "number" ? answer.confidence : null,
  };
}

function grade(answer, expected) {
  if (typeof expected === "boolean") {
    const p = Number(answer?.noul);
    if (!Number.isFinite(p)) return { predicted: null, correct: false, detail: `malformed noul answer: ${JSON.stringify(answer)}` };
    const predicted = p >= 0.5;
    return { predicted, correct: predicted === expected, detail: `P(yes)=${p.toFixed(4)}` };
  }
  if (typeof expected === "number") {
    const probs = answer?.probabilities ?? {};
    if (!Number.isFinite(Number(answer?.score))) return { predicted: null, correct: false, detail: `malformed score answer: ${JSON.stringify(answer)}` };
    const ps = Object.entries(probs).map(([k, p]) => `${k}:${Number(p).toFixed(2)}`).join(" ");
    return { predicted: answer.score, correct: Math.abs(answer.score - expected) <= 0.5, detail: `score=${Number(answer.score).toFixed(3)} p=[${ps}]` };
  }
  const probs = answer?.probabilities ?? {};
  const predicted = answer?.choice ?? null;
  const pCorrect = Number(probs[expected] ?? 0);
  return { predicted, correct: predicted === expected, detail: `choice=${predicted} P(correct)=${pCorrect.toFixed(4)}` };
}

const stateMeta = (state) => ({
  bytes: Buffer.byteLength(JSON.stringify(state)),
  page_url: state?.page?.url ?? null,
  elements: state?.page?.elements?.length ?? null,
  visible_text_chars: state?.page?.visible_text?.length ?? null,
});

// ---------------------------------------------------------------- client with raw capture

/** Wrap fetch so the untouched /v1/systemone response body is kept (server latency_ms, usage, answers). */
function captureFetch(sink) {
  return async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).endsWith("/v1/systemone")) return response;
    const text = await response.text();
    try {
      sink.push({ http_status: response.status, body: JSON.parse(text) });
    } catch {
      sink.push({ http_status: response.status, body: null, raw_text: text.slice(0, 400) });
    }
    return new Response(text, { status: response.status, headers: response.headers });
  };
}

// ---------------------------------------------------------------- items

const items = [];
if (SET === "all" || SET === "browser") items.push(...BROWSER_ITEMS.map((i) => ({ ...i, kind: "browser" })), { ...PROGRESS_ITEM, kind: "browser" });
if (SET === "all" || SET === "noul") items.push(...NOUL_ITEMS.map((i) => ({ ...i, kind: "noul" })));
const ACTION_CLICK = new Set(["action", "click_target"]);
const selected = ONLY ? items.filter((i) => ONLY.includes(i.id)) : items;
if (ONLY && selected.length !== ONLY.length) {
  const known = new Set(items.map((i) => i.id));
  die(`--only names unknown item(s): ${ONLY.filter((id) => !known.has(id)).join(", ")}`);
}

const fixtures = {};
const captured = [];
const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY ?? "local",
  baseUrl: BASE_URL,
  model: MODEL,
  timeoutMs: TIMEOUT_MS,
  maxRetries: 0, // the per-call bound is the bound; no retry loops past it
  cache: false,
  fetchImpl: captureFetch(captured),
});

function die(message, details) {
  console.error(`\n✖ ${message}`);
  if (details) console.error(details);
  process.exit(2);
}

// ---------------------------------------------------------------- preflight (loud)

const serveCmd = (run, port = 8008) =>
  `~/.local/share/jev-browser/kev/.venv/bin/python -m kev.serve --run ${run} --port ${port}`;

let cards;
try {
  cards = await client.models();
} catch (error) {
  die(
    `Kev server not reachable at ${BASE_URL} (${error?.code ?? error?.message}).`,
    `Start it with:\n  cd ~/.local/share/jev-browser/kev\n  ${serveCmd(EXPECT_RUN)}\n` +
      `(the venv python is ~/.local/share/jev-browser/kev/.venv/bin/python; --host does not exist, the host is always 127.0.0.1)`,
  );
}

const models = cards.models ?? cards.data ?? [];
const names = models.map((m) => m.name);
if (!names.includes(MODEL)) {
  die(`the server at ${BASE_URL} does not serve model "${MODEL}" (it serves: ${names.join(", ") || "nothing"}).`);
}
const served = models.find((m) => m.name === MODEL);
if (served.run !== EXPECT_RUN) {
  die(
    `served checkpoint is "${served.run}", but --run asked for "${EXPECT_RUN}".`,
    `Refusing to score a different checkpoint (serve.py silently falls back to runs/smoke when a run id is\n` +
      `not resolvable). Serve the requested checkpoint first:\n  ${serveCmd(EXPECT_RUN)}`,
  );
}

console.log(`kev-bench ${LABEL}: ${BASE_URL} model=${MODEL} run=${served.run}`);
console.log(`  base=${served.base ?? "?"} lora=${served.lora ?? "?"} device=${served.device ?? "?"} backend=${served.backend ?? "?"} dtype=${served.dtype ?? "?"} temperature=${served.temperature ?? "?"}`);
console.log(`  items=${selected.length} fixture_step=${WITH_FIXTURE} timeout=${TIMEOUT_MS / 1000}s out=${OUT}`);

// ---------------------------------------------------------------- run

const rows = [];
let aborted = null;

for (const item of selected) {
  const { state, questions, graded, expect } = requestFor(item, fixtures);
  const question = questions[graded];
  let result = null;
  let error = null;
  try {
    result = await client.systemOne({ state, questions });
  } catch (err) {
    error = err;
  }
  const raw = captured[captured.length - 1]?.body ?? null;

  if (error) {
    const timeout = error?.code === "TIMEOUT";
    rows.push({
      id: item.id,
      kind: item.kind,
      question: graded,
      type: question.type,
      expected: String(expect),
      predicted: null,
      correct: false,
      got: `${error.code ?? "ERROR"}: ${error.message}`,
      ms: timeout ? TIMEOUT_MS : null,
      timeout,
      error: `${error.code ?? "ERROR"}: ${error.message}`,
      analysis: null,
    });
    console.error(`${timeout ? "TIME" : "ERR "} ${item.id} (${graded}) ${error.code ?? ""} ${error.message}`);
    if (timeout) {
      aborted = { at: item.id, reason: `single item exceeded the ${TIMEOUT_MS / 1000}s bound`, ms: TIMEOUT_MS };
      break;
    }
    continue;
  }

  const answer = result.raw?.[graded] ?? {};
  const analysis = analyzeAnswer(answer, question);
  const { predicted, correct, detail } = grade(answer, expect);
  const row = {
    id: item.id,
    kind: item.kind,
    question: graded,
    type: question.type,
    expected: String(expect),
    predicted: String(predicted),
    correct,
    got: detail,
    ms: result.ms,
    server_latency_ms: raw?.latency_ms ?? null,
    usage: result.usage,
    model_echo: result.model,
    analysis,
    request: { state: stateMeta(state), questions: { [graded]: question } },
    response_answers: raw?.answers ?? null,
  };
  rows.push(row);
  console.log(`${correct ? "ok  " : "MISS"} ${item.id.padEnd(30)} ${graded.padEnd(16)} ${detail} ${result.ms}ms H=${analysis.entropy_norm.toFixed(3)} Σp=${analysis.p_sum.toFixed(4)}`);
}

// ---------------------------------------------------------------- fixture step

let fixtureStep = null;
if (WITH_FIXTURE && !aborted) {
  const state = readJson(join(FIXTURES, "judge-state.json"));
  const questions = readJson(join(FIXTURES, "judge-questions.json"));
  const analyzeAll = (result) =>
    Object.fromEntries(Object.entries(questions).map(([qid, question]) => [qid, { ...analyzeAnswer(result.raw?.[qid] ?? {}, question), question_type: question.type }]));

  fixtureStep = { label: LABEL, state: stateMeta(state), questions: Object.keys(questions) };
  try {
    // The same packed step the GGUF candidates were measured on.
    const result = await client.systemOne({ state, questions });
    const raw = captured[captured.length - 1]?.body ?? null;
    const perQuestion = analyzeAll(result);
    Object.assign(fixtureStep, {
      packed: true,
      ms: result.ms,
      server_latency_ms: raw?.latency_ms ?? null,
      usage: result.usage,
      model_echo: result.model,
      answers: raw?.answers ?? null,
      per_question: perQuestion,
      click_target_pick: perQuestion.click_target?.top ?? null,
      goal_done_noul: perQuestion.goal_done?.noul ?? null,
    });
    console.log(
      `fixture step (packed): ${result.ms}ms click_target=${fixtureStep.click_target_pick} goal_done=${fixtureStep.goal_done_noul?.toFixed(4)} ` +
        `action=${perQuestion.action?.top} blocker=${perQuestion.blocker?.top} Σp(click_target)=${perQuestion.click_target?.p_sum.toFixed(4)}`,
    );
  } catch (error) {
    // Kev's row limit (state + one branch <= SERVE_MAX_BRANCH = 8192, kev/model.py) refuses the packed
    // step because the 100-candidate click_target branch alone is ~4.7k tokens on a ~6.4k-token state.
    // Fall back to one question per pass so the rest of the step is still measured (the state prefix is cached).
    Object.assign(fixtureStep, { packed: false, error: `${error.code ?? "ERROR"}: ${error.message}`, per_question_fallback: {} });
    console.error(`fixture step (packed) refused: ${error.code ?? ""} ${error.message}`);
    for (const [qid, question] of Object.entries(questions)) {
      try {
        const result = await client.systemOne({ state, questions: { [qid]: question } });
        const raw = captured[captured.length - 1]?.body ?? null;
        fixtureStep.per_question_fallback[qid] = {
          answered: true,
          ms: result.ms,
          server_latency_ms: raw?.latency_ms ?? null,
          answer: raw?.answers?.[qid] ?? null,
          analysis: analyzeAnswer(result.raw?.[qid] ?? {}, question),
        };
      } catch (e) {
        fixtureStep.per_question_fallback[qid] = { answered: false, error: `${e.code ?? "ERROR"}: ${e.message}` };
      }
      const f = fixtureStep.per_question_fallback[qid];
      console.log(`  fixture/${qid.padEnd(16)} ${f.answered ? `${f.ms}ms top=${f.analysis.top ?? f.analysis.noul?.toFixed(4)} H=${f.analysis.entropy_norm.toFixed(3)} Σp=${f.analysis.p_sum.toFixed(4)}` : `REFUSED ${f.error}`}`);
    }
    const gd = fixtureStep.per_question_fallback.goal_done;
    fixtureStep.goal_done_noul = gd?.answered ? gd.analysis.noul : null;
    const ct = fixtureStep.per_question_fallback.click_target;
    fixtureStep.click_target_pick = ct?.answered ? ct.analysis.top : null;
  }
}

// ---------------------------------------------------------------- summary

const summaryOf = (list) => ({
  n: list.length,
  correct: list.filter((r) => r.correct).length,
  accuracy: list.length ? Number((list.filter((r) => r.correct).length / list.length).toFixed(3)) : null,
});
const byOf = (key, list) => Object.fromEntries([...new Set(list.map((r) => r[key]))].map((k) => [k, summaryOf(list.filter((r) => r[key] === k))]));

const gradedRows = rows.filter((r) => !r.error);
const ms = gradedRows.map((r) => r.ms).sort((a, b) => a - b);
const choiceish = gradedRows.filter((r) => r.analysis && r.analysis.type !== "noul");
const noulRows = gradedRows.filter((r) => r.analysis && r.analysis.type === "noul");
const pSums = choiceish.map((r) => r.analysis.p_sum);
const noulTrue = noulRows.filter((r) => r.expected === "true").map((r) => r.analysis.noul);
const noulFalse = noulRows.filter((r) => r.expected === "false").map((r) => r.analysis.noul);
const mean = (list) => (list.length ? Number((sum(list) / list.length).toFixed(4)) : null);

const result = {
  label: LABEL,
  model: MODEL,
  provider: `kev (${BASE_URL})`,
  served: { run: served.run, base: served.base, device: served.device, backend: served.backend, dtype: served.dtype, temperature: served.temperature },
  items: {
    all: summaryOf(rows),
    graded: summaryOf(gradedRows),
    browser: summaryOf(rows.filter((r) => r.kind === "browser")),
    noul: summaryOf(rows.filter((r) => r.kind === "noul")),
    action_click: summaryOf(rows.filter((r) => ACTION_CLICK.has(r.question))),
  },
  by_question: byOf("question", rows),
  unanswerable: rows.filter((r) => r.error).map((r) => ({ id: r.id, kind: r.kind, question: r.question, error: r.error })),
  latency_ms: {
    mean: ms.length ? Math.round(sum(ms) / ms.length) : null,
    median: ms[Math.floor(ms.length / 2)] ?? null,
    max: ms[ms.length - 1] ?? null,
    total: sum(ms),
  },
  probabilities: {
    answers_checked: pSums.length,
    sum_mean: mean(pSums),
    sum_min: pSums.length ? Number(Math.min(...pSums).toFixed(6)) : null,
    sum_max: pSums.length ? Number(Math.max(...pSums).toFixed(6)) : null,
    deviations_gt_tolerance: choiceish.filter((r) => !r.analysis.sums_conventionally).map((r) => ({ id: r.id, p_sum: r.analysis.p_sum })),
    near_uniform: choiceish.filter((r) => r.analysis.near_uniform).map((r) => ({ id: r.id, n_options: r.analysis.n_options, entropy_norm: r.analysis.entropy_norm })),
    coinflip_margin: choiceish.filter((r) => r.analysis.coinflip_margin).map((r) => ({ id: r.id, margin: r.analysis.margin })),
    missing_keys: gradedRows.filter((r) => r.analysis?.missing_keys?.length).map((r) => ({ id: r.id, keys: r.analysis.missing_keys })),
  },
  noul: {
    values: noulRows.map((r) => ({ id: r.id, kind: r.kind, expected: r.expected, noul: r.analysis.noul, predicted: r.predicted, correct: r.correct, dev_from_half: r.analysis.dev_from_half, near_half: r.analysis.near_half })),
    mean_true: mean(noulTrue),
    mean_false: mean(noulFalse),
    separation: noulTrue.length && noulFalse.length ? Number((sum(noulTrue) / noulTrue.length - sum(noulFalse) / noulFalse.length).toFixed(4)) : null,
    by_kind: Object.fromEntries(
      [...new Set(noulRows.map((r) => r.kind))].map((kind) => {
        const group = noulRows.filter((r) => r.kind === kind);
        const t = group.filter((r) => r.expected === "true").map((r) => r.analysis.noul);
        const f = group.filter((r) => r.expected === "false").map((r) => r.analysis.noul);
        return [kind, { n: group.length, mean_true: mean(t), mean_false: mean(f), separation: t.length && f.length ? Number((sum(t) / t.length - sum(f) / f.length).toFixed(4)) : null }];
      }),
    ),
    near_half_count: noulRows.filter((r) => r.analysis.near_half).length,
    entropy_norm_mean: mean(noulRows.map((r) => r.analysis.entropy_norm)),
  },
  fixture_step: fixtureStep,
  aborted,
  rows,
};

mkdirSync(join(OUT, "raw", LABEL), { recursive: true });
for (const row of rows) writeFileSync(join(OUT, "raw", LABEL, `${row.id}.json`), `${JSON.stringify(row, null, 2)}\n`);
if (fixtureStep) writeFileSync(join(OUT, `fixture-step-${LABEL}.json`), `${JSON.stringify(fixtureStep, null, 2)}\n`);
writeFileSync(join(OUT, `eval-${LABEL}.json`), `${JSON.stringify(result, null, 2)}\n`);

console.log("");
console.log(`all ${result.items.all.correct}/${result.items.all.n} = ${result.items.all.accuracy}   browser ${result.items.browser.correct}/${result.items.browser.n}   noul ${result.items.noul.correct}/${result.items.noul.n}   action+click ${result.items.action_click.correct}/${result.items.action_click.n}`);
console.log(`latency ms mean=${result.latency_ms.mean} max=${result.latency_ms.max}`);
console.log(`Σp checked=${result.probabilities.answers_checked} mean=${result.probabilities.sum_mean} min=${result.probabilities.sum_min} max=${result.probabilities.sum_max} violations=${result.probabilities.deviations_gt_tolerance.length}`);
console.log(`choice/score near-uniform=${result.probabilities.near_uniform.length} coinflip-margin=${result.probabilities.coinflip_margin.length}`);
console.log(`noul mean(true)=${result.noul.mean_true} mean(false)=${result.noul.mean_false} separation=${result.noul.separation} at-chance=${result.noul.near_half_count}/${result.noul.values.length}`);
if (aborted) console.log(`ABORTED: ${aborted.reason} (at ${aborted.at})`);
if (flag("--json")) console.log(`\n${JSON.stringify(result, null, 2)}`);
