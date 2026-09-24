#!/usr/bin/env node
// EXPERIMENTAL — not part of the jev-browser skill.
// Is the noul readout reading the state, or just picking label A?
//
// Each item is run under several prompt variants. If a variant answers the same label
// whatever the item says — and in particular if swapping which option text sits under
// label A does not move the answer — that variant is measuring a label prior, not
// comprehension.
//
//   node experiments/gguf-provider/lab/probe-noul-bias.mjs
import { LlamaServer, readoutLabels } from "../lib/readout.mjs";
import { renderPrompts, labelTokenIds, optionsFor } from "../lib/render.mjs";
import { NOUL_ITEMS, loadFixture } from "../eval/items.mjs";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const server = new LlamaServer({ url: arg("--url", "http://127.0.0.1:8090"), nProbs: 512 });
const labels = ["A", "B"];
const tokenIds = await labelTokenIds(server, labels, { surface: "spaced" });

const POS = "The passage states this.";
const NEG = "The passage does not state this.";

const STRICT_SYSTEM =
  "You are an expert classification model. You read a state carefully and answer one question about it. " +
  "You never answer by position or habit: you compare the option texts against the state and choose the option whose text is actually true. " +
  "You always answer with the label letter of exactly one option, and nothing else.";

const FEW_SHOT = [
  "Worked example (different state, different question, different answer):",
  'State: {"passage": "Cats are mammals."}',
  "Question: Are cats reptiles?",
  "The passage speaks of mammals and does not speak of reptiles, so the correct option is the one saying the state does not say this.",
  "Correct choice: the option whose text is 'The passage does not state this.'",
].join("\n");

// A real browser state, with two noul questions whose answers are known by inspection:
// the DuckDuckGo results page shows no price, and it does have a search field.
const ddg = loadFixture("raw_duckduckgo_com_html__q_apple_stock_price.txt");
const BROWSER_NOUL = [
  { id: "ddg-shows-price?", state: ddg.state, question: "Does `page` show the price of AAPL?", expect: false, why: "visible_text of the captured state contains no price at all." },
  { id: "ddg-has-textbox?", state: ddg.state, question: "Does `page` contain a text field?", expect: true, why: "e3 is the search field 'q'." },
];

const variants = [
  { name: "v1-baseline", swap: false, system: undefined, fewShot: null },
  { name: "v2-Atext-swapped", swap: true, system: undefined, fewShot: null },
  { name: "v3-strict-system", swap: false, system: STRICT_SYSTEM, fewShot: null },
  { name: "v4-strict+fewshot", swap: false, system: STRICT_SYSTEM, fewShot: FEW_SHOT },
  { name: "v5-fewshot-only", swap: false, system: undefined, fewShot: FEW_SHOT },
];

const summary = [];
for (const variant of variants) {
  const rows = [];
  for (const item of [...NOUL_ITEMS, ...BROWSER_NOUL]) {
    const state = item.passage !== undefined ? { passage: item.passage } : item.state;
    const question = {
      type: "noul",
      instructions: { question: item.question, rules: ["Answer only from the state."] },
      criteria: variant.swap ? { true: NEG, false: POS } : { true: POS, false: NEG },
    };
    const { prompts } = await renderPrompts({ server, state, questions: { answer: question }, labels, ending: "answer", system: variant.system, fewShot: variant.fewShot });
    const dist = await server.firstTokenDistribution(prompts.answer);
    const read = readoutLabels(dist.candidates, labels, tokenIds);
    const options = optionsFor(question); // label order: options[0] is label A
    const pickedIndex = read.probabilities.A >= read.probabilities.B ? 0 : 1;
    const pickedText = options[pickedIndex].text;
    const predicted = pickedText === POS; // does the model say "the state states this"?
    rows.push({
      id: item.id,
      kind: item.passage !== undefined ? "passage" : "browser",
      expect: item.expect,
      pickedLabel: labels[pickedIndex],
      pickedText: pickedText === POS ? "STATES" : "NOT-STATE",
      predicted,
      correct: predicted === item.expect,
      pA: Number(read.probabilities.A.toFixed(4)),
      ms: Math.round(dist.ms),
    });
  }
  const correct = rows.filter((r) => r.correct).length;
  const aPicks = rows.filter((r) => r.pickedLabel === "A").length;
  summary.push({ variant: variant.name, correct, n: rows.length, labelA_picks: aPicks });
  console.log(`\n=== ${variant.name}: ${correct}/${rows.length} correct, picked label A ${aPicks}/${rows.length} times ===`);
  for (const r of rows) console.log(`   ${r.correct ? "ok  " : "MISS"} ${r.id.padEnd(18)} [${r.kind.padEnd(7)}] expect=${String(r.expect).padEnd(6)} picked=${r.pickedLabel}(${r.pickedText}) P(A)=${r.pA} ${r.ms}ms`);
}
console.log("\nsummary:", JSON.stringify(summary, null, 1));
