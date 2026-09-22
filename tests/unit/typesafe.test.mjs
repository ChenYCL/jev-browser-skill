import test from "node:test";
import assert from "node:assert/strict";
import { TypeSafeClient, TypeSafeError, validateQuestions, normalizeAnswers, estimateCostUsd } from "../../skills/jev-browser/lib/typesafe.mjs";
import { createMockTypeSafe } from "../helpers/mock-typesafe.mjs";

test("validateQuestions enforces documented limits", () => {
  assert.throws(() => validateQuestions({}), /at least one/);
  assert.throws(() => validateQuestions({ q: { type: "choice", instructions: "x", criteria: { a: null } } }), /2\.\.255/);
  assert.throws(() => validateQuestions({ q: { type: "score", instructions: "x", criteria: ["only"] } }), /2\.\.10/);
  assert.throws(() => validateQuestions({ q: { type: "noul", instructions: "x", criteria: { maybe: "?" } } }), /true\/false/);
  validateQuestions({ q: { type: "noul", instructions: "x" }, c: { type: "choice", instructions: "y", criteria: { a: "A", b: "B" } } });
});

test("normalizeAnswers fills missing probabilities and ranks", () => {
  const questions = { n: { type: "noul", instructions: "x" }, c: { type: "choice", instructions: "y", criteria: { a: "A", b: "B", none: "N" } }, s: { type: "score", instructions: "z", criteria: ["lo", "hi"] } };
  const out = normalizeAnswers({ n: { type: "noul", noul: 0.8 }, c: { type: "choice", choice: "b", probabilities: { b: 0.7, a: 0.3 }, confidence: 0.6 }, s: { type: "score", score: 0.9, probabilities: { 0: 0.1, 1: 0.9 }, legend: { 0: "lo", 1: "hi" } } }, questions);
  assert.equal(out.n.top, "true");
  assert.deepEqual(out.c.ranked, [["b", 0.7], ["a", 0.3], ["none", 0]]);
  assert.equal(out.c.top, "b");
  assert.equal(out.s.top, "1");
  assert.throws(() => normalizeAnswers({ n: { type: "choice" } }, { n: questions.n }), TypeSafeError);
});

test("estimateCostUsd uses input tokens only", () => {
  assert.equal(estimateCostUsd(1_000_000), 0.042);
  assert.equal(estimateCostUsd(undefined), 0);
});

test("client posts to /v1/systemone, retries on 429, caches identical requests", async () => {
  let calls = 0;
  const mock = createMockTypeSafe({
    onRequest: (_json, n) => {
      calls = n;
      if (n === 1) return { status: 429, headers: { "retry-after": "0" }, body: { detail: "slow down" } };
      return null;
    },
  });
  await mock.listen();
  const journal = [];
  const client = new TypeSafeClient({ apiKey: "k", baseUrl: mock.baseUrl, maxRetries: 2, onRequest: (row) => journal.push(row) });
  const questions = { q: { type: "noul", instructions: "Is it urgent?" } };
  const first = await client.systemOne({ state: "help now", questions });
  assert.equal(calls, 2, "one 429 then success");
  assert.equal(first.attempts, 2);
  assert.equal(first.answers.q.type, "noul");
  assert.equal(first.cacheHit, false);
  const second = await client.systemOne({ state: "help now", questions });
  assert.equal(second.cacheHit, true);
  assert.equal(client.totals.requests, 1);
  assert.equal(client.totals.cacheHits, 1);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].status, "succeeded");
  await mock.close();
});

test("client surfaces 401 without retrying and never leaks the key", async () => {
  const mock = createMockTypeSafe({ onRequest: () => ({ status: 401, body: { detail: "bad key sk-secret-value" } }) });
  await mock.listen();
  const client = new TypeSafeClient({ apiKey: "sk-secret-value", baseUrl: mock.baseUrl, maxRetries: 3 });
  await assert.rejects(client.systemOne({ state: "x", questions: { q: { type: "noul", instructions: "?" } } }), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message.includes("sk-secret-value"), false);
    return true;
  });
  assert.equal(mock.requests.length, 1);
  await mock.close();
});

test("client requires an API key", () => {
  assert.throws(() => new TypeSafeClient({}), /Missing TypeSafe API key/);
});
