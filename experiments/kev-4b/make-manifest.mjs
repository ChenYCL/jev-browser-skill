#!/usr/bin/env node
// Regenerate the pinned asset manifest inside skills/jev-browser/bin/jev-kev.mjs.
//
// The manifest is the launcher's ground truth: for every file of the checkpoint and its base it
// records the size and either the sha256 (LFS blobs) or the git blob sha1 (small text files), plus
// the commit the file list came from. Every download is verified against it before it is allowed
// into the cache, so a mirror serving different bytes is caught instead of cached.
//
//   node experiments/kev-4b/make-manifest.mjs            # rewrite the launcher's manifest block
//   node experiments/kev-4b/make-manifest.mjs --print     # print it instead of writing it
//
// Provenance of the input: `trees/<commit>.json` in the HuggingFace cache for each repo, which is the
// Hub tree API metadata verbatim (name, size, blobId, lfs.oid) as written by
// experiments/kev-4b/fetch.py and re-verified in docs/local-kev-bringup.md §11.7. Nothing here talks
// to the network: re-pinning a new checkpoint means fetching it, then re-running this.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPOS = [
  { key: "run", repo: "jaredpalmer/kev-4b" },
  { key: "base", repo: "Qwen/Qwen3.5-4B-Base" },
];
const LAUNCHER = path.join(import.meta.dirname, "..", "..", "skills", "jev-browser", "bin", "jev-kev.mjs");
const MARKER = "/* __KEV_ASSETS__ */ null";

/** The Hub's cache layout names the repo directory after the repo id. */
const repoDir = (repo) => path.join(os.homedir(), ".cache", "huggingface", "hub", `models--${repo.replace("/", "--")}`);

function readRepo({ key, repo }) {
  const dir = repoDir(repo);
  const commit = fs.readFileSync(path.join(dir, "refs", "main"), "utf8").trim();
  const tree = JSON.parse(fs.readFileSync(path.join(dir, "trees", `${commit}.json`), "utf8"));
  const files = Object.entries(tree.files)
    .map(([name, rec]) => ({
      name,
      size: rec.size,
      // LFS blobs are named by sha256; small files by the git blob sha1. Same rule as the Hub.
      kind: rec.lfs_sha256 ? "sha256" : "git-sha1",
      hash: rec.lfs_sha256 || rec.blob_id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const file of files) {
    const blob = path.join(dir, "blobs", file.hash);
    if (!fs.existsSync(blob)) throw new Error(`${repo}: blob missing for ${file.name} — fetch it first (experiments/kev-4b/fetch.py)`);
    if (fs.statSync(blob).size !== file.size) throw new Error(`${repo}: ${file.name} is ${fs.statSync(blob).size} bytes, metadata says ${file.size}`);
  }
  return { key, repo, commit, files };
}

function literal(entries) {
  const lines = ["{"];
  for (const { key, repo, commit, files } of entries) {
    lines.push(`  ${key}: {`);
    lines.push(`    repo: ${JSON.stringify(repo)},`);
    lines.push(`    commit: ${JSON.stringify(commit)},`);
    lines.push(`    files: [`);
    for (const file of files) {
      lines.push(`      { name: ${JSON.stringify(file.name)}, size: ${file.size}, kind: ${JSON.stringify(file.kind)}, hash: ${JSON.stringify(file.hash)} },`);
    }
    lines.push(`    ],`);
    lines.push(`  },`);
  }
  lines.push("}");
  return lines.join("\n");
}

const entries = REPOS.map(readRepo);
const block = literal(entries);
const summary = entries
  .map(({ key, repo, commit, files }) => `  ${key.padEnd(4)} ${repo}@${commit.slice(0, 8)}  ${String(files.length).padStart(2)} files  ${files.reduce((sum, f) => sum + f.size, 0).toLocaleString()} bytes`)
  .join("\n");

if (process.argv.includes("--print")) {
  console.log(block);
  console.error(`\n${summary}`);
} else {
  const source = fs.readFileSync(LAUNCHER, "utf8");
  if (!source.includes(MARKER)) throw new Error(`${LAUNCHER} has no ${MARKER} marker to replace`);
  fs.writeFileSync(LAUNCHER, source.replace(MARKER, block));
  console.error(`wrote the pinned manifest into ${LAUNCHER}\n${summary}`);
}
