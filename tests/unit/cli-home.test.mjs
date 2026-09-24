// `--home` means the same thing to every command: the user config (and everything derived from it)
// comes from that directory. doctor/config/tier/install always honoured it; run/observe/judge/pick
// did not, so a scratch-home probe silently read the real user config instead.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BIN } from "../helpers/env.mjs";

const run = promisify(execFile);

async function cli(args, { env = {}, home }) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, HOME: home, ...env }, cwd: home });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

// Each command's own required-flag error: proof it got past config loading without reading any
// other config. The broken `backend` in the other home only loadConfig can produce.
const CASES = [
  { name: "run", args: ["run", "--goal", "open the page"], clean: /--url is required/ },
  { name: "observe", args: ["observe"], clean: /--url is required/ },
  { name: "judge", args: ["judge"], clean: /--state\/--state-file and --questions\/--questions-file are required/ },
  { name: "pick", args: ["pick"], clean: /--question and at least two --candidate id=description are required/ },
];

test("run/observe/judge/pick read --home the way doctor/config/tier/install do", async (t) => {
  const clean = await fs.mkdtemp(path.join(os.tmpdir(), "jev-home-clean-"));
  const bad = await fs.mkdtemp(path.join(os.tmpdir(), "jev-home-bad-"));
  t.after(async () => {
    await fs.rm(clean, { recursive: true, force: true });
    await fs.rm(bad, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(bad, ".config", "jev-browser"), { recursive: true });
  await fs.writeFile(path.join(bad, ".config", "jev-browser", "config.json"), JSON.stringify({ backend: "nope" }));

  for (const scenario of CASES) {
    const fromBad = await cli([...scenario.args, "--home", bad], { home: clean });
    assert.match(fromBad.stderr, /Unknown backend "nope"/, `${scenario.name} must read the config --home names`);
    assert.notEqual(fromBad.code, 0, `${scenario.name} fails on a config it cannot load`);

    const fromClean = await cli([...scenario.args, "--home", clean], { home: clean });
    assert.match(fromClean.stderr, scenario.clean, `${scenario.name} must not read any other config`);
  }
});
