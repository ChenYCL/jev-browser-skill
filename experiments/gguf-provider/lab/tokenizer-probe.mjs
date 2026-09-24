// EXPERIMENTAL — not part of the jev-browser skill.
// Tokenizer evidence: which answer labels are single tokens for the served GGUF,
// checked against llama-server's real tokenizer.
//
//   node experiments/gguf-provider/lab/tokenizer-probe.mjs [--url http://127.0.0.1:8090] [--count 128] [--json]
import { labelsFor } from "../lib/labels.mjs";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const url = arg("--url", "http://127.0.0.1:8090");
const COUNT = Number(arg("--count", 128));

const tokenize = async (content) => {
  const res = await fetch(`${url}/tokenize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`tokenize ${res.status}: ${await res.text()}`);
  return (await res.json()).tokens;
};

const labels = labelsFor(COUNT);
const rows = [];
for (const label of labels) {
  const bare = await tokenize(label);
  const spaced = await tokenize(` ${label}`);
  const newline = await tokenize(`\n${label}`);
  rows.push({ label, bare, spaced, newline });
}

const single = (tokens) => tokens.length === 1;
const report = {
  url,
  labels_probed: labels.length,
  bare_single_token: rows.filter((r) => single(r.bare)).length,
  space_prefixed_single_token: rows.filter((r) => single(r.spaced)).length,
  newline_prefixed_single_token: rows.filter((r) => single(r.newline)).length,
  not_single_token_space_prefixed: rows.filter((r) => !single(r.spaced)).map((r) => ({ label: r.label, tokens: r.spaced })),
  not_single_token_bare: rows.filter((r) => !single(r.bare)).map((r) => ({ label: r.label, tokens: r.bare })),
  sample: rows.slice(0, 3).concat(rows.slice(24, 30)),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`# label tokenization - ${url}`);
  console.log(`labels probed: ${report.labels_probed}`);
  console.log(`single token as " L": ${report.space_prefixed_single_token}  | bare "L": ${report.bare_single_token}  | "NL": ${report.newline_prefixed_single_token}`);
  console.log(`NOT single token (space-prefixed): ${JSON.stringify(report.not_single_token_space_prefixed)}`);
  console.log(`NOT single token (bare):          ${JSON.stringify(report.not_single_token_bare)}`);
  for (const r of report.sample) console.log(`  ${JSON.stringify(r.label)} -> " L":${JSON.stringify(r.spaced)} "L":${JSON.stringify(r.bare)}`);
}
