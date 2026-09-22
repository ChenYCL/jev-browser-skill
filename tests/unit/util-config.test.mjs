import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deepMerge, extractQuoted, parseKeyValue, rankProbabilities, redact, truncate } from "../../skills/jev-browser/lib/util.mjs";
import { DEFAULTS, loadConfig, saveUserConfig, unsetUserConfig, patchFromKeyPath, describeConfig } from "../../skills/jev-browser/lib/config.mjs";

test("parseKeyValue splits on the first equals sign", () => {
  assert.deepEqual(parseKeyValue("query=a=b"), ["query", "a=b"]);
  assert.throws(() => parseKeyValue("novalue"));
});

test("extractQuoted finds quoted strings in goals", () => {
  assert.deepEqual(extractQuoted(`Search for "blue widget" and open 'Red Gadget'`), ["blue widget", "Red Gadget"]);
  assert.deepEqual(extractQuoted("搜索「蓝色小部件」"), ["蓝色小部件"]);
});

test("redact removes secret values from nested structures", () => {
  const out = redact({ a: "password hunter2 here", b: ["hunter2"], c: 1 }, ["hunter2"]);
  assert.deepEqual(out, { a: "password [REDACTED] here", b: ["[REDACTED]"], c: 1 });
});

test("rankProbabilities sorts by probability then name", () => {
  assert.deepEqual(rankProbabilities({ b: 0.2, a: 0.2, c: 0.6 }), [["c", 0.6], ["a", 0.2], ["b", 0.2]]);
});

test("deepMerge merges nested objects without mutating", () => {
  const base = { a: { b: 1, c: 2 }, d: 1 };
  const out = deepMerge(base, { a: { c: 3 }, e: 4 });
  assert.deepEqual(out, { a: { b: 1, c: 3 }, d: 1, e: 4 });
  assert.deepEqual(base, { a: { b: 1, c: 2 }, d: 1 });
});

test("truncate collapses whitespace and caps length", () => {
  assert.equal(truncate("a   b\n\n  c", 100), "a b\nc");
  assert.equal(truncate("x".repeat(20), 5).length, 5);
});

test("config precedence: defaults < user file < project file < env < flags", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jev-cfg-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jev-cwd-"));
  await saveUserConfig({ maxSteps: 5, backend: "chrome", chrome: { headless: true } }, { home });
  await fs.writeFile(path.join(cwd, "jev-browser.config.json"), JSON.stringify({ maxSteps: 7, budgetUsd: 1 }));
  const env = { TYPESAFE_API_KEY: "k", JEV_BROWSER_BUDGET_USD: "2", TYPESAFE_DEFAULT_MODEL: "jev-preview" };
  const { config, sources } = await loadConfig({ home, cwd, env, flags: { model: "jev-1.13.0" } });
  assert.equal(config.maxSteps, 7);
  assert.equal(config.budgetUsd, 2);
  assert.equal(config.model, "jev-1.13.0");
  assert.equal(config.backend, "chrome");
  assert.equal(config.chrome.headless, true);
  assert.equal(config.apiKey, "k");
  assert.deepEqual(sources.map((s) => s.kind), ["user-file", "project-file", "env", "flags"]);
  assert.equal(describeConfig(config).apiKey.includes("k…"), true);
  const stat = await fs.stat(path.join(home, ".config", "jev-browser", "config.json"));
  assert.equal(stat.mode & 0o777, 0o600);
  await unsetUserConfig("chrome.headless", { home });
  const again = await loadConfig({ home, cwd, env: {} });
  assert.equal(again.config.chrome.headless, DEFAULTS.chrome.headless);
  assert.deepEqual(patchFromKeyPath("thresholds.goalDone", "0.9"), { thresholds: { goalDone: 0.9 } });
  assert.deepEqual(patchFromKeyPath("chrome.headless", "true"), { chrome: { headless: true } });
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(cwd, { recursive: true, force: true });
});

test("config rejects unknown backends and non-positive budgets", async () => {
  await assert.rejects(loadConfig({ home: os.tmpdir(), cwd: os.tmpdir(), env: { JEV_BROWSER_BACKEND: "firefox" } }), /Unknown backend/);
  await assert.rejects(loadConfig({ home: os.tmpdir(), cwd: os.tmpdir(), env: { JEV_BROWSER_MAX_STEPS: "0" } }), /maxSteps/);
});
