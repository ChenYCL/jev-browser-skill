// The `tier` subcommand: one uniform way to see and select the judging backend, with hosted Jev
// still the default. Offline throughout — the only endpoint any test needs is the mock TypeSafe
// fixture (its /v1/models card is name-only, i.e. the GGUF readout).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BIN } from "../helpers/env.mjs";
import { createMockTypeSafe } from "../helpers/mock-typesafe.mjs";
import { DEFAULTS, FALLBACK_PROFILE, KEV_GOAL_DONE, LOCAL_GOAL_DONE, THRESHOLD_PROFILES, loadConfig } from "../../skills/jev-browser/lib/config.mjs";
import { DEFAULT_TIER, TIERS } from "../../skills/jev-browser/lib/tiers.mjs";

const run = promisify(execFile);

/** A clean home with an empty environment: no config file, no TYPESAFE_*, no ./jev-browser.config.json. */
async function cleanContext() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jev-tier-home-"));
  return { home, env: { PATH: process.env.PATH, HOME: home } };
}

/** Run the CLI and normalize the exit code (execFile rejects on a non-zero one). */
async function cli(args, { env = {}, home } = {}) {
  const options = { env: { ...env, ...(home ? { HOME: home } : {}) }, cwd: home ?? os.tmpdir() };
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

/** A port nothing is listening on — bound once to learn it, then released. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("tier list: three tiers, hosted marked default, a start command for each local one", async () => {
  const { home, env } = await cleanContext();
  try {
    const list = await cli(["tier", "list", "--json"], { env, home });
    assert.equal(list.code, 0, list.stderr);
    const out = JSON.parse(list.stdout);
    assert.equal(out.defaultTier, DEFAULT_TIER);
    assert.deepEqual(
      out.tiers.map((tier) => tier.tier),
      ["hosted", "local-readout", "kev"],
    );
    assert.deepEqual(
      out.tiers.filter((tier) => tier.default).map((tier) => tier.tier),
      [DEFAULT_TIER],
      "exactly one tier is marked the default, and it is hosted",
    );

    const [hosted, readout, kev] = out.tiers;
    assert.match(hosted.start, /api\.typesafe\.ai/, "hosted says there is nothing to start");
    assert.equal(hosted.command, null);
    assert.deepEqual(hosted.bar, { profile: "hosted", ...THRESHOLD_PROFILES.hosted });
    assert.equal(hosted.score, "0.95");

    assert.match(readout.command, /^node .*bin\/jev-local\.mjs$/);
    assert.match(readout.start, /127\.0\.0\.1:8092/);
    assert.equal(readout.score, "0.80");
    assert.deepEqual(readout.bar, { profile: "local-readout", goalDone: LOCAL_GOAL_DONE, goalDoneFinal: LOCAL_GOAL_DONE });

    assert.match(kev.command, /^node .*bin\/jev-kev\.mjs$/);
    assert.match(kev.start, /127\.0\.0\.1:8008/);
    assert.equal(kev.score, "0.95 / 0.90");
    assert.deepEqual(kev.bar, { profile: "kev", goalDone: KEV_GOAL_DONE, goalDoneFinal: KEV_GOAL_DONE });

    // Every bar in the table is the profile's own value — the table cannot drift from doctor.
    for (const tier of out.tiers) {
      const profile = THRESHOLD_PROFILES[tier.tier];
      assert.equal(tier.bar.goalDone, profile.goalDone);
      assert.equal(tier.bar.goalDoneFinal, profile.goalDoneFinal);
    }

    const human = await cli(["tier", "list"], { env, home });
    assert.match(human.stdout, /\*\s+hosted/, "the human table marks the default");
    for (const tier of ["hosted", "local-readout", "kev"]) assert.match(human.stdout, new RegExp(tier));
    assert.match(human.stdout, /node .*bin\/jev-local\.mjs/);
    assert.match(human.stdout, /node .*bin\/jev-kev\.mjs/);
    assert.match(human.stdout, /8092/);
    assert.match(human.stdout, /8008/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("tier status: hosted for a hosted baseUrl, unclassified and honest when a loopback endpoint is down", async () => {
  const { home, env } = await cleanContext();
  try {
    const clean = await cli(["tier", "status", "--json"], { env, home });
    assert.equal(clean.code, 0, clean.stderr);
    const hosted = JSON.parse(clean.stdout);
    assert.equal(hosted.tier, DEFAULT_TIER);
    assert.equal(hosted.default, true);
    assert.equal(hosted.baseUrl, "https://api.typesafe.ai");
    assert.equal(hosted.loopback, false);
    assert.equal(hosted.profile.name, "hosted");
    assert.deepEqual(hosted.effective, { goalDone: 0.85, goalDoneFinal: 0.7 });
    assert.equal(hosted.classification, null, "a hosted baseUrl has no local backend to classify");
    assert.equal(hosted.start, null);

    const port = await freePort();
    const downEnv = { ...env, TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: `http://127.0.0.1:${port}` };
    const down = JSON.parse((await cli(["tier", "status", "--json"], { env: downEnv, home })).stdout);
    assert.equal(down.tier, "unclassified", "an endpoint nobody could classify is not called kev");
    assert.equal(down.loopback, true);
    assert.equal(down.profile.name, FALLBACK_PROFILE, "but the bar is the fallback — the highest one");
    assert.equal(down.effective.goalDone, KEV_GOAL_DONE);
    assert.equal(down.classification.profile, null);
    assert.ok(["unreachable", "http-error"].includes(down.classification.kind), down.classification.kind);
    assert.match(down.classification.reason, /v1\/models/);

    const human = await cli(["tier", "status"], { env: downEnv, home });
    assert.match(human.stdout, /unclassified/);
    assert.match(human.stdout, /NOT ANSWERING/);
    assert.match(human.stdout, /loopback/);

    // doctor names the same tier beside the same fallback bar.
    const downDoctor = JSON.parse((await cli(["doctor", "--json", "--offline"], { env: downEnv, home })).stdout);
    const downBar = downDoctor.checks.find((c) => c.name === "goal_done bar");
    assert.match(downBar.detail, /unclassified tier, kev profile/);
    assert.match(downBar.detail, new RegExp(String(KEV_GOAL_DONE)));

    // --offline says the probe was skipped instead of inventing an answer.
    const offline = JSON.parse((await cli(["tier", "status", "--json", "--offline"], { env: downEnv, home })).stdout);
    assert.equal(offline.tier, "unclassified");
    assert.equal(offline.classification, null);
    assert.match((await cli(["tier", "status", "--offline"], { env: downEnv, home })).stdout, /not probed/);

    // A config the command cannot load is a config problem, not an unhandled crash.
    await cli(["config", "set", "thresholds.profile", "medium", "--home", home], { env, home });
    const broken = await cli(["tier", "status", "--home", home], { env, home });
    assert.equal(broken.code, 2);
    assert.match(broken.stderr, /Unknown thresholds\.profile/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("the hosted default is intact for a clean HOME, and no default value points at loopback", async () => {
  const { home, env } = await cleanContext();
  try {
    const show = await cli(["config", "show", "--json"], { env, home });
    assert.equal(show.code, 0, show.stderr);
    const shown = JSON.parse(show.stdout);
    assert.equal(shown.config.baseUrl, "https://api.typesafe.ai");
    assert.equal(shown.config.thresholds.profile, "auto");
    assert.equal(shown.config.thresholds.goalDone, 0.85);
    assert.equal(shown.config.thresholds.goalDoneFinal, 0.7);
    assert.deepEqual(shown.sources, [], "nothing but the built-in defaults contributed");

    // What a run would resolve: the same baseUrl, from the shipped defaults alone.
    const { config } = await loadConfig({ env: {}, home, cwd: home });
    assert.equal(config.baseUrl, "https://api.typesafe.ai");
    assert.equal(config.model, DEFAULTS.model);

    // Guard: no default value anywhere may point a clean run at a loopback URL.
    const offenders = [];
    const walk = (node, trail) => {
      if (typeof node === "string") {
        if (/127\.0\.0\.1|localhost|\[?::1\]?/.test(node)) offenders.push(`${trail}=${node}`);
        return;
      }
      if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) walk(value, trail ? `${trail}.${key}` : key);
    };
    walk(DEFAULTS, "");
    assert.deepEqual(offenders, [], "a shipped default must never be a loopback endpoint");
    assert.equal(TIERS.find((tier) => tier.name === DEFAULT_TIER).baseUrl, DEFAULTS.baseUrl);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("an explicit thresholds.profile wins over what tier status would classify", async () => {
  const { home, env } = await cleanContext();
  const mock = createMockTypeSafe();
  await mock.listen();
  try {
    const mockEnv = { ...env, TYPESAFE_API_KEY: "mock-key", TYPESAFE_BASE_URL: mock.baseUrl };
    const auto = JSON.parse((await cli(["tier", "status", "--json"], { env: mockEnv, home })).stdout);
    assert.equal(auto.tier, "local-readout", "the fixture card is name-only");
    assert.equal(auto.classification.kind, "readout");
    assert.deepEqual(auto.effective, { goalDone: LOCAL_GOAL_DONE, goalDoneFinal: LOCAL_GOAL_DONE });

    // doctor names the same tier beside the same bar — the two can never disagree.
    const autoDoctor = JSON.parse((await cli(["doctor", "--json"], { env: mockEnv, home })).stdout);
    const autoBar = autoDoctor.checks.find((c) => c.name === "goal_done bar");
    assert.match(autoBar.detail, new RegExp(`${auto.tier} tier, ${auto.profile.name} profile`));
    assert.match(autoBar.detail, new RegExp(String(auto.effective.goalDone)));

    await cli(["config", "set", "thresholds.profile", "hosted", "--home", home], { env: mockEnv, home });
    const pinned = JSON.parse((await cli(["tier", "status", "--json"], { env: mockEnv, home })).stdout);
    assert.equal(pinned.tier, "hosted", "the pin wins over the classification");
    assert.equal(pinned.profile.pinned, "hosted");
    assert.deepEqual(pinned.effective, { goalDone: 0.85, goalDoneFinal: 0.7 });
    assert.equal(pinned.classification.kind, "readout", "the endpoint is still reported as it is");

    // And doctor agrees with it, tier name included.
    const doctor = JSON.parse((await cli(["doctor", "--json"], { env: mockEnv, home })).stdout);
    const bar = doctor.checks.find((c) => c.name === "goal_done bar");
    assert.match(bar.detail, /hosted tier, hosted profile/);
  } finally {
    await mock.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("tier use prints the launcher's export line and writes nothing without --persist", async () => {
  const { home, env } = await cleanContext();
  const configFile = path.join(home, ".config", "jev-browser", "config.json");
  try {
    const kev = await cli(["tier", "use", "kev"], { env, home });
    assert.equal(kev.code, 0, kev.stderr);
    assert.match(kev.stdout, /TYPESAFE_BASE_URL=http:\/\/127\.0\.0\.1:8008 TYPESAFE_API_KEY=local/);
    assert.match(kev.stdout, /export TYPESAFE_BASE_URL=http:\/\/127\.0\.0\.1:8008/);
    assert.match(kev.stdout, /node .*bin\/jev-kev\.mjs/);
    assert.match(kev.stdout, /Nothing was written/);
    await assert.rejects(fs.access(configFile), "tier use must not write a config");

    const hosted = await cli(["tier", "use", "hosted"], { env, home });
    assert.equal(hosted.code, 0, hosted.stderr);
    assert.match(hosted.stdout, /TYPESAFE_BASE_URL=https:\/\/api\.typesafe\.ai/);
    assert.match(hosted.stdout, /already the default/);
    await assert.rejects(fs.access(configFile));

    // --persist is the explicit opt-in: a local tier stores baseUrl AND its placeholder key, so the
    // run that follows needs no export.
    const persisted = JSON.parse((await cli(["tier", "use", "kev", "--persist", "--json"], { env, home })).stdout);
    assert.equal(persisted.persisted, configFile);
    const stored = JSON.parse(await fs.readFile(configFile, "utf8"));
    assert.equal(stored.baseUrl, "http://127.0.0.1:8008");
    assert.equal(stored.apiKey, "local", "a local tier persists its placeholder key too");
    assert.equal(JSON.parse((await cli(["config", "show", "--json"], { env, home })).stdout).config.baseUrl, "http://127.0.0.1:8008");

    // Hosted has no key to store: baseUrl alone, and the text says which it wrote.
    const hostedHome = await fs.mkdtemp(path.join(os.tmpdir(), "jev-tier-hosted-"));
    try {
      const hostedPersist = await cli(["tier", "use", "hosted", "--persist"], { env, home: hostedHome });
      assert.equal(hostedPersist.code, 0, hostedPersist.stderr);
      assert.match(hostedPersist.stdout, /Stored baseUrl=https:\/\/api\.typesafe\.ai/);
      const hostedConfig = JSON.parse(await fs.readFile(path.join(hostedHome, ".config", "jev-browser", "config.json"), "utf8"));
      assert.equal(hostedConfig.baseUrl, "https://api.typesafe.ai");
      assert.equal("apiKey" in hostedConfig, false, "hosted has no placeholder key to store");

      const kevPersist = await cli(["tier", "use", "kev", "--persist"], { env, home: hostedHome });
      assert.match(kevPersist.stdout, /Stored apiKey=local and baseUrl=http:\/\/127\.0\.0\.1:8008/);
    } finally {
      await fs.rm(hostedHome, { recursive: true, force: true });
    }

    const unknown = await cli(["tier", "use", "bogus"], { env, home });
    assert.equal(unknown.code, 2, "an unknown tier is a usage error");
    assert.match(unknown.stderr, /unknown tier "bogus"/);
    assert.equal((await cli(["tier", "use"], { env, home })).code, 2);
    assert.equal((await cli(["tier", "wat"], { env, home })).code, 2);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
