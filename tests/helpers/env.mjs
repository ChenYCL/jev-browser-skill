// Shared test setup: decides live vs mock TypeSafe, finds browsers, isolates config.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createMockTypeSafe } from "./mock-typesafe.mjs";
import { createSite } from "../fixtures/server.mjs";
import { loadConfig } from "../../skills/jev-browser/lib/config.mjs";
import { findChromeExecutable } from "../../skills/jev-browser/lib/backends/chrome.mjs";

const run = promisify(execFile);
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
export const BIN = path.join(ROOT, "skills", "jev-browser", "bin", "jev-browser.mjs");
export const ARTIFACTS = path.join(ROOT, "tests", ".artifacts");

export const TEST_MODE = process.env.JEV_BROWSER_TEST_MODE ?? (process.env.TYPESAFE_API_KEY ? "live" : "mock");
export const LIVE = TEST_MODE === "live";

export async function hasEgo() {
  if (process.env.JEV_BROWSER_TEST_SKIP_EGO) return false;
  try {
    await run("ego-browser", ["--version"], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

export async function hasChrome() {
  if (process.env.JEV_BROWSER_TEST_SKIP_CHROME) return false;
  return Boolean(await findChromeExecutable());
}

export async function hasSafariAutomation() {
  if (process.platform !== "darwin" || process.env.JEV_BROWSER_TEST_SKIP_SAFARI) return false;
  if (!process.env.JEV_BROWSER_TEST_SAFARI) return false; // opt-in: opens Safari windows
  try {
    await run("safaridriver", ["--version"], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build an isolated test context: fixture site, mock TypeSafe (unless live),
 * temp HOME-like config dir, journal dir under tests/.artifacts.
 */
export async function createContext({ backend, headless = true } = {}) {
  const site = createSite();
  await site.listen();
  const mock = LIVE ? null : createMockTypeSafe();
  if (mock) await mock.listen();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jev-browser-test-home-"));
  const journalDir = path.join(ARTIFACTS, "journal");
  await fs.mkdir(journalDir, { recursive: true });
  const env = {
    ...process.env,
    TYPESAFE_API_KEY: LIVE ? process.env.TYPESAFE_API_KEY : "mock-key",
    ...(mock ? { TYPESAFE_BASE_URL: mock.baseUrl } : {}),
    JEV_BROWSER_JOURNAL_DIR: journalDir,
    JEV_BROWSER_BACKEND: backend,
    JEV_BROWSER_HEADLESS: headless ? "1" : "0",
  };
  const { config } = await loadConfig({ env, home, cwd: home });
  config.chrome.userDataDir = path.join(home, "chrome-profile");
  config.chrome.keepOnSuccess = false;
  config.ego.keepOnSuccess = false;
  config.ego.spaceName = "jev-browser e2e test";
  config.safari.keepOnSuccess = false;
  config.settleMs = 250;
  return {
    site,
    mock,
    home,
    env,
    config,
    url: (p) => `${site.baseUrl}${p}`,
    async close() {
      await site.close();
      await mock?.close();
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    },
  };
}
