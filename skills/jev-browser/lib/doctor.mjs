// Environment diagnostics: what works, what is missing, and how to fix it.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { findChromeExecutable } from "./backends/chrome.mjs";
import { SAFARI_ENABLE_HINT } from "./backends/safari.mjs";
import { describeConfig, userConfigPath } from "./config.mjs";
import { TypeSafeClient } from "./typesafe.mjs";
import { installTargets } from "./install.mjs";

const run = promisify(execFile);

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function version(cmd, args = ["--version"]) {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 8000 });
    return (stdout || stderr).trim().split("\n")[0];
  } catch (error) {
    return null;
  }
}

export async function doctor({ config, sources, home = os.homedir(), skillDir, live = true } = {}) {
  const checks = [];
  const add = (name, ok, detail, hint) => checks.push({ name, status: ok === null ? "warn" : ok ? "ok" : "fail", detail, ...(hint ? { hint } : {}) });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 22, `node ${process.version}`, major >= 22 ? undefined : "Node 22+ is required (global fetch + WebSocket)");

  add("api key", Boolean(config.apiKey), config.apiKey ? `present (${sources.some((s) => s.kind === "env" && s.keys.includes("apiKey")) ? "env TYPESAFE_API_KEY" : "config file"})` : "missing", config.apiKey ? undefined : "export TYPESAFE_API_KEY=... or run: jev-browser config set-key --from-env");
  if (config.apiKey && live) {
    try {
      const client = new TypeSafeClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, timeoutMs: 10_000, maxRetries: 0 });
      const models = await client.models();
      add("typesafe api", true, `${config.baseUrl} → models: ${(models.models ?? []).map((m) => m.name).join(", ")}; configured model: ${config.model}`);
    } catch (error) {
      add("typesafe api", false, error.message, "check the key, network, or baseUrl");
    }
  }

  const ego = await version("ego-browser");
  const egoApp = process.platform === "darwin" ? await exists("/Applications/ego lite.app") : null;
  add("ego-browser cli", Boolean(ego), ego ? `ego-browser ${ego}` : "not found on PATH", ego ? undefined : "install ego lite (https://ego.dev) and its ego-browser CLI, or use --backend chrome");
  if (process.platform === "darwin") add("ego lite app", egoApp, egoApp ? "/Applications/ego lite.app" : "not installed", egoApp ? undefined : "download ego lite; the ego backend needs it");

  const chrome = await findChromeExecutable(config.chrome?.executable);
  add("chrome", Boolean(chrome), chrome ?? "no Chrome/Chromium/Edge executable found", chrome ? undefined : "install Google Chrome or set chrome.executable");
  if (config.chrome?.cdpUrl) {
    try {
      const response = await fetch(`${config.chrome.cdpUrl.replace(/\/$/, "")}/json/version`, { signal: AbortSignal.timeout(2000) });
      const json = await response.json();
      add("chrome cdp", true, `${config.chrome.cdpUrl} → ${json.Browser}`);
    } catch (error) {
      add("chrome cdp", false, `${config.chrome.cdpUrl} unreachable (${error.message})`, "start Chrome with --remote-debugging-port=<port> --user-data-dir=<dir> or unset chrome.cdpUrl to auto-launch");
    }
  }

  if (process.platform === "darwin") {
    const safari = await version("safaridriver");
    add("safaridriver", Boolean(safari), safari ?? "not found", safari ? SAFARI_ENABLE_HINT : "Safari ships safaridriver; not found on this system");
  }

  const journalDir = config.journalDir;
  try {
    await fs.mkdir(journalDir, { recursive: true });
    add("journal dir", true, journalDir);
  } catch (error) {
    add("journal dir", false, `${journalDir}: ${error.message}`);
  }

  const installed = await installTargets({ home, skillDir, probe: true });
  for (const target of installed) add(`install:${target.id}`, target.installed ? true : null, target.detail, target.installed ? undefined : `jev-browser install --targets ${target.id}`);

  return {
    ok: checks.every((c) => c.status !== "fail"),
    platform: `${process.platform} ${os.release()}`,
    configFile: userConfigPath(home),
    configSources: sources,
    config: describeConfig(config),
    checks,
  };
}

export function formatDoctor(report) {
  const lines = [`jev-browser doctor (${report.platform})`, ""];
  for (const c of report.checks) {
    const icon = c.status === "ok" ? "✔" : c.status === "warn" ? "•" : "✘";
    lines.push(`${icon} ${c.name.padEnd(18)} ${c.detail}`);
    if (c.hint) lines.push(`    ↳ ${c.hint}`);
  }
  lines.push("", `config: ${report.configFile}`, `sources: ${report.configSources.map((s) => s.kind).join(" < ") || "defaults"}`);
  return lines.join("\n");
}
