// Environment diagnostics: what works, what is missing, and how to fix it.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { findChromeExecutable } from "./backends/chrome.mjs";
import { SAFARI_ENABLE_HINT } from "./backends/safari.mjs";
import { classifyModelsCard, describeConfig, thresholdProfile, userConfigPath } from "./config.mjs";
import { localStatus } from "./local.mjs";
import { TypeSafeClient, isLoopbackBaseUrl } from "./typesafe.mjs";
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

/** The port a loopback baseUrl points at, or null. */
function loopbackPort(baseUrl) {
  if (!isLoopbackBaseUrl(baseUrl)) return null;
  try {
    const url = new URL(String(baseUrl));
    return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Which local backend answers on `config.baseUrl`. Reuses the models call doctor already made for
 * the `typesafe api` line; when there was none (no api key, or offline) and the endpoint is
 * loopback it asks /v1/models directly, because the `goal_done` bar depends on the answer.
 */
async function classifyEndpoint({ config, live, models }) {
  if (models) return classifyModelsCard(models);
  if (!live || config.thresholds.profile !== "auto" || !isLoopbackBaseUrl(config.baseUrl)) return null;
  const url = `${String(config.baseUrl).replace(/\/+$/, "")}/v1/models`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { profile: null, kind: "http-error", reason: `${url} answered HTTP ${response.status}`, names: [] };
    return classifyModelsCard(await response.json());
  } catch (error) {
    return { profile: null, kind: "unreachable", reason: `${url} unreachable (${error.message})`, names: [] };
  }
}

export async function doctor({ config, sources, home = os.homedir(), skillDir, live = true } = {}) {
  const checks = [];
  const add = (name, ok, detail, hint) => checks.push({ name, status: ok === null ? "warn" : ok ? "ok" : "fail", detail, ...(hint ? { hint } : {}) });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 22, `node ${process.version}`, major >= 22 ? undefined : "Node 22+ is required (global fetch + WebSocket)");

  add("api key", Boolean(config.apiKey), config.apiKey ? `present (${sources.some((s) => s.kind === "env" && s.keys.includes("apiKey")) ? "env TYPESAFE_API_KEY" : "config file"})` : "missing", config.apiKey ? undefined : "export TYPESAFE_API_KEY=... or run: jev-browser config set-key --from-env");
  let models = null;
  if (config.apiKey && live) {
    try {
      const client = new TypeSafeClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, timeoutMs: 10_000, maxRetries: 0 });
      models = await client.models();
      add("typesafe api", true, `${config.baseUrl} → models: ${(models.models ?? []).map((m) => m.name).join(", ")}; configured model: ${config.model}`);
    } catch (error) {
      add("typesafe api", false, error.message, "check the key, network, or baseUrl");
    }
  }

  // The fully local backend is optional: report it, never fail on it, never throw. The registry
  // is imported dynamically so a half-edited lib/local-models.json shows up as a line here
  // instead of breaking doctor.
  const endpoint = await classifyEndpoint({ config, live, models });
  try {
    const { localStatus } = await import("./local.mjs");
    // Probe the port the *run* uses, so a Kev endpoint on 8008 is reported rather than the GGUF
    // default of 8092 sitting idle beside it.
    const port = loopbackPort(config.baseUrl) ?? undefined;
    const local = await localStatus({ home, ...(port ? { port } : {}) });
    const ready = Boolean(local.llamaServer && local.bytes > 0);
    const size = local.bytes > 0 ? `${Math.round(local.bytes / 1024 / 1024)} MiB` : `not downloaded (${Math.round(local.expectedBytes / 1024 / 1024)} MiB expected)`;
    const livePort = local.serving
      ? `127.0.0.1:${local.port} up${local.servingModel ? ` (serving ${local.servingModel})` : ""}`
      : local.endpoint
        ? `127.0.0.1:${local.port} up (${local.endpoint.kind}${local.endpoint.run ? ` ${local.endpoint.run}` : ` "${local.endpoint.name}"`})`
        : `127.0.0.1:${local.port} not running`;
    const detail = [
      local.llamaServer ? `llama-server ${local.llamaServer}` : "llama-server not found",
      `${local.id}${local.label ? ` "${local.label}"` : ""} ${size}`,
      livePort,
    ].join(" · ");
    const hint = local.endpoint
      ? `the port your baseUrl uses is serving a ${local.endpoint.kind}, not this registry entry — see the goal_done bar line`
      : !local.llamaServer
        ? "brew install llama.cpp"
        : local.bytes === 0
          ? `download it: node <skill-dir>/bin/jev-local.mjs --download-only (registry: ${local.registry.path})`
          : local.serving
            ? undefined
            : "start it: node <skill-dir>/bin/jev-local.mjs (--list-models shows the registry)";
    add("local model", local.endpoint || ready ? true : null, detail, hint);
  } catch (error) {
    add("local model", null, `registry problem: ${error.message}`, "fix skills/jev-browser/lib/local-models.json, or run --list-models with a working file");
  }

  // The bar depends on which backend answers. Print the pair a RUN would use: a value some layer
  // configured, else the resolved profile's — and name which keys were pinned, so "differs from the
  // profile" is never confused with "you configured it".
  const bar = thresholdProfile(config, { classification: endpoint });
  const pinnedKeys = config.thresholds.configured ?? [];
  const effective = Object.fromEntries(
    ["goalDone", "goalDoneFinal"].map((key) => [key, pinnedKeys.includes(key) ? config.thresholds[key] : bar.defaults[key]]),
  );
  add(
    "goal_done bar",
    true,
    `${effective.goalDone} per step / ${effective.goalDoneFinal} final — ${bar.profile} profile for ${config.baseUrl}` +
      `${pinnedKeys.length ? ` (${pinnedKeys.map((key) => `thresholds.${key}`).join(", ")} pinned)` : ""}`,
    `${bar.reason} · bar measured in ${bar.measured}${bar.pinned !== "auto" ? `; unset the pin with: config unset thresholds.profile` : ""}`,
  );

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
