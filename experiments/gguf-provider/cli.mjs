#!/usr/bin/env node
// EXPERIMENTAL — not part of the jev-browser skill.
// Run one `/v1/systemone` request (or a captured `--dry-run` fixture) through the
// local GGUF provider and print the Jev-shaped response.
//
//   node experiments/gguf-provider/cli.mjs --fixture experiments/gguf-provider/fixtures/raw_duckduckgo.txt
//   node experiments/gguf-provider/cli.mjs --request request.json --url http://127.0.0.1:8090
//   node experiments/gguf-provider/cli.mjs --fixture ... --normalize   (also runs the skill's normalizeAnswers)
import { readFileSync } from "node:fs";
import { GgufProvider } from "./lib/provider.mjs";

const arg = (name, fallback = undefined) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const flag = (name) => process.argv.includes(name);

/** A `--dry-run` capture has a human preamble before the JSON body. */
export function loadRequest({ fixture, request }) {
  if (request) return JSON.parse(readFileSync(request, "utf8"));
  const raw = readFileSync(fixture, "utf8");
  const start = raw.indexOf("{");
  if (start < 0) throw new Error(`no JSON object found in ${fixture}`);
  const parsed = JSON.parse(raw.slice(start));
  if (!parsed.questions) throw new Error(`${fixture} does not contain a question set`);
  return { state: parsed.state, questions: parsed.questions, model: parsed.model };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = arg("--fixture");
  const request = arg("--request");
  if (!fixture && !request) {
    console.error("usage: cli.mjs --fixture <dry-run capture> | --request <systemone request json>");
    process.exit(2);
  }
  const body = loadRequest({ fixture, request });
  const provider = new GgufProvider({
    url: arg("--url", "http://127.0.0.1:8090"),
    model: arg("--model", "gguf-local"),
    ending: arg("--ending", "answer"),
    nProbs: Number(arg("--n-probs", 512)),
    verbose: flag("--verbose"),
  });
  const t0 = performance.now();
  const response = await provider.systemOne(body);
  const wallMs = performance.now() - t0;
  const out = { ...response, usage: { ...response.usage, wall_ms: Math.round(wallMs) } };

  if (flag("--normalize")) {
    const { normalizeAnswers } = await import("../../skills/jev-browser/lib/typesafe.mjs");
    out.normalized = normalizeAnswers(response.answers, body.questions);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
