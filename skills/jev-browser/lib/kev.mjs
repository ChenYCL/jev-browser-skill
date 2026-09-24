// The Kev accuracy tier's runtime location and readiness probe, shared by its launcher
// (bin/jev-kev.mjs, which owns the fetch/verify/serve flow) and by `doctor` / `jev-browser setup`,
// so the "checkout + venv + torch/mlx" rules exist once. The checkout is a third-party clone the
// user makes — it lives outside this repo on purpose.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where jev-kev keeps the Kev checkout it serves from (default; its --clone flag overrides it). */
export const KEV_DEFAULT_CLONE = path.join(os.homedir(), ".local", "share", "jev-browser", "kev");

/** The import that says the MLX serving extras are really installed in the venv. */
export const KEV_IMPORT_PROBE = ["-c", "import torch, mlx_lm; print('ok')"];

/** The two commands that create the checkout and its venv — printed by the launcher and by doctor. */
export const kevSetupCommands = (clone) => [
  `git clone --depth 1 https://github.com/jaredpalmer/kev.git ${clone}`,
  `uv sync --extra serve --project ${clone}`,
];

/** uv is what builds the venv; it is not a Node dependency, so nothing else can install it. */
export const KEV_UV_HINT = "install it first: brew install uv";

/**
 * What Kev needs from this machine, without downloading or starting anything: the checkout, its
 * venv, and a venv that can import torch + mlx_lm.
 *
 * Never throws — a probe that could not run is a state the callers report, not an exception.
 * @returns {Promise<{ok: boolean, clone: string, python: string|null, kind: "ok"|"missing-clone"|"missing-venv"|"no-import", detail: string}>}
 */
export async function probeKevRuntime({ clone = KEV_DEFAULT_CLONE, timeoutMs = 60_000 } = {}) {
  const python = path.join(clone, ".venv", "bin", "python");
  if (!fs.existsSync(clone)) return { ok: false, clone, python: null, kind: "missing-clone", detail: `no Kev checkout at ${clone}` };
  if (!fs.existsSync(python)) return { ok: false, clone, python, kind: "missing-venv", detail: `no Python venv at ${path.join(clone, ".venv")}` };
  const probe = await run(python, KEV_IMPORT_PROBE, { cwd: clone, timeout: timeoutMs }).catch((error) => error);
  if (probe instanceof Error || probe.code !== 0) {
    const detail = (probe instanceof Error ? probe.message : `${probe.stdout}${probe.stderr}`).trim().split("\n").slice(-3).join("\n");
    return { ok: false, clone, python, kind: "no-import", detail: `the venv at ${python} cannot import torch and mlx_lm\n  ${detail}` };
  }
  return { ok: true, clone, python, kind: "ok", detail: `${python} imports torch and mlx_lm` };
}
