import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LOCAL_DEFAULTS, LOCAL_MODEL_BYTES, LOCAL_MODEL_FILE, LOCAL_MODEL_ID, LOCAL_MODEL_LABEL, LOCAL_MODEL_URL, LOCAL_MODELS, defaultLocalModel, loadLocalModels, localModel, localPaths } from "../lib/local.mjs";

const BIN = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "bin", "jev-local.mjs");

/** Run the launcher offline: no llama-server, no registry download, no inherited URL override. */
function jevLocal(args) {
  const env = { ...process.env };
  delete env.JEV_LOCAL_MODEL_URL;
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 30_000, env });
}

/** A throwaway registry file; the callback gets its path. */
function withRegistryFile(contents, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jev-local-registry-")), "local-models.json");
  if (contents !== null) fs.writeFileSync(file, contents);
  try {
    return fn(file);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

const ENTRY = { file: "Qwen3.5-0.8B-Q8_0.gguf", url: "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf", bytes: 811843840, label: "Qwen3.5-0.8B Q8_0" };
const ENTRY_4B = { file: "Qwen3.5-4B-Q4_K_M.gguf", url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf", bytes: 2740937888, label: "Qwen3.5-4B Q4_K_M" };

test("the shipped registry defaults to the 4B, and the derived constants follow it", () => {
  const registry = loadLocalModels();
  assert.equal(registry.default, "qwen3.5-4b-q4-k-m");
  assert.deepEqual(LOCAL_MODELS.models[registry.default], ENTRY_4B);
  assert.deepEqual(localModel(registry.default), { id: registry.default, ...ENTRY_4B });
  assert.deepEqual(defaultLocalModel(), { id: registry.default, ...ENTRY_4B });

  // The 0.8B stays in the registry, selectable by id, with its verified fields.
  assert.deepEqual(localModel("qwen3.5-0.8b-q8"), { id: "qwen3.5-0.8b-q8", ...ENTRY });

  assert.equal(LOCAL_MODEL_ID, registry.default);
  assert.equal(LOCAL_MODEL_FILE, ENTRY_4B.file);
  assert.equal(LOCAL_MODEL_URL, ENTRY_4B.url);
  assert.equal(LOCAL_MODEL_BYTES, ENTRY_4B.bytes);
  assert.equal(LOCAL_MODEL_LABEL, ENTRY_4B.label);

  // Local paths follow the entry, so swapping the default swaps the file that gets served.
  assert.equal(localPaths("/home/x").modelFile, `/home/x/.jev-browser/models/${ENTRY_4B.file}`);
  assert.equal(localPaths("/home/x", { id: "old", file: ENTRY.file }).modelFile, `/home/x/.jev-browser/models/${ENTRY.file}`);
  assert.equal(LOCAL_DEFAULTS.model, registry.default);
  assert.equal(LOCAL_DEFAULTS.ctx, 16384);
});

test("an unknown model id names the ids that do exist", () => {
  assert.throws(() => localModel("nope"), (error) => {
    assert.equal(error.name, "LocalModelRegistryError");
    assert.match(error.message, /unknown local model "nope"/);
    assert.match(error.message, /available: qwen3\.5-0\.8b-q8, qwen3\.5-4b-q4-k-m/);
    return true;
  });
});

test("a missing or malformed registry fails loudly instead of falling back", () => {
  withRegistryFile(null, (file) => {
    assert.throws(() => loadLocalModels({ file }), /registry not readable: .* \(ENOENT/);
  });
  withRegistryFile("{ not json", (file) => {
    assert.throws(() => loadLocalModels({ file }), /not valid JSON/);
  });
  withRegistryFile(JSON.stringify({ default: "a", models: {} }), (file) => {
    assert.throws(() => loadLocalModels({ file }), /needs a non-empty "models" object/);
  });
  withRegistryFile(JSON.stringify({ default: "ghost", models: { a: ENTRY } }), (file) => {
    assert.throws(() => loadLocalModels({ file }), /"default" is "ghost", not one of a/);
  });
  withRegistryFile(JSON.stringify({ default: "a", models: { a: { ...ENTRY, url: "" } } }), (file) => {
    assert.throws(() => loadLocalModels({ file }), /model "a" needs a non-empty "url" string/);
  });
  withRegistryFile(JSON.stringify({ default: "a", models: { a: { ...ENTRY, file: "sub/model.gguf" } } }), (file) => {
    assert.throws(() => loadLocalModels({ file }), /file must be a bare filename/);
  });
  withRegistryFile(JSON.stringify({ default: "a", models: { a: { ...ENTRY, bytes: "big" } } }), (file) => {
    assert.throws(() => loadLocalModels({ file }), /positive integer "bytes"/);
  });
});

test("--list-models prints the registry with the default marked and exits 0", () => {
  const result = jevLocal(["--list-models"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\* qwen3\.5-4b-q4-k-m/);            // default marker
  assert.match(result.stdout, /Qwen3\.5-4B Q4_K_M/);
  assert.match(result.stdout, /2\.6 GiB/);
  assert.match(result.stdout, /Qwen3\.5-4B-Q4_K_M\.gguf/);
  assert.match(result.stdout, /^ {2}qwen3\.5-0\.8b-q8/m);           // still listed, not default
  assert.match(result.stdout, /Qwen3\.5-0\.8B Q8_0/);
  assert.match(result.stdout, /\* = default/);
  assert.equal(result.stderr, "");
});

test("--help documents the registry flags and exits 0", () => {
  const result = jevLocal(["--help"]);
  assert.equal(result.status, 0);
  for (const needle of ["--model-name", "--model-url", "--list-models", "--ctx", "--download-only"]) assert.match(result.stdout, new RegExp(needle));
  // Drift guard: the numbers in the help text are the ones the code uses.
  assert.match(result.stdout, new RegExp(`--ctx <tokens>.*${LOCAL_DEFAULTS.ctx}`));
  assert.match(result.stdout, new RegExp(`--port N.*${LOCAL_DEFAULTS.port}`));
  assert.match(result.stdout, new RegExp(`--llama-port N.*${LOCAL_DEFAULTS.llamaPort}`));
});

test("--model-name nope exits 2 and lists the valid ids", () => {
  const result = jevLocal(["--model-name", "nope", "--port", "65397"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown local model "nope"/);
  assert.match(result.stderr, /available: qwen3\.5-0\.8b-q8/);
  assert.equal(result.stdout, "");
});

test("--model <path> without a url refuses to download, and bad flags exit 2", () => {
  const missing = path.join(os.tmpdir(), "jev-local-does-not-exist.gguf");
  const result = jevLocal(["--model", missing, "--port", "65396"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /model file not found/);
  assert.match(result.stderr, /--model-name <id> to use the registry/);

  const both = jevLocal(["--model-name", "qwen3.5-0.8b-q8", "--model", missing, "--port", "65396"]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /use either --model-name <id> or --model <path>, not both/);

  const ctx = jevLocal(["--ctx", "10", "--port", "65396"]);
  assert.equal(ctx.status, 2);
  assert.match(ctx.stderr, /--ctx must be an integer >= 512/);
});
