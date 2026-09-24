#!/usr/bin/env node
// jev-browser CLI: Jev-judged browser automation (ego lite / Chrome / Safari).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, describeConfig, saveUserConfig, unsetUserConfig, patchFromKeyPath, userConfigPath } from "../lib/config.mjs";
import { executeJob } from "../lib/runner.mjs";
import { TypeSafeClient } from "../lib/typesafe.mjs";
import { doctor, formatDoctor } from "../lib/doctor.mjs";
import { installTargets, formatInstall, DEFAULT_TARGETS, DEFAULT_SKILL_DIR } from "../lib/install.mjs";
import { parseKeyValue, rankProbabilities } from "../lib/util.mjs";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(await fs.readFile(path.join(SKILL_DIR, "package.json"), "utf8")).version;

const HELP = `jev-browser ${VERSION} — Jev-judged browser automation (ego lite / Chrome / Safari)

Usage:
  jev-browser run --goal "<goal>" [--url <start-url>] [--input k=v]... [--secret k=v]... [options]
  jev-browser observe --url <url> [--backend ego|chrome|safari] [--screenshot file.png] [--json]
  jev-browser judge --state <json|text> --questions <json>   (or --state-file / --questions-file)
  jev-browser pick --question "<q>" --candidate id=description... [--context <json|text>]
  jev-browser doctor [--json] [--offline]
  jev-browser config show | path | set <key.path> <value> | unset <key.path> | set-key [<key> | --from-env]
  jev-browser install [--targets a,b,c] [--dry-run] [--copy] [--uninstall]
  jev-browser mcp                     (MCP server over stdio, for Claude Desktop / Cursor / Codex)

run options:
  -g, --goal          natural-language goal (English gives the best accuracy)
  -u, --url           start URL (required unless --space-id resumes an ego task space)
  -i, --input k=v     value the agent may type (repeatable); quoted strings in the goal are added automatically
  -s, --secret k=v    like --input but hidden from the model (passwords)
  -b, --backend       ego (default) | chrome | safari
      --max-steps N   --budget-usd X   --max-ms N   --model jev-latest
      --space-id N    ego: resume an existing task space   --page-label p1
      --keep / --no-keep   keep the final page open (default: keep on success)
      --headless      chrome: no window        --cdp-url http://127.0.0.1:9222  chrome: attach
      --screenshot f  save a final PNG         --step-screenshots dir   save the page as Jev saw it before every step
      --dry-run       observe + print the first-step questions, no Jev call
      --json          print only the JSON result   -q, --quiet   no progress logs

Config precedence: defaults < ~/.config/jev-browser/config.json < ./jev-browser.config.json (or $JEV_BROWSER_CONFIG) < env < flags
Env: TYPESAFE_API_KEY TYPESAFE_BASE_URL TYPESAFE_DEFAULT_MODEL JEV_BROWSER_BACKEND JEV_BROWSER_MAX_STEPS JEV_BROWSER_BUDGET_USD JEV_BROWSER_JOURNAL_DIR JEV_BROWSER_CHROME_CDP_URL JEV_BROWSER_HEADLESS JEV_BROWSER_EGO_SERVER_NAME
`;

const OPTIONS = {
  goal: { type: "string", short: "g" },
  url: { type: "string", short: "u" },
  input: { type: "string", short: "i", multiple: true },
  secret: { type: "string", short: "s", multiple: true },
  backend: { type: "string", short: "b" },
  "max-steps": { type: "string" },
  "budget-usd": { type: "string" },
  "max-ms": { type: "string" },
  model: { type: "string" },
  "space-id": { type: "string" },
  "page-label": { type: "string" },
  keep: { type: "boolean" },
  "no-keep": { type: "boolean" },
  headless: { type: "boolean" },
  "cdp-url": { type: "string" },
  screenshot: { type: "string" },
  "step-screenshots": { type: "string" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  state: { type: "string" },
  "state-file": { type: "string" },
  questions: { type: "string" },
  "questions-file": { type: "string" },
  question: { type: "string" },
  candidate: { type: "string", multiple: true },
  context: { type: "string" },
  "no-none": { type: "boolean" },
  offline: { type: "boolean" },
  targets: { type: "string" },
  home: { type: "string" },
  copy: { type: "boolean" },
  uninstall: { type: "boolean" },
  "from-env": { type: "boolean" },
  "journal-dir": { type: "string" },
  "no-journal": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

function parseMaybeJson(text) {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toMap(list = []) {
  return Object.fromEntries(list.map(parseKeyValue));
}

function flagsFromValues(values) {
  const flags = {};
  if (values.backend) flags.backend = values.backend;
  if (values["max-steps"]) flags.maxSteps = Number(values["max-steps"]);
  if (values["budget-usd"]) flags.budgetUsd = Number(values["budget-usd"]);
  if (values["max-ms"]) flags.maxMs = Number(values["max-ms"]);
  if (values.model) flags.model = values.model;
  if (values["journal-dir"]) flags.journalDir = values["journal-dir"];
  if (values["no-journal"]) flags.keepJournal = false;
  if (values["cdp-url"]) flags.chrome = { cdpUrl: values["cdp-url"] };
  if (values.headless) flags.chrome = { ...(flags.chrome ?? {}), headless: true };
  return flags;
}

function makeLog(values) {
  return values.quiet ? () => {} : (message) => process.stderr.write(`${message}\n`);
}

function print(value, values, human) {
  if (values.json || !human) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${human}\n${JSON.stringify(value, null, 2)}\n`);
}

function summarize(result) {
  const cost = result.usage ? `$${result.usage.costUsd.toFixed(4)} (${result.usage.requests} requests, ${result.usage.inputTokens} tokens)` : "n/a";
  const lines = [`status: ${result.status}${result.reason ? ` — ${result.reason}` : ""}`, `steps: ${result.steps}   cost: ${cost}   elapsed: ${Math.round((result.elapsedMs ?? 0) / 1000)}s`];
  if (result.finalUrl) lines.push(`final: ${result.finalTitle ?? ""} <${result.finalUrl}>`);
  if (result.status === "needs_user") {
    const spaceId = result.resume?.spaceId;
    lines.push(
      spaceId
        ? `blocker: ${result.blocker} — the browser was handed to you; resume with --space-id ${spaceId} once done`
        : `blocker: ${result.blocker} — the browser was closed, not handed over; re-run when you can act in it (--keep leaves the page open)`,
    );
  }
  if (result.journalDir) lines.push(`journal: ${result.journalDir}`);
  if (result.screenshot) lines.push(`screenshot: ${result.screenshot}`);
  return lines.join("\n");
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const command = positionals[0] ?? (values.version ? "version" : "help");
  if (values.help || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const log = makeLog(values);

  switch (command) {
    case "run": {
      const { config } = await loadConfig({ flags: flagsFromValues(values) });
      if (!values.goal && !values["dry-run"]) throw new Error("--goal is required");
      if (!values.url && !values["space-id"]) throw new Error("--url is required (or --space-id to resume an ego task space)");
      if (!config.apiKey && !values["dry-run"]) throw new Error("no TypeSafe API key: export TYPESAFE_API_KEY or run `jev-browser config set-key --from-env`");
      const job = {
        mode: values["dry-run"] ? "dry-run" : "run",
        goal: values.goal ?? "(dry run)",
        startUrl: values.url,
        inputs: toMap(values.input),
        secrets: toMap(values.secret),
        spaceId: values["space-id"] ? Number(values["space-id"]) : undefined,
        pageLabel: values["page-label"],
        keep: values["no-keep"] ? false : values.keep ? true : undefined,
        headless: values.headless || undefined,
        cdpUrl: values["cdp-url"],
        screenshotPath: values.screenshot ? path.resolve(values.screenshot) : undefined,
        stepScreenshotsDir: values["step-screenshots"] ? path.resolve(values["step-screenshots"]) : undefined,
      };
      log(`backend=${config.backend} model=${config.model} maxSteps=${config.maxSteps} budget=$${config.budgetUsd}`);
      const result = await executeJob({ config, job, log });
      if (job.mode === "dry-run") {
        print(result, values, `dry run: ${result.meta.questionCount} questions, ${result.meta.candidateCount} candidates, ≈${result.estimatedInputTokens} input tokens (≈$${result.estimatedCostUsd.toFixed(5)})`);
        return 0;
      }
      print(result, values, summarize(result));
      return result.status === "success" ? 0 : result.status === "needs_user" ? 3 : 2;
    }
    case "observe": {
      const { config } = await loadConfig({ flags: flagsFromValues(values) });
      if (!values.url) throw new Error("--url is required");
      const out = await executeJob({ config, job: { mode: "observe", startUrl: values.url, headless: values.headless || undefined, cdpUrl: values["cdp-url"], screenshotPath: values.screenshot ? path.resolve(values.screenshot) : undefined, keep: values.keep ?? false }, log });
      print(values.json ? out.page : { backend: out.backend, page: out.page }, values, `${out.page.title} <${out.page.url}> — ${out.page.elements.length} interactive elements`);
      return 0;
    }
    case "judge": {
      const { config } = await loadConfig({ flags: flagsFromValues(values) });
      const state = values["state-file"] ? parseMaybeJson(await fs.readFile(values["state-file"], "utf8")) : parseMaybeJson(values.state);
      const questions = values["questions-file"] ? JSON.parse(await fs.readFile(values["questions-file"], "utf8")) : values.questions ? JSON.parse(values.questions) : undefined;
      if (state === undefined || !questions) throw new Error("--state/--state-file and --questions/--questions-file are required");
      const client = new TypeSafeClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries, pricePerMtok: config.pricePerMtok });
      const res = await client.systemOne({ state, questions });
      print({ model: res.model, answers: res.raw, usage: res.usage, costUsd: res.costUsd, ms: res.ms }, { json: true });
      return 0;
    }
    case "pick": {
      const { config } = await loadConfig({ flags: flagsFromValues(values) });
      if (!values.question || !values.candidate?.length) throw new Error("--question and at least two --candidate id=description are required");
      const criteria = toMap(values.candidate);
      if (!values["no-none"] && !("none" in criteria)) criteria.none = "No candidate fits.";
      const client = new TypeSafeClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries, pricePerMtok: config.pricePerMtok });
      const res = await client.systemOne({ state: parseMaybeJson(values.context) ?? "No additional context.", questions: { pick: { type: "choice", instructions: values.question, criteria } } });
      const a = res.answers.pick;
      print({ choice: a.choice, confidence: a.confidence, ranked: rankProbabilities(a.probabilities), usage: res.usage, costUsd: res.costUsd }, { json: true });
      return 0;
    }
    case "doctor": {
      // `doctor --home <dir>` has to load that home's config, the same way config show/set do:
      // the whole point of the flag is to diagnose a config file that is not the default one.
      const { config, sources } = await loadConfig({ flags: flagsFromValues(values), ...(values.home ? { home: values.home } : {}) });
      const report = await doctor({ config, sources, skillDir: SKILL_DIR, home: values.home, live: !values.offline });
      if (values.json) print(report, { json: true });
      else process.stdout.write(`${formatDoctor(report)}\n`);
      return report.ok ? 0 : 1;
    }
    case "config": {
      const sub = positionals[1] ?? "show";
      const home = values.home;
      if (sub === "show") {
        const { config, sources, paths } = await loadConfig({ home });
        print({ config: describeConfig(config), sources, paths }, { json: true });
        return 0;
      }
      if (sub === "path") {
        process.stdout.write(`${userConfigPath(home)}\n`);
        return 0;
      }
      if (sub === "set") {
        const [, , key, value] = positionals;
        if (!key || value === undefined) throw new Error("usage: config set <key.path> <value>");
        const file = await saveUserConfig(patchFromKeyPath(key, value), { home });
        process.stdout.write(`saved ${key} to ${file}\n`);
        return 0;
      }
      if (sub === "unset") {
        const key = positionals[2];
        if (!key) throw new Error("usage: config unset <key.path>");
        const file = await unsetUserConfig(key, { home });
        process.stdout.write(`removed ${key} from ${file}\n`);
        return 0;
      }
      if (sub === "set-key") {
        const key = values["from-env"] ? process.env.TYPESAFE_API_KEY : positionals[2];
        if (!key) throw new Error("usage: config set-key <key>   or   config set-key --from-env (with TYPESAFE_API_KEY exported)");
        const file = await saveUserConfig({ apiKey: key }, { home });
        process.stdout.write(`stored the API key in ${file} (mode 0600)\n`);
        return 0;
      }
      throw new Error(`unknown config subcommand ${sub}`);
    }
    case "install": {
      const targets = values.targets ? values.targets.split(",").map((t) => t.trim()).filter(Boolean) : DEFAULT_TARGETS;
      const out = await installTargets({ targets, home: values.home, skillDir: SKILL_DIR, dryRun: values["dry-run"], copy: values.copy, uninstall: values.uninstall });
      if (values.json) print(out, { json: true });
      else process.stdout.write(`${formatInstall(out)}\n`);
      return out.results.some((r) => r.action === "error") ? 1 : 0;
    }
    case "mcp": {
      const { serveStdio } = await import("../lib/mcp.mjs");
      await serveStdio();
      return 0;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${HELP}`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
