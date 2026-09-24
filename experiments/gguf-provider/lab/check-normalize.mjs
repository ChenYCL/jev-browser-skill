#!/usr/bin/env node
// EXPERIMENTAL — not part of the jev-browser skill.
// PROOF that a response produced by the local GGUF provider survives the skill's own
// contract check (`validateQuestions` + `normalizeAnswers` from lib/typesafe.mjs)
// UNCHANGED — no adapting, no re-shaping, no shim.
//
//   node experiments/gguf-provider/lab/check-normalize.mjs [--fixture ...] [--url ...]
import { PROGRESS_LEVELS } from "../../../skills/jev-browser/lib/questions.mjs";
import { validateQuestions, normalizeAnswers } from "../../../skills/jev-browser/lib/typesafe.mjs";
import { fileURLToPath } from "node:url";
import { GgufProvider } from "../lib/provider.mjs";
import { loadRequest } from "../cli.mjs";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const fixture = arg("--fixture", fileURLToPath(new URL("../fixtures/raw_duckduckgo_com_html__q_apple_stock_price.txt", import.meta.url)));

// A real captured step, plus the one question type the first step never asks:
// `progress` (score with PROGRESS_LEVELS) only appears once previous+lastAction exist.
const captured = loadRequest({ fixture });
const questions = {
  goal_done: captured.questions.goal_done,
  blocker: captured.questions.blocker,
  click_target: captured.questions.click_target,
  progress: {
    type: "score",
    instructions: { question: "Compared with `previous_page`, how did `last_action` change progress toward `goal`, judging by `page`?" },
    criteria: [...PROGRESS_LEVELS],
  },
};
const request = { state: captured.state, questions };

validateQuestions(questions); // throws if the question set itself violates the contract
console.log(`question set validated: ${Object.entries(questions).map(([id, q]) => `${id}[${q.type}]`).join(", ")}`);

const provider = new GgufProvider({ url: arg("--url", "http://127.0.0.1:8090"), model: arg("--model", "gguf-local") });
const response = await provider.systemOne(request);

console.log("\n--- raw provider response (answers only) ---");
console.log(JSON.stringify(response.answers, null, 2).slice(0, 3000));

const normalized = normalizeAnswers(response.answers, questions);
console.log("\n--- normalizeAnswers(...) output ---");
console.log(JSON.stringify(normalized, null, 2).slice(0, 3000));

// Invariants the controller relies on.
const checks = [];
for (const [id, q] of Object.entries(questions)) {
  const n = normalized[id];
  checks.push([`${id}: present`, !!n]);
  checks.push([`${id}: type === ${q.type}`, n?.type === q.type]);
  if (q.type === "noul") {
    checks.push([`${id}: 0<=noul<=1`, n.noul >= 0 && n.noul <= 1]);
    checks.push([`${id}: top is true|false`, n.top === "true" || n.top === "false"]);
    checks.push([`${id}: probabilities sum 1`, Math.abs(n.probabilities.true + n.probabilities.false - 1) < 1e-9]);
  } else {
    const expected = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    checks.push([`${id}: has every expected key`, expected.every((k) => k in n.probabilities)]);
    const sum = Object.values(n.probabilities).reduce((a, b) => a + b, 0);
    checks.push([`${id}: probabilities sum ~1 (${sum.toFixed(6)})`, Math.abs(sum - 1) < 1e-6]);
    checks.push([`${id}: ranked non-empty + sorted`, n.ranked.length > 0 && n.ranked.every((r, i, a) => i === 0 || a[i - 1][1] >= r[1])]);
    checks.push([`${id}: top === ranked[0][0]`, n.top === n.ranked[0][0]]);
  }
  if (q.type === "choice") checks.push([`${id}: choice is an option key`, Object.keys(q.criteria).includes(n.choice)]);
  if (q.type === "score") {
    checks.push([`${id}: score in [0, ${q.criteria.length - 1}]`, n.score >= 0 && n.score <= q.criteria.length - 1]);
    checks.push([`${id}: legend equals criteria`, JSON.stringify(n.legend) === JSON.stringify(q.criteria)]);
  }
}
const failed = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`} (${checks.length} checks)`);
process.exit(failed.length === 0 ? 0 : 1);
