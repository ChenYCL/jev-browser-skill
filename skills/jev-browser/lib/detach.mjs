// Backgrounding for the two local launchers. `--detach` runs the same script again with the same
// arguments minus the flag, sends its output to a log file under ~/.jev-browser/run, and returns
// once the endpoint answers. Opt-in only: the foreground launcher is unchanged, and only a process
// whose pid file this launcher wrote is ever stopped.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/** The run directory, pid file and log file one launcher owns (both launchers use these names). */
export function runPaths(home = os.homedir(), name, port) {
  const run = path.join(home, ".jev-browser", "run");
  return { run, pidFile: path.join(run, `${name}-${port}.pid`), logFile: path.join(run, `${name}-${port}.log`) };
}

/**
 * Run `script` (this launcher) again in the background with `args`, output into `logFile`.
 * A new process group, so it survives the caller's exit and its terminal's Ctrl-C.
 */
export function spawnSelfDetached({ script, args, logFile, cwd = process.cwd(), env = process.env }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    return child;
  } finally {
    fs.closeSync(fd);
  }
}

/** Poll `ready` until it returns true or the deadline passes. Never throws. */
export async function waitUntilReady(ready, { timeoutMs, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = Boolean(await ready());
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
