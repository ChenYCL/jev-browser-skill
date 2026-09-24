import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MIN_LABEL_MASS, handleLocalRequest, lowMassQuestions, readoutLabels } from "../lib/local.mjs";
import { normalizeAnswers } from "../lib/typesafe.mjs";

// A first-token distribution as llama.cpp reports it, for the five labels A..E:
// A and B are emitted (B through two token ids), C is a single-token label the model
// did not put any mass on, D is not a single token in the tokenizer (empty id list).
const distribution = [
  { id: 10, token: " A", logprob: Math.log(0.6) },
  { id: 11, token: " B", logprob: Math.log(0.25) },
  { id: 14, token: " B", logprob: Math.log(0.05) },
  { id: 99, token: " the", logprob: Math.log(0.1) },
];
const tokenIds = new Map([
  ["A", [10]],
  ["B", [11, 14]],
  ["C", [12]],
  ["D", []],
]);
const labels = ["A", "B", "C", "D"];
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);

function stubProvider(overrides = {}) {
  return {
    model: "stub-local",
    health: async () => true,
    systemOne: async ({ model }) => ({
      model,
      answers: {
        urgent: { type: "noul", noul: 0.82 },
        team: { type: "choice", probabilities: { billing: 0.7, shipping: 0.25, returns: 0.05 }, choice: "billing", confidence: 0.6 },
      },
      usage: { input_tokens: 123, output_tokens: 2, per_question: { urgent: { label_mass: 0.94 }, team: { label_mass: 0.88 } } },
      ...overrides,
    }),
  };
}

async function withServer(provider, fn) {
  const server = http.createServer((req, res) => void handleLocalRequest(req, res, provider));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("readoutLabels normalizes the mass on the option labels, reports what it could not read", () => {
  const read = readoutLabels(distribution, labels, tokenIds);

  close(read.total, 0.9, "captured label mass");
  assert.deepEqual(read.missing, ["C"], "labels whose token id was not in the distribution");
  assert.deepEqual(read.multiToken, ["D"], "labels that are not single tokens");
  close(read.raw.A, 0.6, "label A");
  close(read.raw.B, 0.3, "label B summed over its two token ids");
  close(Object.values(read.probabilities).reduce((a, b) => a + b, 0), 1, "probabilities sum to 1");
  close(read.probabilities.A, 0.6 / 0.9, "label A normalized");
  close(read.probabilities.B, 0.3 / 0.9, "label B normalized");
  assert.equal(read.probabilities.C, 0, "unread label keeps zero probability");
  assert.equal(read.probabilities.D, 0, "multi-token label keeps zero probability");
});

test("lowMassQuestions flags a question only when the readout missed most of the mass", () => {
  const response = { usage: { per_question: { a: { label_mass: 0.9 }, b: { label_mass: 0.31 }, c: { label_mass: 0.5 } } } };
  assert.deepEqual(lowMassQuestions(response), [{ id: "b", mass: 0.31 }]);
  assert.equal(MIN_LABEL_MASS, 0.5);
  assert.deepEqual(lowMassQuestions({ usage: {} }), []);
});

test("POST /v1/systemone answers with the shape the skill's client parses", async () => {
  const questions = {
    urgent: { type: "noul", instructions: "Does `ticket` need an urgent reply?" },
    team: { type: "choice", instructions: "Which team owns `ticket`?", criteria: { billing: "Billing", shipping: "Shipping", returns: "Returns" } },
  };
  await withServer(stubProvider(), async (base) => {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.status, "ok");
    assert.equal(health.service, "jev-local");

    const models = await (await fetch(`${base}/v1/models`)).json();
    assert.equal(models.models[0].name, "stub-local");

    const response = await fetch(`${base}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: { ticket: "My card was charged twice" }, questions }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.model, "stub-local");
    assert.equal(body.answers.urgent.type, "noul");
    assert.equal(body.answers.team.type, "choice");
    assert.equal(body.usage.input_tokens, 123);
    assert.ok(Number.isFinite(body.usage.ms_wall));

    // The client's own normalization must accept these answers untouched.
    const normalized = normalizeAnswers(body.answers, questions);
    assert.equal(normalized.urgent.top, "true");
    assert.equal(normalized.team.choice, "billing");
    assert.deepEqual(normalized.team.ranked, [["billing", 0.7], ["shipping", 0.25], ["returns", 0.05]]);
  });
});

test("POST /v1/systemone returns 422 naming the question when the label mass is too low", async () => {
  const provider = stubProvider({ usage: { input_tokens: 123, output_tokens: 2, per_question: { urgent: { label_mass: 0.94 }, team: { label_mass: 0.31 } } } });
  await withServer(provider, async (base) => {
    const response = await fetch(`${base}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: { ticket: "…" },
        questions: {
          urgent: { type: "noul", instructions: "Urgent?" },
          team: { type: "choice", instructions: "Which team?", criteria: { billing: "Billing", shipping: "Shipping" } },
        },
      }),
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, "LOW_LABEL_MASS");
    assert.match(body.error.message, /team/);
    assert.deepEqual(body.error.questions, [{ id: "team", mass: 0.31 }]);
  });
});
