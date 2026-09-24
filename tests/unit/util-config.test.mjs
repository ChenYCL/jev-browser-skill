import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deepMerge, extractQuoted, parseKeyValue, rankProbabilities, redact, truncate } from "../../skills/jev-browser/lib/util.mjs";
import { DEFAULTS, FALLBACK_PROFILE, KEV_GOAL_DONE, LOCAL_GOAL_DONE, PROFILE_MEASURED, THRESHOLD_PROFILES, classifyModelsCard, loadConfig, saveUserConfig, unsetUserConfig, patchFromKeyPath, describeConfig, thresholdProfile } from "../../skills/jev-browser/lib/config.mjs";
import { resolveThresholds } from "../../skills/jev-browser/lib/runner.mjs";

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

test("a loopback base URL no longer moves the bar at load time; the run resolves it", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jev-bar-home-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jev-bar-cwd-"));
  try {
    const hosted = await loadConfig({ home, cwd, env: { TYPESAFE_API_KEY: "k" } });
    assert.equal(hosted.config.thresholds.goalDone, 0.85);
    assert.equal(hosted.config.thresholds.goalDoneFinal, 0.7);
    assert.equal(hosted.config.thresholds.profile, "auto");
    assert.deepEqual(hosted.sources.map((s) => s.kind), ["env"]);
    for (const baseUrl of ["http://127.0.0.1:8092", "http://localhost:8092", "http://[::1]:8092"]) {
      const local = await loadConfig({ home, cwd, env: { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: baseUrl } });
      // Which backend answers is not knowable without asking it, so loadConfig must not guess:
      // the values stay at the shipped pair and resolveThresholds moves them at run start.
      assert.equal(local.config.thresholds.goalDone, 0.85, baseUrl);
      assert.equal(local.config.thresholds.goalDoneFinal, 0.7, baseUrl);
      assert.deepEqual(local.configuredThresholds, [], "nothing was configured");
      assert.ok(!local.sources.some((s) => s.kind === "local-model"), "no bar was chosen at load time");
      assert.equal(local.config.thresholds.blocker, DEFAULTS.thresholds.blocker, "the other thresholds never move");
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("each profile name maps to its measured pair, and a pinned profile needs no endpoint", async () => {
  assert.deepEqual(Object.keys(THRESHOLD_PROFILES).sort(), ["hosted", "kev", "local-readout"]);
  assert.deepEqual(THRESHOLD_PROFILES.hosted, { goalDone: 0.85, goalDoneFinal: 0.7 });
  assert.deepEqual(THRESHOLD_PROFILES["local-readout"], { goalDone: LOCAL_GOAL_DONE, goalDoneFinal: LOCAL_GOAL_DONE });
  assert.deepEqual(THRESHOLD_PROFILES.kev, { goalDone: KEV_GOAL_DONE, goalDoneFinal: KEV_GOAL_DONE });
  for (const name of Object.keys(THRESHOLD_PROFILES)) assert.ok(PROFILE_MEASURED[name], `${name} says where it was measured`);

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jev-bar-home-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jev-bar-cwd-"));
  try {
    const pinned = await loadConfig({ home, cwd, env: { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "http://127.0.0.1:8008" }, flags: { thresholds: { profile: "kev" } } });
    assert.equal(pinned.config.thresholds.goalDone, KEV_GOAL_DONE, "a pinned profile is applied at load time");
    assert.equal(pinned.config.thresholds.goalDoneFinal, KEV_GOAL_DONE);
    assert.ok(pinned.sources.some((s) => s.kind === "thresholds-profile"), "the pin is recorded as a source");
    const bar = thresholdProfile(pinned.config);
    assert.equal(bar.profile, "kev");
    assert.equal(bar.pinned, "kev");
    assert.ok(bar.reason.includes("pinned by configuration"));
    assert.deepEqual(bar.custom, [], "nothing was overridden per key");
    await assert.rejects(loadConfig({ home, cwd, env: { TYPESAFE_API_KEY: "k" }, flags: { thresholds: { profile: "medium" } } }), /Unknown thresholds\.profile/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("classifyModelsCard reads the backend off the served card", () => {
  const kev = classifyModelsCard({ models: [{ name: "kev-latest", run: "jaredpalmer/kev-4b", base: "Qwen/Qwen3.5-4B-Base", temperature: 2.14 }] });
  assert.equal(kev.profile, "kev");
  assert.match(kev.reason, /run=jaredpalmer\/kev-4b/);
  const readout = classifyModelsCard({ models: [{ name: "qwen3.5-4b-q4-k-m", description: "Local llama.cpp first-token readout backend (experimental)" }] });
  assert.equal(readout.profile, "local-readout");
  assert.match(readout.reason, /name-only/);
  assert.equal(classifyModelsCard({ data: [{ id: "x", run: "owner/run" }] }).profile, "kev", "the OpenAI shape works too");
  assert.equal(classifyModelsCard({ models: [] }).profile, null);
  assert.equal(classifyModelsCard(null).profile, null);
  assert.equal(classifyModelsCard({}).kind, "empty");
});

test("auto resolves loopback by the endpoint and falls back high, never low", () => {
  const base = { baseUrl: "http://127.0.0.1:8008", thresholds: { profile: "auto", goalDone: 0.85, goalDoneFinal: 0.7, configured: [] } };
  const kev = thresholdProfile(base, { classification: classifyModelsCard({ models: [{ name: "kev-latest", run: "jaredpalmer/kev-4b", base: "Qwen/Qwen3.5-4B-Base" }] }) });
  assert.equal(kev.profile, "kev");
  assert.deepEqual(kev.defaults, { goalDone: KEV_GOAL_DONE, goalDoneFinal: KEV_GOAL_DONE });
  const readout = thresholdProfile({ ...base, baseUrl: "http://127.0.0.1:8092" }, { classification: classifyModelsCard({ models: [{ name: "qwen3.5-4b-q4-k-m" }] }) });
  assert.equal(readout.profile, "local-readout");
  assert.deepEqual(readout.defaults, { goalDone: LOCAL_GOAL_DONE, goalDoneFinal: LOCAL_GOAL_DONE });
  const hosted = thresholdProfile({ ...base, baseUrl: "https://api.typesafe.ai" });
  assert.equal(hosted.profile, "hosted", "non-loopback needs no endpoint call");
  assert.deepEqual(hosted.defaults, { goalDone: 0.85, goalDoneFinal: 0.7 });
  const unreachable = thresholdProfile(base, { classification: { profile: null, reason: "the endpoint did not answer GET /v1/models" } });
  assert.equal(unreachable.profile, FALLBACK_PROFILE, "an unclassified loopback endpoint gets the highest bar");
  assert.ok(unreachable.defaults.goalDone > readout.defaults.goalDone, "higher than the readout's, never lower");
  assert.match(unreachable.reason, /false stuck is visible/);
});

test("each local bar is the maximin midpoint of its own measured band", () => {
  const bands = [
    { bar: LOCAL_GOAL_DONE, worstMiss: 0.111, lowestHit: 0.273, model: "the GGUF readout" },
    { bar: KEV_GOAL_DONE, worstMiss: 0.341, lowestHit: 0.683, model: "the Kev 4B checkpoint" },
  ];
  for (const { bar, worstMiss, lowestHit, model } of bands) {
    assert.ok(bar > worstMiss && bar < lowestHit, `${model}: sits inside the observed gap`);
    const lowerMargin = bar / worstMiss;
    const upperMargin = lowestHit / bar;
    assert.ok(Math.abs(lowerMargin - upperMargin) < 0.01, `${model}: relative margins differ (${lowerMargin} vs ${upperMargin})`);
  }
  assert.ok(KEV_GOAL_DONE > LOCAL_GOAL_DONE, "the two bands do not overlap: one bar cannot serve both backends");
});

test("an explicit goal_done bar wins over every profile", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jev-bar-home-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jev-bar-cwd-"));
  const env = { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "http://127.0.0.1:8008" };
  try {
    await saveUserConfig({ thresholds: { goalDone: 0.9 } }, { home });
    const fromFile = await loadConfig({ home, cwd, env });
    assert.equal(fromFile.config.thresholds.goalDone, 0.9, "the user file wins");
    assert.deepEqual(fromFile.configuredThresholds, ["goalDone"], "and is recorded as configured");
    const fromFlag = await loadConfig({ home, cwd, env, flags: { thresholds: { goalDoneFinal: 0.6 } } });
    assert.equal(fromFlag.config.thresholds.goalDoneFinal, 0.6, "flags win over both");
    assert.equal(fromFlag.config.thresholds.goalDone, 0.9);
    assert.deepEqual(fromFlag.configuredThresholds.sort(), ["goalDone", "goalDoneFinal"]);
    // A configured value also survives a pinned profile.
    await saveUserConfig({ thresholds: { profile: "kev" } }, { home });
    const pinned = await loadConfig({ home, cwd, env });
    assert.equal(pinned.config.thresholds.goalDone, 0.9, "the configured value still wins");
    assert.equal(pinned.config.thresholds.goalDoneFinal, KEV_GOAL_DONE, "the key nobody set follows the profile");
    const profile = thresholdProfile(pinned.config);
    assert.deepEqual(profile.custom, ["goalDone"], "doctor can name the values that differ from the profile");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("resolveThresholds applies the endpoint's bar at run start and never overrides a configured one", async () => {
  const config = (baseUrl, thresholds = {}) => ({
    baseUrl,
    thresholds: { profile: "auto", goalDone: 0.85, goalDoneFinal: 0.7, configured: [], ...thresholds },
  });
  const clientWith = (card) => ({ models: async () => card });
  const kevCard = { models: [{ name: "kev-latest", run: "jaredpalmer/kev-4b", base: "Qwen/Qwen3.5-4B-Base" }] };
  const readoutCard = { models: [{ name: "qwen3.5-4b-q4-k-m", description: "readout" }] };

  const kev = config("http://127.0.0.1:8008");
  const kevRecord = await resolveThresholds({ config: kev, client: clientWith(kevCard) });
  assert.equal(kevRecord.profile, "kev");
  assert.equal(kev.thresholds.goalDone, KEV_GOAL_DONE, "the bar is applied to the config the controller reads");
  assert.equal(kev.thresholds.goalDoneFinal, KEV_GOAL_DONE);
  assert.deepEqual(kevRecord.applied, { goalDone: KEV_GOAL_DONE, goalDoneFinal: KEV_GOAL_DONE });
  assert.equal(kevRecord.classification.kind, "kev", "the classification is recorded for the journal");

  const readout = config("http://127.0.0.1:8092");
  await resolveThresholds({ config: readout, client: clientWith(readoutCard) });
  assert.equal(readout.thresholds.goalDone, LOCAL_GOAL_DONE);
  assert.equal(readout.thresholds.goalDoneFinal, LOCAL_GOAL_DONE);

  const unreachable = config("http://127.0.0.1:8008");
  const unreachableRecord = await resolveThresholds({ config: unreachable, client: { models: async () => { throw new Error("fetch failed"); } } });
  assert.equal(unreachableRecord.profile, FALLBACK_PROFILE, "an unreachable endpoint gets the highest bar");
  assert.equal(unreachable.thresholds.goalDone, KEV_GOAL_DONE);
  assert.match(unreachableRecord.reason, /false stuck is visible/);

  const hosted = config("https://api.typesafe.ai");
  const hostedRecord = await resolveThresholds({ config: hosted, client: clientWith(kevCard) });
  assert.equal(hostedRecord.profile, "hosted");
  assert.deepEqual(hostedRecord.applied, {}, "a hosted run changes nothing");
  assert.equal(hosted.thresholds.goalDone, 0.85);

  const configured = config("http://127.0.0.1:8008", { goalDone: 0.9, configured: ["goalDone"] });
  const configuredRecord = await resolveThresholds({ config: configured, client: clientWith(kevCard) });
  assert.equal(configured.thresholds.goalDone, 0.9, "the configured value survives the profile");
  assert.equal(configured.thresholds.goalDoneFinal, KEV_GOAL_DONE, "the other key still follows the endpoint");
  assert.deepEqual(configuredRecord.applied, { goalDoneFinal: KEV_GOAL_DONE });
});
