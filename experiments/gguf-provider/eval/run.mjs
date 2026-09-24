#!/usr/bin/env node
// EXPERIMENTAL — not part of the jev-browser skill.
// Honest accuracy eval of the local GGUF readout provider on items whose ground truth
// is known by construction (see items.mjs).
//
//   node experiments/gguf-provider/eval/run.mjs                       # all graded items
//   node experiments/gguf-provider/eval/run.mjs --set noul
//   node experiments/gguf-provider/eval/run.mjs --rotate              # label-permutation test
//   node experiments/gguf-provider/eval/run.mjs --json > result.json
import { BROWSER_ITEMS, NOUL_ITEMS, SPECULATIVE_ITEMS, PROGRESS_ITEM, requestFor } from "./items.mjs";
import { GgufProvider } from "../lib/provider.mjs";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const flag = (name) => process.argv.includes(name);

const SET = arg("--set", "all");
const ROTATE_KS = arg("--rotate-ks", "0,3,7").split(",").map(Number);
const ROTATE_ONLY = arg("--rotate-only", null); // restrict to one item id, and skip graded rows
const provider = new GgufProvider({
  url: arg("--url", "http://127.0.0.1:8090"),
  model: arg("--model", "gguf-local"),
  ending: arg("--ending", "answer"),
  verbose: flag("--verbose"),
});

const fixtures = {};

/**
 * Rotate a choice question's option list (content moves, labels stay) and rebuild the
 * state's element list to match — the check for "did it read the option, or just the label A".
 */
function rotateRequest(item, k) {
  const { state, questions, graded } = requestFor(item, fixtures);
  const question = questions[graded];
  if (question.type !== "choice") throw new Error(`rotation only applies to choice questions (${item.id})`);
  const entries = Object.entries(question.criteria);
  const options = entries.filter(([key]) => key !== "none");
  const tail = entries.filter(([key]) => key === "none");
  const shift = ((k % options.length) + options.length) % options.length;
  const ordered = [...options.slice(shift), ...options.slice(0, shift), ...tail];

  const criteria = {};
  const keyMap = new Map();
  ordered.forEach(([oldKey, description], i) => {
    const key = `e${i + 1}`;
    criteria[key] = description;
    keyMap.set(oldKey, key);
  });
  const elements = ordered
    .filter(([oldKey]) => oldKey !== "none")
    .map(([, description], i) => ({ id: `e${i + 1}`, description, in_viewport: true }));

  return {
    state: { ...state, page: { ...state.page, elements } },
    questions: { [graded]: { ...question, criteria } },
    graded,
    expect: keyMap.get(item.expect[graded]) ?? item.expect[graded],
  };
}

function grade(answer, expected) {
  if (typeof expected === "boolean") {
    const predicted = answer.noul >= 0.5;
    return { predicted, correct: predicted === expected, detail: `P(yes)=${answer.noul.toFixed(4)}` };
  }
  if (typeof expected === "number") {
    const probs = Object.values(answer.probabilities).map((p) => p.toFixed(2)).join(",");
    return { predicted: answer.score, correct: Math.abs(answer.score - expected) <= 0.5, detail: `score=${answer.score.toFixed(3)} p=[${probs}]` };
  }
  return { predicted: answer.choice, correct: answer.choice === expected, detail: `choice=${answer.choice} P(correct)=${(answer.probabilities[expected] ?? 0).toFixed(4)}` };
}

const items = [];
if (SET === "all" || SET === "browser") items.push(...BROWSER_ITEMS.map((i) => ({ ...i, kind: "browser" })), { ...PROGRESS_ITEM, kind: "browser" });
if (SET === "all" || SET === "noul") items.push(...NOUL_ITEMS.map((i) => ({ ...i, kind: "noul" })));
if (SET === "speculative") items.push(...SPECULATIVE_ITEMS.map((i) => ({ ...i, kind: "speculative" })));

const rows = [];
for (const item of ROTATE_ONLY ? [] : items) {
  const { state, questions, graded, expect } = requestFor(item, fixtures);
  const t0 = performance.now();
  const response = await provider.systemOne({ state, questions });
  const ms = performance.now() - t0;
  const answer = response.answers[graded];
  const expected = expect;
  const { predicted, correct, detail } = grade(answer, expected);
  const detailRow = response.usage.per_question[graded];
  rows.push({
    id: item.id,
    kind: item.kind,
    question: graded,
    type: questions[graded].type,
    expected: String(expected),
    predicted: String(predicted),
    got: detail,
    correct,
    ms: Math.round(ms),
    label_mass: detailRow.label_mass,
    multi_token_labels: detailRow.multi_token_labels,
    missing_labels: detailRow.missing_labels,
    confidence: answer.confidence ?? null,
  });
  process.stderr.write(`${correct ? "ok  " : "MISS"} ${item.id} (${graded}) ${detail} ${Math.round(ms)}ms\n`);
}

let rotations = null;
if (flag("--rotate")) {
  rotations = [];
  const rotateItems = items.filter((i) => Object.keys(i.expect)[0] === "click_target" && (!ROTATE_ONLY || i.id === ROTATE_ONLY));
  for (const item of rotateItems) {
    for (const k of ROTATE_KS) {
      const r = rotateRequest(item, k);
      const response = await provider.systemOne({ state: r.state, questions: r.questions });
      const answer = response.answers[r.graded];
      const correct = answer.choice === r.expect;
      rotations.push({ id: item.id, rotation: k, expected: r.expect, got: answer.choice, correct, p_correct: answer.probabilities[r.expect] ?? 0 });
      process.stderr.write(`${correct ? "ok  " : "MISS"} rotate ${item.id} k=${k} -> ${answer.choice} (want ${r.expect})\n`);
    }
  }
}

const summary = (list) => ({ n: list.length, correct: list.filter((r) => r.correct).length, accuracy: list.length ? Number((list.filter((r) => r.correct).length / list.length).toFixed(3)) : null });
const by = (key) => Object.fromEntries([...new Set(rows.map((r) => r[key]))].map((k) => [k, summary(rows.filter((r) => r[key] === k))]));
const latencies = rows.map((r) => r.ms).sort((a, b) => a - b);

const result = {
  model: provider.model,
  ending: provider.ending,
  items: rows.length,
  overall: summary(rows),
  by_question: by("question"),
  by_kind: by("kind"),
  latency_ms: {
    total: latencies.reduce((a, b) => a + b, 0),
    mean: Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)),
    median: latencies[Math.floor(latencies.length / 2)] ?? null,
    max: latencies[latencies.length - 1] ?? null,
  },
  rows,
  rotations,
};

if (flag("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const r of rows) console.log(`${r.correct ? "PASS" : "FAIL"}  ${r.id.padEnd(30)} ${r.question.padEnd(18)} want=${r.expected.padEnd(6)} got=${r.predicted.padEnd(6)} ${r.got}`);
  console.log(`\noverall: ${result.overall.correct}/${result.overall.n} = ${result.overall.accuracy}`);
  console.log(`by kind:     ${JSON.stringify(result.by_kind)}`);
  console.log(`by question: ${JSON.stringify(result.by_question)}`);
  console.log(`latency ms:  ${JSON.stringify(result.latency_ms)}`);
  if (rotations) console.log(`rotations:   ${rotations.filter((r) => r.correct).length}/${rotations.length} followed the content`);
}
