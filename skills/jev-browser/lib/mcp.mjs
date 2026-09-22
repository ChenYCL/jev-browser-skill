// Minimal MCP server over stdio (JSON-RPC 2.0, newline-delimited) with no dependencies.
// Exposes the browser agent and raw Jev judgments to hosts such as Claude Desktop,
// Cursor and Codex. Only protocol messages go to stdout; logs go to stderr.
import readline from "node:readline";
import { loadConfig, describeConfig } from "./config.mjs";
import { executeJob } from "./runner.mjs";
import { TypeSafeClient } from "./typesafe.mjs";
import { doctor } from "./doctor.mjs";
import { rankProbabilities } from "./util.mjs";

export const MCP_VERSION = "0.1.2";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const TOOLS = [
  {
    name: "jev_browse",
    description:
      "Drive a real browser (ego lite by default, or Chrome/Safari) toward a natural-language goal. Jev (TypeSafe System One) judges each page; code executes clicks, typing, scrolling and navigation with budgets and loop detection. Returns a status (success | needs_user | stuck | max_steps | budget_exhausted | timeout | error), the final URL/title/text excerpt, cost and a journal path. Provide any values that must be typed via `inputs` (Jev selects values, it never invents text); put passwords in `secrets` so they are typed but never sent to the model.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the browser should accomplish, in English for best accuracy, e.g. 'Open the pricing page and start a free trial of the Team plan'." },
        url: { type: "string", description: "Start URL. Required unless space_id resumes an ego task space." },
        inputs: { type: "object", additionalProperties: { type: "string" }, description: "Named values available for typing, e.g. {\"query\": \"blue widget\", \"email\": \"a@b.c\"}." },
        secrets: { type: "object", additionalProperties: { type: "string" }, description: "Like inputs, but hidden from the model (passwords, tokens)." },
        backend: { type: "string", enum: ["ego", "chrome", "safari"] },
        max_steps: { type: "integer", minimum: 1, maximum: 200 },
        budget_usd: { type: "number", minimum: 0.001 },
        space_id: { type: "integer", description: "ego: resume an existing task space (after a needs_user hand-off)." },
        keep: { type: "boolean", description: "Keep the final page open for the user (default: true on success)." },
        headless: { type: "boolean", description: "chrome only: run without a window." },
        screenshot_path: { type: "string", description: "Absolute path for a final PNG screenshot." },
        step_screenshots_dir: { type: "string", description: "Directory for one PNG per step (the page as Jev saw it) plus final.png." },
      },
      required: ["goal"],
    },
  },
  {
    name: "jev_observe",
    description: "Open a URL and return the page as the agent perceives it (url, title, headings, visible text, interactive elements). No Jev call, no actions.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, backend: { type: "string", enum: ["ego", "chrome", "safari"] }, headless: { type: "boolean" }, screenshot_path: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "jev_judge",
    description: "Raw TypeSafe System One call: evaluate typed questions (noul | choice | score) against a state and get calibrated probabilities. Use for any structured judgment, not only browsing.",
    inputSchema: {
      type: "object",
      properties: {
        state: { description: "String, object or array the questions refer to." },
        questions: { type: "object", description: "Map of question id → {type, instructions, criteria}. See https://docs.typesafe.ai/api" },
        model: { type: "string" },
      },
      required: ["state", "questions"],
    },
  },
  {
    name: "jev_pick",
    description: "Convenience Choice: given a question and named candidates, return the best candidate with the full probability distribution and confidence.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        candidates: { type: "object", additionalProperties: { type: "string" }, description: "id → description" },
        context: { description: "Optional state the question refers to." },
        allow_none: { type: "boolean", description: "Add a 'none' option meaning no candidate fits (default true)." },
        model: { type: "string" },
      },
      required: ["question", "candidates"],
    },
  },
  { name: "jev_doctor", description: "Check the environment: API key, TypeSafe reachability, ego lite, Chrome, Safari, install status.", inputSchema: { type: "object", properties: {} } },
  { name: "jev_config", description: "Show the effective configuration (secrets masked) and where it came from.", inputSchema: { type: "object", properties: {} } },
];

async function configFor(args = {}) {
  const flags = {};
  if (args.backend) flags.backend = args.backend;
  if (args.max_steps) flags.maxSteps = Number(args.max_steps);
  if (args.budget_usd) flags.budgetUsd = Number(args.budget_usd);
  if (args.model) flags.model = args.model;
  return loadConfig({ flags });
}

function clientFor(config) {
  return new TypeSafeClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries, pricePerMtok: config.pricePerMtok });
}

export async function callTool(name, args = {}, { log = () => {} } = {}) {
  switch (name) {
    case "jev_browse": {
      const { config } = await configFor(args);
      const job = {
        mode: "run",
        goal: args.goal,
        startUrl: args.url,
        inputs: args.inputs ?? {},
        secrets: args.secrets ?? {},
        spaceId: args.space_id,
        keep: args.keep,
        headless: args.headless,
        screenshotPath: args.screenshot_path,
        stepScreenshotsDir: args.step_screenshots_dir,
      };
      return executeJob({ config, job, log });
    }
    case "jev_observe": {
      const { config } = await configFor(args);
      const out = await executeJob({ config, job: { mode: "observe", startUrl: args.url, headless: args.headless, screenshotPath: args.screenshot_path, keep: false }, log });
      return { backend: out.backend, page: out.page };
    }
    case "jev_judge": {
      const { config } = await configFor(args);
      const res = await clientFor(config).systemOne({ state: args.state, questions: args.questions, model: args.model });
      return { model: res.model, answers: res.raw, usage: res.usage, costUsd: res.costUsd, ms: res.ms };
    }
    case "jev_pick": {
      const { config } = await configFor(args);
      const criteria = { ...args.candidates };
      if (args.allow_none !== false && !("none" in criteria)) criteria.none = "No candidate fits.";
      const res = await clientFor(config).systemOne({ state: args.context ?? "No additional context.", questions: { pick: { type: "choice", instructions: args.question, criteria } }, model: args.model });
      const a = res.answers.pick;
      return { choice: a.choice, confidence: a.confidence, ranked: rankProbabilities(a.probabilities), usage: res.usage, costUsd: res.costUsd };
    }
    case "jev_doctor": {
      const { config, sources } = await loadConfig();
      return doctor({ config, sources });
    }
    case "jev_config": {
      const { config, sources, paths } = await loadConfig();
      return { config: describeConfig(config), sources, paths };
    }
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { rpcCode: -32602 });
  }
}

/** Handle one JSON-RPC request; returns a response object or null for notifications. */
export async function handleMessage(message, ctx = {}) {
  const { id, method, params } = message;
  const reply = (result) => (id === undefined ? null : { jsonrpc: "2.0", id, result });
  const fail = (code, msg, data) => (id === undefined ? null : { jsonrpc: "2.0", id, error: { code, message: msg, ...(data ? { data } : {}) } });
  try {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "jev-browser", version: MCP_VERSION },
          instructions: "Use jev_browse to accomplish browser goals (provide typed values via inputs/secrets). Use jev_observe to look at a page first. jev_judge / jev_pick expose raw Jev judgments.",
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "resources/list":
        return reply({ resources: [] });
      case "prompts/list":
        return reply({ prompts: [] });
      case "tools/call": {
        const name = params?.name;
        if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool ${name}`);
        try {
          const result = await callTool(name, params?.arguments ?? {}, ctx);
          return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
        } catch (error) {
          return reply({ content: [{ type: "text", text: `${error.name ?? "Error"}: ${error.message}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  } catch (error) {
    return fail(-32603, error.message);
  }
}

export async function serveStdio({ input = process.stdin, output = process.stdout, log = (m) => process.stderr.write(`[jev-browser mcp] ${m}\n`) } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (obj) => output.write(`${JSON.stringify(obj)}\n`);
  const running = new Set();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    const batch = Array.isArray(message) ? message : [message];
    for (const item of batch) {
      const task = handleMessage(item, { log })
        .then((response) => response && write(response))
        .catch((error) => log(`handler crashed: ${error.message}`))
        .finally(() => running.delete(task));
      running.add(task);
    }
  }
  await Promise.allSettled([...running]);
}
