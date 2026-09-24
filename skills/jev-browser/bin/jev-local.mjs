#!/usr/bin/env node
// One command for the fully local (experimental) model backend of jev-browser: download the
// GGUF, start llama.cpp if nothing is serving on the llama port, and serve the TypeSafe
// `/v1/systemone` contract on 127.0.0.1:8092 (see ../lib/local.mjs).
//
// Which model is data, not code — skills/jev-browser/lib/local-models.json. Switch it with
// --model-name <id> for one run, or by pointing the registry's "default" at another entry.
//
//   node skills/jev-browser/bin/jev-local.mjs
//   node skills/jev-browser/bin/jev-local.mjs --list-models
//   TYPESAFE_BASE_URL=http://127.0.0.1:8092 TYPESAFE_API_KEY=local \
//     node skills/jev-browser/bin/jev-browser.mjs judge --state-file s.json --questions-file q.json
//
// Everything except the final `TYPESAFE_BASE_URL=... TYPESAFE_API_KEY=local` line goes to
// stderr, so the line can be piped or eval'd. Read experiments/gguf-provider/RESULTS.md for what
// the local model is good at (short states) and what it is not (goal_done).
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Static on purpose: --help must work even while the registry is being edited.
const HELP = `jev-local — serve the local (experimental) Jev backend for jev-browser

Usage:
  jev-local [--model-name <id> | --model <path.gguf>] [--ctx 16384] [--port 8092] [--llama-port 8090]
  jev-local --list-models              print the model registry and exit
  jev-local --download-only            fetch the model file and exit

What it does, in order:
  1. finds llama-server on PATH, then /opt/homebrew/bin       (brew install llama.cpp)
  2. downloads the selected GGUF into ~/.jev-browser/models  (streamed to .partial, then renamed)
  3. starts llama-server on 127.0.0.1:8090 with -c 16384 unless something already answers there
  4. serves /health, /v1/models and /v1/systemone on 127.0.0.1:8092 and prints:
       TYPESAFE_BASE_URL=http://127.0.0.1:8092 TYPESAFE_API_KEY=local

Models (skills/jev-browser/lib/local-models.json):
      --list-models      every entry: id, label, size, default marker
      --model-name <id>  serve that registry entry (default: the registry's "default")
      --model <path>     serve a GGUF you already have (no download unless --model-url is given)
      --model-url <url>  override the download URL for this run

Tuning:
      --ctx <tokens>     llama.cpp context size                (default 16384)
      --port N           port of the Jev-compatible server     (default 8092)
      --llama-port N     port of the llama.cpp server          (default 8090)
      --download-only    fetch the model file and exit
  -h, --help             this text

Env:
      JEV_LOCAL_MODEL_URL  same as --model-url (the flag wins)

A llama.cpp already serving the selected file on the llama port is reused and left untouched
on exit; one this launcher started is stopped together with it. No API key, no cost, no
network except the one-time model download.
`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const log = (message) => process.stderr.write(`${message}\n`);
const humanBytes = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`);
const mib = (bytes) => (bytes / 1024 / 1024).toFixed(0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const removeQuietly = (file) => fsp.rm(file, { force: true }).catch(() => {});
/** Usage/config problem: the user has to change a flag, a path or the registry — exit 2. */
const configError = (message) => Object.assign(new Error(message), { config: true });
const isHealthy = async (getJson, url) => ((await getJson(url, 1500)) ?? {}).status === "ok";

// Safety net: if this launcher dies for any reason, it never leaves a llama-server it started
// behind. A llama.cpp it merely reused is not in here and stays untouched.
let spawnedLlama = null;
process.on("exit", () => {
  if (spawnedLlama && spawnedLlama.exitCode === null && spawnedLlama.signalCode === null) {
    try {
      spawnedLlama.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
});

/** Print the registry: id, label, size, downloaded state, default marker. */
function listModels({ loadLocalModels, localPaths }) {
  const registry = loadLocalModels();
  const modelsDir = localPaths().models;
  const rows = Object.entries(registry.models).map(([id, entry]) => ({ id, ...entry, downloaded: fs.existsSync(path.join(modelsDir, entry.file)) }));
  const idWidth = Math.max(...rows.map((row) => row.id.length));
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  process.stdout.write(`jev-local models — ${registry.path}\n\n`);
  for (const row of rows) {
    const marker = row.id === registry.default ? "*" : " ";
    process.stdout.write(`${marker} ${row.id.padEnd(idWidth)}  ${row.label.padEnd(labelWidth)}  ${humanBytes(row.bytes).padStart(8)}  ${row.file}${row.downloaded ? "  [downloaded]" : ""}\n`);
  }
  process.stdout.write(`\n* = default. Serve one with --model-name <id>; switch permanently by editing "default".\n`);
  return 0;
}

/** Stream the model to `<file>.partial`, then rename, so a half-download is never used. */
async function ensureModel({ file, url, expectedBytes }) {
  const existing = await fsp.stat(file).catch(() => null);
  if (existing) {
    if (expectedBytes && existing.size !== expectedBytes) throw configError(`${file} is ${existing.size} bytes but the registry says ${expectedBytes}; delete it and run again to re-download`);
    log(`[local] model ready: ${file} (${humanBytes(existing.size)})`);
    return { downloaded: false, bytes: existing.size };
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  log(`[local] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`);
  const contentLength = Number(response.headers.get("content-length")) || 0;
  const total = expectedBytes || contentLength;
  let received = 0;
  let lastReport = 0;
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastReport < 500 && received !== total) return;
    lastReport = now;
    const share = total ? ` / ${mib(total)} MiB (${((received / total) * 100).toFixed(0)}%)` : " MiB";
    process.stderr.write(`\r[local] ${mib(received)}${share}`);
  });
  try {
    await pipeline(body, fs.createWriteStream(partial));
  } catch (error) {
    await removeQuietly(partial);
    throw error;
  }
  process.stderr.write("\n");
  if (total && received !== total) {
    await removeQuietly(partial);
    throw new Error(`download truncated: got ${received} of ${total} bytes`);
  }
  await fsp.rename(partial, file);
  log(`[local] model ready: ${file} (${humanBytes(received)})`);
  return { downloaded: true, bytes: received };
}

/** Start llama-server; only a process started here is ever killed here. */
function spawnLlamaServer(bin, { modelFile, llamaPort, ctx }) {
  const args = ["-m", modelFile, "--host", "127.0.0.1", "--port", String(llamaPort), "-c", String(ctx), "-ngl", "99", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "-t", "8"];
  log(`[local] starting llama-server: ${bin} ${args.join(" ")}`);
  return spawn(bin, args, { stdio: ["ignore", "ignore", "inherit"] });
}

async function waitForLlama(getJson, child, url, { timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(getJson, url)) return true;
    if (child.exitCode !== null || child.signalCode !== null) return false;
    await sleep(500);
  }
  return false;
}

async function main() {
  if (flag("--help") || flag("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  let local;
  try {
    local = await import("../lib/local.mjs");
  } catch (error) {
    log(`[local] ${error.message}`);
    return 2;
  }
  const { LOCAL_DEFAULTS, LocalProvider, SERVICE, defaultLocalModel, findLlamaServer, getJson, handleLocalRequest, llamaServedModel, localModel, localPaths } = local;

  const port = Number(arg("--port", LOCAL_DEFAULTS.port));
  const llamaPort = Number(arg("--llama-port", LOCAL_DEFAULTS.llamaPort));
  const ctx = Number(arg("--ctx", LOCAL_DEFAULTS.ctx));
  const explicitPath = arg("--model", null);
  const requestedId = arg("--model-name", null);
  const urlOverride = arg("--model-url", "")?.trim() || process.env.JEV_LOCAL_MODEL_URL?.trim() || null;
  const downloadOnly = flag("--download-only");
  const serviceUrl = `http://127.0.0.1:${port}`;
  const llamaUrl = `http://127.0.0.1:${llamaPort}`;
  const envLine = `TYPESAFE_BASE_URL=${serviceUrl} TYPESAFE_API_KEY=local`;

  if (!Number.isInteger(port) || port < 1 || port > 65535) throw configError(`--port must be 1..65535 (got ${arg("--port")})`);
  if (!Number.isInteger(llamaPort) || llamaPort < 1 || llamaPort > 65535) throw configError(`--llama-port must be 1..65535 (got ${arg("--llama-port")})`);
  if (!Number.isInteger(ctx) || ctx < 512) throw configError(`--ctx must be an integer >= 512 (got ${arg("--ctx")})`);
  if (ctx < 12_000) log(`[local] warning: --ctx ${ctx} is below the ~11,700 tokens a 100-candidate step renders to; long pages will fail`);
  if (explicitPath && requestedId) throw configError("use either --model-name <id> or --model <path>, not both");

  if (flag("--list-models")) return listModels(local);

  // Resolve which GGUF to serve: a registry entry (default or --model-name), or an explicit path.
  const entry = requestedId ? localModel(requestedId) : explicitPath ? null : defaultLocalModel();
  const file = explicitPath ? path.resolve(explicitPath) : localPaths(undefined, entry).modelFile;
  const url = urlOverride ?? entry?.url ?? null;
  const expectedBytes = entry && url === entry.url ? entry.bytes : null;
  const modelName = entry?.id ?? path.basename(file).replace(/\.gguf$/i, "");
  const runDir = localPaths().run;
  const pidFile = path.join(runDir, `jev-local-${port}.pid`);

  const existing = await fsp.stat(file).catch(() => null);
  if (!existing && !url) throw configError(`model file not found: ${file}\npass --model-name <id> to use the registry, or --model-url <url> to download it`);
  await ensureModel({ file, url, expectedBytes });
  if (downloadOnly) {
    log(`[local] ${modelName} is ready; not starting anything (--download-only)`);
    return 0;
  }

  // Already serving? Reuse only when it is the same model; otherwise say exactly what is wrong.
  const running = await getJson(`${serviceUrl}/health`, 1500);
  if (running?.service === SERVICE) {
    if (running.model && running.model !== modelName) {
      log(`[local] ${serviceUrl} is already serving "${running.model}", not "${modelName}".`);
      log(`[local] stop that launcher first (Ctrl-C in its terminal, or kill $(cat ${pidFile})), then run again.`);
      return 2;
    }
    log(`[local] already serving on ${serviceUrl}; reusing it`);
    process.stdout.write(`${envLine}\n`);
    return 0;
  }

  const bin = findLlamaServer();
  if (!bin) {
    log("[local] llama-server not found (looked on PATH and in /opt/homebrew/bin).\n\nInstall it with:\n\n  brew install llama.cpp\n");
    return 2;
  }
  log(`[local] llama-server: ${bin}`);

  let llama = null;
  if (await isHealthy(getJson, `${llamaUrl}/health`)) {
    const served = await llamaServedModel(llamaUrl);
    if (served && path.resolve(served) !== file) {
      log(`[local] llama.cpp on ${llamaUrl} is serving ${served}, not ${file}.`);
      log(`[local] stop that server, or keep both by giving this one its own port: --llama-port ${llamaPort + 1}`);
      return 2;
    }
    log(`[local] llama.cpp already serving on ${llamaUrl}${served ? "" : " (could not read its model path)"} (left untouched on exit)`);
  } else {
    llama = spawnLlamaServer(bin, { modelFile: file, llamaPort, ctx });
    spawnedLlama = llama;
    let spawnError = null;
    llama.once("error", (error) => {
      spawnError = error;
    });
    const stopLlama = () => {
      try {
        llama.kill("SIGTERM");
      } catch {
        // already gone
      }
    };
    let ready = false;
    try {
      ready = await waitForLlama(getJson, llama, `${llamaUrl}/health`);
    } catch (error) {
      stopLlama(); // never leave a half-started server behind
      throw error;
    }
    if (!ready) {
      stopLlama();
      throw new Error(spawnError ? `llama-server failed to start: ${spawnError.message}` : `llama-server did not become ready on ${llamaUrl} within 180s (see its output above)`);
    }
    log(`[local] llama.cpp serving on ${llamaUrl} (pid ${llama.pid}, -c ${ctx})`);
  }

  const provider = new LocalProvider({ url: llamaUrl, model: modelName });
  const server = http.createServer((req, res) => {
    handleLocalRequest(req, res, provider).catch(() => {}); // the handler answers every path
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    const occupant = await fetchJson(`${serviceUrl}/health`, 1500);
    if (occupant?.service === SERVICE) {
      process.stdout.write(`${envLine}\n`);
      return 0;
    }
    if (llama) llama.kill("SIGTERM");
    throw new Error(`cannot listen on 127.0.0.1:${port}: ${error.message}`);
  }

  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(pidFile, `${process.pid}\n`);
  let llamaPidFile = null;
  if (llama) {
    llamaPidFile = path.join(runDir, `llama-${llamaPort}.pid`);
    await fsp.writeFile(llamaPidFile, `${llama.pid}\n`);
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`[local] ${signal} — stopping${llama ? " (llama-server was started here, stopping it too)" : ""}`);
    await new Promise((resolve) => server.close(resolve));
    if (llama) {
      llama.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => llama.once("exit", resolve)), sleep(5000)]);
    }
    await removeQuietly(pidFile);
    if (llamaPidFile) await removeQuietly(llamaPidFile);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  llama?.on("exit", (code) => {
    if (!stopping) log(`[local] llama-server exited (code ${code}); the Jev server will report backend-down`);
  });

  log(`[local] serving /v1/systemone on ${serviceUrl} (${modelName}${entry?.label ? ` · ${entry.label}` : ""}); Ctrl-C to stop`);
  log("[local] limits: short states only, no images, no few-shot — see experiments/gguf-provider/RESULTS.md");
  process.stdout.write(`${envLine}\n`);
  return null; // keep running
}

main()
  .then((code) => {
    if (code !== null) process.exit(code);
  })
  .catch((error) => {
    log(`[local] ${error.message}`);
    process.exit(error.config || error.name === "LocalModelRegistryError" ? 2 : 1);
  });
