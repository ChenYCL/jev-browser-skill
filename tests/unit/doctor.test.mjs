// `doctor`'s local lines, offline: a loopback endpoint is a complete configuration without a real
// key, the GGUF check compares the registry's exact size, and a Kev endpoint gets a Kev line that
// never sends the reader to the jev-local launcher.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doctor } from "../../skills/jev-browser/lib/doctor.mjs";
import { loadConfig } from "../../skills/jev-browser/lib/config.mjs";
import { defaultLocalModel } from "../../skills/jev-browser/lib/local.mjs";

const SKILL_DIR = fileURLToPath(new URL("../../skills/jev-browser", import.meta.url));

/** A scratch home, doctor against it, offline. */
async function scratchHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "jev-doctor-home-"));
}

async function runDoctor({ home, baseUrl }) {
  const env = { PATH: process.env.PATH, HOME: home, ...(baseUrl ? { TYPESAFE_BASE_URL: baseUrl } : {}) };
  const { config, sources } = await loadConfig({ env, home, cwd: home });
  return doctor({ config, sources, home, skillDir: SKILL_DIR, live: false });
}

const check = (report, name) => report.checks.find((c) => c.name === name);

test("a loopback baseUrl without a key is a warning that names the placeholder, not a failure", async () => {
  const home = await scratchHome();
  try {
    const report = await runDoctor({ home, baseUrl: "http://127.0.0.1:8092" });
    const key = check(report, "api key");
    assert.equal(key.status, "warn", "the local tiers are complete without a real key");
    assert.equal(key.detail, "missing");
    assert.match(key.hint, /TYPESAFE_API_KEY=local/);
    assert.match(key.hint, /config set-key local/);

    // The hosted default keeps the hard failure and the hosted remedy.
    const hosted = await runDoctor({ home });
    assert.equal(check(hosted, "api key").status, "fail");
    assert.match(check(hosted, "api key").hint, /config set-key --from-env/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("a truncated model file is reported as truncated, not accepted as ready", async () => {
  const home = await scratchHome();
  try {
    const entry = defaultLocalModel();
    const file = path.join(home, ".jev-browser", "models", entry.file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.alloc(1024));

    const report = await runDoctor({ home, baseUrl: "http://127.0.0.1:8092" });
    const local = check(report, "local model");
    assert.equal(local.status, "warn");
    assert.match(local.detail, new RegExp(`truncated \\(1024 of ${entry.bytes} bytes\\)`));
    assert.match(local.hint, /download it again/);
    assert.match(local.detail, /127\.0\.0\.1:8092 not running/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("a Kev endpoint gets a Kev line and no jev-local hint anywhere in the report", async () => {
  const home = await scratchHome();
  try {
    const report = await runDoctor({ home, baseUrl: "http://127.0.0.1:8008" });
    assert.equal(check(report, "local model"), undefined, "the GGUF registry line is not what a Kev endpoint needs");
    const kev = check(report, "kev");
    assert.ok(kev, "a Kev endpoint gets its own check");
    assert.equal(kev.status, "warn", "a scratch home has no Kev checkout");
    assert.match(kev.detail, /\.local\/share\/jev-browser\/kev/);
    assert.match(kev.hint, /bin\/jev-kev\.mjs/);
    for (const entry of report.checks) {
      assert.doesNotMatch(`${entry.name} ${entry.detail} ${entry.hint ?? ""}`, /jev-local/, `no jev-local hint for a Kev endpoint (${entry.name})`);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
