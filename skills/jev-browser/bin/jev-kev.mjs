#!/usr/bin/env node
// One command for the Kev accuracy tier of jev-browser (experimental): fetch the checkpoint and its
// base into the HuggingFace cache layout the Kev loader expects, start the Kev server, and print the
// TypeSafe env line for the skill.
//
// This is the accuracy tier, NOT the default. The default stays the zero-Python llama.cpp + GGUF
// readout (bin/jev-local.mjs); Kev is a trained pointer-head checkpoint served by its own MLX runtime
// and costs a Python venv, a 9.34 GB base plus the adapter, ~18 GB idle / 36 GB GPU footprint under
// load at the raised limit, and ~2.2 s mean / 12.2 s worst per item.
//
//   node skills/jev-browser/bin/jev-kev.mjs
//   node skills/jev-browser/bin/jev-kev.mjs --verify-only      # re-hash the cache, download nothing
//   node skills/jev-browser/bin/jev-kev.mjs --patch-row-limit  # optional, explicit, prints the diff
//   TYPESAFE_BASE_URL=http://127.0.0.1:8008 TYPESAFE_API_KEY=local \
//     node skills/jev-browser/bin/jev-browser.mjs judge --state-file s.json --questions-file q.json
//
// Everything except the final `TYPESAFE_BASE_URL=... TYPESAFE_API_KEY=local` line goes to stderr, so
// that line can be piped or eval'd. See experiments/kev-4b/README.md for what each tier scores.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ---------------------------------------------------------------------------- assets

// Pinned to a commit: names, sizes and hashes come from the Hub tree metadata at that commit and are
// what every download is verified against. `hash` is the sha256 of the file for LFS blobs, and the
// git blob sha1 for the small text files — the same rule the Hub uses. Injected by
// experiments/kev-4b/make-manifest.mjs from the verified cache; see that file for provenance.
const KEV_ASSETS = {
  run: {
    repo: "jaredpalmer/kev-4b",
    commit: "485ace8703592fcf405488b262449990824cfed1",
    files: [
      { name: ".gitattributes", size: 1570, kind: "git-sha1", hash: "52373fe24473b1aa44333d318f578ae6bf04b49b" },
      { name: "adapter_config.json", size: 1271, kind: "git-sha1", hash: "ea5c33529f3e0e9521f52b42485d44a23d333ba7" },
      { name: "adapter_model.safetensors", size: 129924032, kind: "sha256", hash: "9797de69a42188e411b17b7b4fcb66a23374dcebc21d71a7a66f836b5d34df2b" },
      { name: "added_tokens.json", size: 707, kind: "git-sha1", hash: "b54f9135e44c1e81047e8d05cb027af8bc039eed" },
      { name: "head.pt", size: 5248767, kind: "sha256", hash: "d8f796da36ff7bd7c0fb9496b452139bb7851af4fc82b07b500b682d3f721d6a" },
      { name: "merges.txt", size: 1671853, kind: "git-sha1", hash: "31349551d90c7606f325fe0f11bbb8bd5fa0d7c7" },
      { name: "provenance.json", size: 3140, kind: "git-sha1", hash: "318576caaa383eb7bdd2e10ba320e0b7330de591" },
      { name: "README.md", size: 11699, kind: "git-sha1", hash: "28d99f291e91401d81ef48b8f4ddfc2c9b8563a4" },
      { name: "result.json", size: 73953, kind: "git-sha1", hash: "b75a6b940b022394255f19484ebb63d2bfde33cc" },
      { name: "special_tokens_map.json", size: 616, kind: "git-sha1", hash: "17305b3603dfb19ccc0f658ec2cd2cd3adff4a58" },
      { name: "tokenizer_config.json", size: 1128, kind: "git-sha1", hash: "fa833096a2f03c2ff89094eb1ba7716fbd98b102" },
      { name: "tokenizer.json", size: 19989325, kind: "sha256", hash: "06b9509352d2af50381ab2247e083b80d32d5c0aba91c272ca9ff729b6a0e523" },
      { name: "train.log", size: 3389, kind: "git-sha1", hash: "a62bf77835de9283696656eca66afe4efcdac534" },
      { name: "training_config.json", size: 1586, kind: "git-sha1", hash: "07c40996cb96787387db7a4f89df876cb1361099" },
      { name: "training_metrics.json", size: 320, kind: "git-sha1", hash: "b5bae5408ab4e831f84247cb28a54fd46abb2951" },
      { name: "vocab.json", size: 2776833, kind: "git-sha1", hash: "4783fe10ac3adce15ac8f358ef5462739852c569" },
    ],
  },
  base: {
    repo: "Qwen/Qwen3.5-4B-Base",
    commit: "1001bb4d826a52d1f399e183466143f4da7b741b",
    files: [
      { name: ".gitattributes", size: 1570, kind: "git-sha1", hash: "52373fe24473b1aa44333d318f578ae6bf04b49b" },
      { name: "config.json", size: 3161, kind: "git-sha1", hash: "557d961b205319c6a7da5f757f565b69b3967b7d" },
      { name: "LICENSE", size: 11343, kind: "git-sha1", hash: "1d5180a42f1c3383ba7c7bd0a50f0837ef0168df" },
      { name: "merges.txt", size: 3353259, kind: "git-sha1", hash: "a494e019ca1502219fd0128658b979e5f05ae8e8" },
      { name: "model.safetensors-00001-of-00002.safetensors", size: 5329398712, kind: "sha256", hash: "df547074dce70532a0493e5433152bd17a65efb89088cfabc2e7e2371a93d712" },
      { name: "model.safetensors-00002-of-00002.safetensors", size: 3990429344, kind: "sha256", hash: "590fbaac095dd31db886c322d9d2f7df47777966391acf306ddddc3e4e3a15ef" },
      { name: "model.safetensors.index.json", size: 76196, kind: "git-sha1", hash: "7586335c0c85f13864338166a651bc2afbf49849" },
      { name: "preprocessor_config.json", size: 390, kind: "git-sha1", hash: "2ea84a437d448ff71b08df68fdd949d5cc4ebb64" },
      { name: "README.md", size: 3722, kind: "git-sha1", hash: "f66751fce75ca423e0993107b38d4c5408f677fb" },
      { name: "tokenizer_config.json", size: 16713, kind: "git-sha1", hash: "ae8d254e44c51d0cb0907bcb221f18efca829d3e" },
      { name: "tokenizer.json", size: 12807196, kind: "sha256", hash: "fe000e3ed39ed12b8d2481d527d44f93c65d37e87645d2dcc80d1bf9d50d2927" },
      { name: "video_preprocessor_config.json", size: 386, kind: "git-sha1", hash: "37900b3ff9295e1aa7e211378466356b52e64e55" },
      { name: "vocab.json", size: 6722759, kind: "git-sha1", hash: "0aa0ce0658d60ac4a5d609f4eadb0e8e43514176" },
    ],
  },
};

// Where the bytes come from, best first. ModelScope is the only independent mirror and measured ~5.5
// MB/s against HF's 1.6–2.3; hf-mirror redirects to HF but is kept as a third rung. A source that
// yields a file failing verification is demoted for the rest of the run (ModelScope serves a
// different .gitattributes, so its small files are expected to fail and fall through to HF).
const SOURCES = ["modelscope", "hf", "hf-mirror"];

const DEFAULT_CLONE = path.join(os.homedir(), ".local", "share", "jev-browser", "kev");
const CACHE = path.join(os.homedir(), ".cache", "huggingface", "hub");
const RUN_ID = KEV_ASSETS.run.repo;
const BASE_ID = KEV_ASSETS.base.repo;
const SMALL_FILE = 1024 * 1024;
const STALL_MS = 120_000; // no bytes for this long on one source → try the next
const READY_MS = 420_000; // model assembly (~22 s for the 4B) + server start

const HELP = `jev-kev — serve the Kev accuracy tier of the local Jev backend for jev-browser

Usage:
  jev-kev [--port 8008] [--run ${RUN_ID}] [--clone <dir>]
  jev-kev --verify-only                 re-hash the whole cache; download nothing
  jev-kev --download-only               fetch the checkpoint and its base, start nothing
  jev-kev --list-files                  print the pinned manifest and exit
  jev-kev --patch-row-limit             apply the optional row-limit patch to the local clone
  jev-kev --unpatch-row-limit           revert it

What it does, in order:
  1. fetches ${RUN_ID} (16 files, 152 MiB) and its base ${BASE_ID}
     (13 files, 9.34 GB) into ~/.cache/huggingface/hub, resuming .incomplete parts and never
     re-downloading a file whose size and hash already match
  2. starts the Kev server (${DEFAULT_CLONE.replace(os.homedir(), "~")}/.venv/bin/python -m kev.serve)
  3. prints, and only then prints:
       TYPESAFE_BASE_URL=http://127.0.0.1:8008 TYPESAFE_API_KEY=local

Sources (fastest first, falls through on a stall or a verification failure):
      --source <name>    pin one: modelscope | hf | hf-mirror
      --sources <a,b,c>  set the whole order

Optional row-limit patch — off by default, and never applied silently:
  The released server caps a request at state + one branch <= 8192 tokens (kev/model.py), so the
  55-option click_target questions on a real page are REFUSED with HTTP 422. Published behaviour is
  18/20 on the 20 graded items with that 422; the patch makes the cap settable and reaches 19/20.
      --patch-row-limit    one explicit edit to the local clone, prints the diff and the revert command
      --row-limit <tokens> serve with the cap raised (requires --patch-row-limit; without the patch
                           the server has no such knob and this exits 2)

Tuning:
      --port N           port of the Kev server              (default 8008)
      --run <id>         checkpoint to serve                 (default ${RUN_ID})
      --clone <dir>      Kev checkout to use                 (default ${DEFAULT_CLONE.replace(os.homedir(), "~")})
      --timeout <secs>   wait for the server to become ready (default ${READY_MS / 1000})
  -h, --help             this text

Env (passed through to the server): KEV_TEMPERATURE, KEV_BACKEND, KEV_DTYPE, KEV_PREFIX_CACHE, ...
  HF_HUB_OFFLINE=1 is set for the server: the launcher has already verified the cache.

Exit codes: 0 ok · 1 runtime failure · 2 usage/config (missing venv, port busy, wrong checkpoint)
            · 3 a file failed size/hash verification and was removed

A server already answering on --port is reused when it serves the same checkpoint and reported as a
conflict otherwise; one this launcher started is stopped with it.
`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const log = (message) => process.stderr.write(`${message}\n`);
const humanBytes = (bytes) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const configError = (message) => Object.assign(new Error(message), { config: true });

// ---------------------------------------------------------------------------- fetching

const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

/** The git blob id of a file: sha1("blob <size>\0" + content) — how the Hub names small files. */
const gitBlobOid = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    hash.update(`blob ${fs.statSync(file).size}\0`);
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

const repoDir = (repo) => path.join(CACHE, `models--${repo.replace("/", "--")}`);

/** Return { ok, how, want, got } for one cached blob against its pinned metadata. */
async function verifyBlob(target, entry) {
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat) return { ok: false, how: "missing", want: null, got: null };
  if (stat.size !== entry.size) return { ok: false, how: "size", want: entry.size, got: stat.size };
  const got = entry.kind === "sha256" ? await sha256File(target) : await gitBlobOid(target);
  return { ok: got === entry.hash, how: entry.kind, want: entry.hash, got };
}

const sourceUrl = (source, repo, commit, name) => {
  if (source === "modelscope") return `https://modelscope.cn/api/v1/models/${repo}/repo?Revision=master&FilePath=${encodeURIComponent(name)}`;
  const host = source === "hf-mirror" ? "https://hf-mirror.com" : "https://huggingface.co";
  return `${host}/${repo}/resolve/${commit}/${name}`;
};

/**
 * Stream one URL into `part`, resuming when the server honours Range. Returns the bytes on disk.
 * Throws `{ stall: true }` when no bytes arrive for STALL_MS so the caller can try the next source.
 */
async function transfer(url, part, { expectedBytes }) {
  const have = (await fsp.stat(part).catch(() => null))?.size ?? 0;
  const headers = { "user-agent": "jev-kev/1" };
  if (have > 0) headers.range = `bytes=${have}-`;
  if (!/^https:/.test(url)) throw new Error(`refusing a non-https source: ${url}`);

  const controller = new AbortController();
  let timer = null;
  const armStall = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(Object.assign(new Error("stalled"), { stall: true })), STALL_MS);
  };
  armStall();

  let received = have;
  const started = Date.now();
  let lastReport = 0;
  try {
    const response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
    if (response.status === 416) {
      // The server thinks we already have everything; keep the part and let verification judge it.
      return have;
    }
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} ${response.statusText}`), { status: response.status });
    const resuming = response.status === 206 && have > 0;
    if (!resuming) received = 0;
    if (!response.body) throw new Error("empty response body");
    const total = resuming && response.headers.get("content-range")?.includes("/")
      ? Number(response.headers.get("content-range").split("/")[1]) || expectedBytes
      : Number(response.headers.get("content-length")) || expectedBytes;

    const body = Readable.fromWeb(response.body);
    body.on("data", (chunk) => {
      received += chunk.length;
      armStall();
      const now = Date.now();
      if (now - lastReport < 1000 && received !== total) return;
      lastReport = now;
      const mbps = received - (resuming ? have : 0) === 0 ? 0 : ((received - (resuming ? have : 0)) / 1e6 / Math.max((now - started) / 1000, 1e-3));
      process.stderr.write(`\r[kev] ${humanBytes(received)} / ${humanBytes(total)} (${Math.floor((received / total) * 100)}%) ${mbps.toFixed(2)} MB/s   `);
    });
    await pipeline(body, fs.createWriteStream(part, { flags: resuming ? "a" : "w" }));
    process.stderr.write("\r\x1b[K");
    if (total && received !== total) throw new Error(`truncated: got ${received} of ${total} bytes`);
    return received;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch one file: try each source until one lands bytes that match the pinned metadata. */
async function ensureFile({ repo, commit, name, entry, demoted, report }) {
  await fsp.mkdir(path.join(repoDir(repo), "blobs"), { recursive: true });
  const target = path.join(repoDir(repo), "blobs", entry.hash);
  const part = `${target}.incomplete`;
  const existing = await verifyBlob(target, entry);
  if (existing.ok) {
    await fsp.rm(part, { force: true });
    report.skipped.push(name);
    return { ok: true, source: "cache", how: existing.how };
  }

  const small = entry.size < SMALL_FILE;
  const sources = SOURCES.filter((source) => !demoted.has(`${repo}|${source}${small ? "|small" : ""}`));
  if (sources.length === 0) throw Object.assign(new Error(`every source was demoted for ${name}`), { verify: true });

  const failures = [];
  for (const source of sources) {
    const url = sourceUrl(source, repo, commit, name);
    const started = Date.now();
    try {
      const bytes = await transfer(url, part, { expectedBytes: entry.size });
      const result = await verifyBlob(part, entry);
      const seconds = Math.max((Date.now() - started) / 1000, 1e-3);
      if (!result.ok) {
        failures.push(`${source}: ${result.how} want=${result.want ?? "?"} got=${result.got ?? "?"}`);
        await fsp.rm(part, { force: true }); // never keep bytes that failed the published metadata
        if (small) demoted.add(`${repo}|${source}|small`);
        log(`[kev] ${name}: ${source} served a file that does not match the published metadata (${result.how}) — trying the next source`);
        continue;
      }
      await fsp.rename(part, target);
      log(`[kev] ${name} ← ${source} (${humanBytes(bytes)} in ${seconds.toFixed(1)}s, ${(bytes / 1e6 / seconds).toFixed(2)} MB/s, ${result.how} verified)`);
      report.fetched.push({ name, source, bytes, seconds: Number(seconds.toFixed(1)) });
      await fsp.rm(`${target}.incomplete`, { force: true });
      return { ok: true, source, how: result.how };
    } catch (error) {
      await fsp.rm(part, { force: true });
      failures.push(`${source}: ${error.stall ? `no bytes for ${STALL_MS / 1000}s` : error.message}`);
      log(`[kev] ${name}: ${source} failed (${error.stall ? `stalled for ${STALL_MS / 1000}s` : error.message})`);
    }
  }
  const error = new Error(`${name} could not be fetched from any source:\n  ${failures.join("\n  ")}`);
  error.verify = true;
  throw error;
}

/** Fetch + verify one repo, writing the cache layout the Kev loader resolves: blobs, refs, snapshots. */
async function ensureRepo({ key, verifyOnly }) {
  const { repo, commit, files } = KEV_ASSETS[key];
  const dir = repoDir(repo);
  const report = { repo, commit, skipped: [], fetched: [], verified: 0, bytes: 0, mismatch: [] };
  const demoted = new Set();
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const missing = [];
  for (const file of files) {
    const ok = (await verifyBlob(path.join(dir, "blobs", file.hash), file)).ok;
    if (ok) report.verified += 1;
    else missing.push(file);
  }
  log(
    `[kev] ${repo}@${commit.slice(0, 8)}: ${files.length} files, ${humanBytes(total)} — ` +
      `${report.verified} verified${verifyOnly || missing.length === 0 ? "" : `, ${missing.length} to fetch (${humanBytes(missing.reduce((sum, f) => sum + f.size, 0))})`}`,
  );

  if (!verifyOnly) {
    // Largest first: the big shards grab the fastest source while it is still cheap to switch.
    for (const file of [...missing].sort((a, b) => b.size - a.size)) {
      await ensureFile({ repo, commit, name: file.name, entry: file, demoted, report });
      report.bytes += file.size;
    }
  }

  // Re-hash everything on disk and rebuild refs/snapshots from exactly what was verified.
  await fsp.mkdir(path.join(dir, "refs"), { recursive: true });
  await fsp.mkdir(path.join(dir, "trees"), { recursive: true });
  await fsp.writeFile(path.join(dir, "refs", "main"), commit);
  const treeFiles = {};
  for (const file of files) treeFiles[file.name] = file.kind === "sha256" ? { size: file.size, blob_id: file.hash, lfs_sha256: file.hash } : { size: file.size, blob_id: file.hash };
  await fsp.writeFile(path.join(dir, "trees", `${commit}.json`), JSON.stringify({ format_version: 1, files: treeFiles }, null, 1));

  const snapshot = path.join(dir, "snapshots", commit);
  await fsp.mkdir(snapshot, { recursive: true });
  for (const file of files) {
    const result = await verifyBlob(path.join(dir, "blobs", file.hash), file);
    const link = path.join(snapshot, file.name);
    if (result.ok) {
      await fsp.rm(link, { force: true });
      await fsp.symlink(path.relative(snapshot, path.join(dir, "blobs", file.hash)), link);
    } else {
      report.mismatch.push({ file: file.name, ...result });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------- clone + server

/** A guard for the exact bytes this launcher's patch produces. */
const PATCH_MARK = "KEV_SERVE_MAX_STATE";
const PATCH_REVERT = `cd ${DEFAULT_CLONE} && git checkout -- kev/model.py`;
const RELEASED_LINE = "SERVE_MAX_STATE, SERVE_MAX_BRANCH = 8192, 8192";
const PATCHED_LINES = [
  "# LOCAL EVALUATION PATCH (not upstream): the served row limit is state + one branch, and a Jev-shaped browser",
  "# state with a long option list exceeds 8192. Defaults are byte-identical to the released constants; raise with",
  "# KEV_SERVE_MAX_STATE / KEV_SERVE_MAX_BRANCH. Everything derived below (SERVE_MAX_PACKED, MAX_TRAIN_STATE) follows.",
  'SERVE_MAX_STATE = int(os.environ.get("KEV_SERVE_MAX_STATE", "8192"))',
  'SERVE_MAX_BRANCH = int(os.environ.get("KEV_SERVE_MAX_BRANCH", "8192"))',
];

async function patchRowLimit(clone) {
  const file = path.join(clone, "kev", "model.py");
  const source = await fsp.readFile(file, "utf8").catch(() => null);
  if (source === null) throw configError(`cannot read ${file} — is --clone pointing at a Kev checkout?`);
  if (source.includes(PATCH_MARK)) {
    log(`[kev] row-limit patch already applied to ${file}; nothing to do`);
    log(`[kev] revert with: ${PATCH_REVERT}`);
    return;
  }
  if (!source.includes(RELEASED_LINE)) throw configError(`${file} does not contain the released line\n  ${RELEASED_LINE}\nrefusing to patch — this checkout is not the version the launcher was written against`);
  await fsp.writeFile(file, source.replace(RELEASED_LINE, PATCHED_LINES.join("\n")));
  log(`[kev] applied the optional row-limit patch to ${file}\n`);
  log(`--- a/kev/model.py`);
  log(`+++ b/kev/model.py`);
  log(`@@ line 15 @@`);
  log(`-${RELEASED_LINE}`);
  for (const line of PATCHED_LINES) log(`+${line}`);
  log(`\n[kev] this is a LOCAL EVALUATION PATCH on a third-party clone, not upstream, and it is not`);
  log(`[kev] applied by default: published behaviour is 18/20 on the 20 graded items with a 422 on`);
  log(`[kev] the 55-option click_target questions. The defaults are unchanged (8192); raise the cap`);
  log(`[kev] for one run with --row-limit <tokens>.`);
  log(`[kev] revert with: ${PATCH_REVERT}`);
}

async function unpatchRowLimit(clone) {
  const file = path.join(clone, "kev", "model.py");
  const source = await fsp.readFile(file, "utf8").catch(() => null);
  if (source === null) throw configError(`cannot read ${file} — is --clone pointing at a Kev checkout?`);
  if (!source.includes(PATCH_MARK)) {
    log(`[kev] the row-limit patch is not applied to ${file}; nothing to revert`);
    return;
  }
  await fsp.writeFile(file, source.replace(PATCHED_LINES.join("\n"), RELEASED_LINE));
  log(`[kev] reverted the row-limit patch in ${file} — the server is back to the published 8192 cap`);
}

const patchApplied = async (clone) => (await fsp.readFile(path.join(clone, "kev", "model.py"), "utf8").catch(() => "")).includes(PATCH_MARK);

/** The venv python, with the exact command that creates it when it is missing. */
async function findPython(clone) {
  const python = path.join(clone, ".venv", "bin", "python");
  if (!fs.existsSync(clone)) {
    throw configError(
      `Kev checkout not found at ${clone}\n\nClone it with:\n\n  git clone --depth 1 https://github.com/jaredpalmer/kev.git ${clone}\n  uv sync --extra serve --project ${clone}\n`,
    );
  }
  if (!fs.existsSync(python)) {
    throw configError(
      `no Python venv at ${path.join(clone, ".venv")}\n\nCreate it with:\n\n  uv sync --extra serve --project ${clone}\n\n` +
        `(uv follows the repo's .python-version, 3.13 — not 3.14, which has no torch wheel)`,
    );
  }
  const probe = await run(python, ["-c", "import torch, mlx_lm; print('ok')"], { cwd: clone, quiet: true }).catch((error) => error);
  if (probe instanceof Error || probe.code !== 0) {
    const detail = (probe instanceof Error ? probe.message : `${probe.stdout}${probe.stderr}`).trim().split("\n").slice(-3).join("\n");
    throw configError(
      `the venv at ${python} cannot import torch and mlx_lm, so the MLX backend is unavailable\n  ${detail}\n\n` +
        `Install the serving extras with:\n\n  uv sync --extra serve --project ${clone}\n`,
    );
  }
  return python;
}

function run(application, args, { cwd, env, quiet } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(application, args, { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!quiet) process.stderr.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (!quiet) process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function getJson(url, timeoutMs = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

let spawned = null;
process.on("exit", () => {
  if (spawned && spawned.exitCode === null && spawned.signalCode === null) {
    try {
      spawned.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
});

// ---------------------------------------------------------------------------- main

function listFiles() {
  process.stdout.write(`Pinned manifest · captured from the Hub tree metadata at these commits\n\n`);
  for (const [key, repo] of Object.entries(KEV_ASSETS)) {
    const bytes = repo.files.reduce((sum, file) => sum + file.size, 0);
    process.stdout.write(`${key === "run" ? "checkpoint" : "base      "}  ${repo.repo}@${repo.commit}\n  ${repo.files.length} files, ${bytes.toLocaleString()} bytes\n`);
    for (const file of repo.files) process.stdout.write(`    ${String(file.size).padStart(13)}  ${file.kind.padEnd(9)}  ${file.hash.slice(0, 16)}…  ${file.name}\n`);
    process.stdout.write(`\n`);
  }
  process.stdout.write(`${SOURCES.length} sources, tried in this order: ${SOURCES.join(" → ")}\n`);
  return 0;
}

async function main() {
  if (flag("--help") || flag("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const clone = path.resolve(arg("--clone", DEFAULT_CLONE));
  const port = Number(arg("--port", 8008));
  const run = arg("--run", RUN_ID);
  const timeoutMs = Number(arg("--timeout", READY_MS / 1000)) * 1000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw configError(`--port must be 1..65535 (got ${arg("--port")})`);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) throw configError(`--timeout must be at least 10 seconds (got ${arg("--timeout")})`);
  if (run !== RUN_ID) {
    throw configError(
      `--run ${run} is not the pinned checkpoint (${RUN_ID}).\n` +
        `This launcher only fetches and verifies ${RUN_ID} and ${BASE_ID}; serving another run needs its\n` +
        `own manifest. Fetch it by hand (experiments/kev-4b/fetch.py) and start the server directly.`,
    );
  }
  const requestedSources = arg("--sources", null)?.split(",").map((s) => s.trim()).filter(Boolean) ?? (arg("--source", null) ? [arg("--source")] : null);
  if (requestedSources) {
    const unknown = requestedSources.filter((source) => !SOURCES.includes(source));
    if (unknown.length) throw configError(`unknown source(s): ${unknown.join(", ")} (known: ${SOURCES.join(", ")})`);
    SOURCES.splice(0, SOURCES.length, ...requestedSources);
  }

  if (flag("--list-files")) return listFiles();
  if (flag("--patch-row-limit")) {
    await patchRowLimit(clone);
    return 0;
  }
  if (flag("--unpatch-row-limit")) {
    await unpatchRowLimit(clone);
    return 0;
  }

  const rowLimit = arg("--row-limit", null);
  if (rowLimit !== null) {
    const tokens = Number(rowLimit);
    if (!Number.isInteger(tokens) || tokens < 8192) throw configError(`--row-limit must be an integer >= 8192 (got ${rowLimit})`);
    if (!(await patchApplied(clone))) {
      throw configError(
        `--row-limit ${tokens} needs the optional row-limit patch, which is not applied to ${clone}.\n\n` +
          `The released server hard-codes the cap (kev/model.py) and accepts no flag or env var for it.\n` +
          `Apply it explicitly first — it prints the diff and the revert command:\n\n  jev-kev --patch-row-limit\n`,
      );
    }
  }

  const verifyOnly = flag("--verify-only");
  const downloadOnly = flag("--download-only");
  // Check the runtime before the (expensive) cache verification: a missing venv should fail in a
  // second, not after re-hashing 9.5 GB. --verify-only and --download-only never need it.
  const python = verifyOnly || downloadOnly ? null : await findPython(clone);

  const reports = [];
  for (const key of ["run", "base"]) {
    reports.push(await ensureRepo({ key, verifyOnly }));
  }
  const fetchedBytes = reports.reduce((sum, report) => sum + report.bytes, 0);
  const mismatches = reports.flatMap((report) => report.mismatch.map((row) => ({ repo: report.repo, ...row })));
  if (mismatches.length) {
    for (const row of mismatches) log(`[kev] BAD ${row.repo}/${row.file}: ${row.how} want=${row.want} got=${row.got}`);
    const error = new Error(`${mismatches.length} file(s) do not match the published metadata and were left out of the cache`);
    error.verify = true;
    throw error;
  }
  log(`[kev] cache verified: ${reports.map((r) => `${r.repo} ${r.verified}/${r.verified + r.fetched.length}`).join(", ")} (${humanBytes(fetchedBytes)} fetched this run)`);
  if (verifyOnly) {
    log(`[kev] --verify-only: nothing downloaded, nothing started`);
    return 0;
  }
  if (downloadOnly) {
    log(`[kev] --download-only: assets ready, not starting anything`);
    return 0;
  }

  const serviceUrl = `http://127.0.0.1:${port}`;
  const envLine = `TYPESAFE_BASE_URL=${serviceUrl} TYPESAFE_API_KEY=local`;

  const running = await getJson(`${serviceUrl}/v1/models`, 1500);
  const served = running?.models?.find((model) => model.name === "kev-latest");
  if (served) {
    if (served.run !== run) {
      log(`[kev] ${serviceUrl} is already serving "${served.run}", not "${run}".`);
      log(`[kev] stop that server first (Ctrl-C in its terminal), then run again.`);
      return 2;
    }
    log(`[kev] already serving ${served.run} on ${serviceUrl}; reusing it`);
    process.stdout.write(`${envLine}\n`);
    return 0;
  }

  const env = { ...process.env, HF_HUB_OFFLINE: "1" };
  if (rowLimit !== null) {
    env.KEV_SERVE_MAX_STATE = String(Number(rowLimit));
    env.KEV_SERVE_MAX_BRANCH = String(Number(rowLimit));
    log(`[kev] row limit raised to ${rowLimit} for this run (optional local patch; published default is 8192)`);
  }
  const args = ["-m", "kev.serve", "--run", run, "--port", String(port)];
  log(`[kev] starting ${python} ${args.join(" ")}`);
  spawned = spawn(python, args, { cwd: clone, env, stdio: ["ignore", "inherit", "inherit"] });

  let spawnError = null;
  spawned.once("error", (error) => {
    spawnError = error;
  });
  const deadline = Date.now() + timeoutMs;
  let ready = null;
  while (Date.now() < deadline) {
    if (spawned.exitCode !== null || spawned.signalCode !== null) break;
    ready = await getJson(`${serviceUrl}/v1/models`, 1500);
    if (ready?.models?.length) break;
    ready = null;
    await sleep(500);
  }
  if (!ready) {
    try {
      spawned.kill("SIGTERM");
    } catch {
      // already gone
    }
    if (spawnError) throw new Error(`Kev server failed to start: ${spawnError.message}`);
    if (spawned.exitCode !== null) throw configError(`Kev server exited with code ${spawned.exitCode} before becoming ready (see its output above)`);
    throw new Error(`Kev server did not become ready on ${serviceUrl} within ${timeoutMs / 1000}s`);
  }

  const card = ready.models.find((model) => model.name === "kev-latest");
  if (card.run !== run) {
    spawned.kill("SIGTERM");
    throw new Error(`the server came up serving "${card.run}", not "${run}" — refusing to hand out a URL for it`);
  }
  const shutdown = (signal) => {
    log(`[kev] ${signal} — stopping the Kev server${spawned ? ` (pid ${spawned.pid})` : ""}`);
    try {
      spawned?.kill("SIGTERM");
    } catch {
      // already gone
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  spawned.on("exit", (code) => {
    log(`[kev] server exited (code ${code})`);
  });

  log(`[kev] serving /v1/systemone on ${serviceUrl} (${card.run} · ${card.base} · ${card.device}/${card.backend} · ${card.dtype} · T=${Number(card.temperature).toFixed(4)})`);
  log(`[kev] limits: needs a Python venv + MLX, ~18 GB idle and 36 GB GPU footprint under load at the raised limit;`);
  log(`[kev] the released cap is 8192 tokens (state + one branch) — see experiments/kev-4b/README.md`);
  process.stdout.write(`${envLine}\n`);
  return null; // keep running
}

main()
  .then((code) => {
    if (code !== null) process.exit(code);
  })
  .catch((error) => {
    log(`[kev] ${error.message}`);
    process.exit(error.config ? 2 : error.verify ? 3 : 1);
  });
