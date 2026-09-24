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

/**
 * Run `body` with JEV_LLAMA_SERVER pinned, then restore it. Whether llama.cpp is installed is an
 * input to doctor (it resolves JEV_LLAMA_SERVER, then PATH, then /opt/homebrew/bin), and a test
 * that inherits it asserts the machine it happens to run on.
 */
async function withLlamaServer(value, body) {
  const previous = process.env.JEV_LLAMA_SERVER;
  process.env.JEV_LLAMA_SERVER = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.JEV_LLAMA_SERVER;
    else process.env.JEV_LLAMA_SERVER = previous;
  }
}

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

    // With llama.cpp present, the next action is to replace the file — while the truncation is
    // still the thing the check refuses to call ready.
    const stub = path.join(home, "llama-server-stub");
    await fs.writeFile(stub, "#!/bin/sh\n", { mode: 0o755 });
    const withLlama = await withLlamaServer(stub, () => runDoctor({ home, baseUrl: "http://127.0.0.1:8092" }));
    const local = check(withLlama, "local model");
    assert.equal(local.status, "warn");
    assert.match(local.detail, new RegExp(`truncated \\(1024 of ${entry.bytes} bytes\\)`));
    assert.match(local.detail, /127\.0\.0\.1:8092 not running/);
    assert.match(local.hint, /download it again/);

    // Without llama.cpp (a bare CI runner) the same file is still described as truncated and is
    // still not ready; the hint names the prerequisite that is missing first. The two states are
    // asserted separately because the machine decides which one a run meets.
    const withoutLlama = await withLlamaServer(path.join(home, "no-llama-server-here"), () => runDoctor({ home, baseUrl: "http://127.0.0.1:8092" }));
    const bare = check(withoutLlama, "local model");
    assert.equal(bare.status, "warn");
    assert.match(bare.detail, new RegExp(`truncated \\(1024 of ${entry.bytes} bytes\\)`));
    assert.match(bare.detail, /llama-server not found/);
    assert.match(bare.hint, /brew install llama\.cpp/);
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
