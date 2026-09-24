#!/usr/bin/env node
// EXPERIMENTAL — not part of the jev-browser skill.
// Latency of one realistic controller step: the captured DuckDuckGo search page
// (5 questions, click_target has 55 options) through the local GGUF provider.
//
// Reports cold (first request: full prefill + alphabet verification) and warm runs,
// plus per-question readout time and the prefix-cache reuse llama.cpp reports.
//
//   node experiments/gguf-provider/lab/latency.mjs [--repeat 3] [--url http://127.0.0.1:8090]
import { GgufProvider } from "../lib/provider.mjs";
import { loadFixture } from "../eval/items.mjs";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const repeat = Number(arg("--repeat", 3));
const fixture = loadFixture(arg("--fixture", "raw_duckduckgo_com_html__q_apple_stock_price.txt"));
const provider = new GgufProvider({ url: arg("--url", "http://127.0.0.1:8090"), model: arg("--model", "gguf-local"), nProbs: Number(arg("--n-probs", 512)) });

const questionList = Object.keys(fixture.questions);
console.log(`# latency - ${fixture.state.page.url}`);
console.log(`questions: ${questionList.map((id) => `${id}(${fixture.questions[id].type === "choice" ? Object.keys(fixture.questions[id].criteria).length : fixture.questions[id].type})`).join(" ")}`);
console.log(`state bytes: ${JSON.stringify(fixture.state).length}`);

const runs = [];
for (let i = 0; i < repeat; i++) {
  const t0 = performance.now();
  const response = await provider.systemOne({ state: fixture.state, questions: fixture.questions });
  const wall = performance.now() - t0;
  const per = response.usage.per_question;
  runs.push({ run: i, wall_ms: Math.round(wall), ms_alpha: response.usage.ms_alpha, ms_readout: response.usage.ms_readout, input_tokens: response.usage.input_tokens, per });
  console.log(`\nrun ${i}${i === 0 ? " (cold: alphabet verification + full prefill)" : " (warm)"}: wall ${Math.round(wall)}ms  readout ${response.usage.ms_readout}ms  alphabet+render ${response.usage.ms_alpha + response.usage.ms_render}ms  input_tokens ${response.usage.input_tokens}`);
  for (const id of questionList) {
    const p = per[id];
    console.log(`   ${id.padEnd(14)} ${String(p.ms).padStart(6)}ms  new_tokens=${String(p.prompt_tokens).padStart(5)} cached=${String(p.cached_tokens).padStart(5)}  labels=${p.multi_token_labels.length ? `multi=${p.multi_token_labels}` : "all-single-token"}`);
  }
}

const warm = runs.slice(1);
if (warm.length) {
  const mean = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  console.log(`\nwarm mean wall: ${mean(warm.map((r) => r.wall_ms))}ms over ${warm.length} runs (cold included above for comparison)`);
  const tokens = runs[0].input_tokens;
  console.log(`input tokens per step: ${tokens}; cold wall ${runs[0].wall_ms}ms -> ${Math.round(tokens / (runs[0].wall_ms / 1000))} tok/s end-to-end`);
}
console.log(`\nprovider totals: ${JSON.stringify(provider.server.stats)}`);
