// Fully local (experimental) model backend: the TypeSafe `/v1/systemone` contract served
// by a local llama.cpp server — no API key, no Python, no npm packages, no outbound network.
//
// The answer to a question is read straight out of the model's first generated token: the
// question is rendered with labelled options, exactly ONE token is generated, and the
// probability mass on each option label at that position IS the answer. No training, no
// text generation, no output parsing (mirrors ekzhang/openjev-sglang).
//
// The readout algorithm is a copy of experiments/gguf-provider (lib/readout.mjs,
// lib/render.mjs, lib/labels.mjs, lib/provider.mjs); experiments/gguf-provider/RESULTS.md
// holds the measured numbers and the limits. Keep this file and the experiment in sync.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateQuestions } from "./typesafe.mjs";

export const SERVICE = "jev-local";

// Which GGUF to serve is data, not code: lib/local-models.json is the registry, addressed
// relative to this module so the launcher and doctor work from any cwd. Swapping models is a
// JSON edit (point "default" at another id) or --model-name <id> for a single run.
export const REGISTRY_FILE = fileURLToPath(new URL("./local-models.json", import.meta.url));

export class LocalModelRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalModelRegistryError";
  }
}

/**
 * Read and validate the model registry (`lib/local-models.json`).
 *
 * Throws LocalModelRegistryError naming the offending path and field when the file is
 * missing or malformed — a broken registry never falls back to a hard-coded model.
 * @returns {{path: string, default: string, models: Record<string, {file: string, url: string, bytes: number, label: string}>}}
 */
export function loadLocalModels({ file = REGISTRY_FILE } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new LocalModelRegistryError(`local model registry not readable: ${file} (${error.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LocalModelRegistryError(`local model registry is not valid JSON: ${file} (${error.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalModelRegistryError(`local model registry must be a JSON object: ${file}`);
  }
  const models = parsed.models;
  if (!models || typeof models !== "object" || Array.isArray(models) || Object.keys(models).length === 0) {
    throw new LocalModelRegistryError(`local model registry needs a non-empty "models" object: ${file}`);
  }
  for (const [id, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new LocalModelRegistryError(`local model registry: model "${id}" must be an object: ${file}`);
    for (const key of ["file", "url", "label"]) {
      if (typeof entry[key] !== "string" || !entry[key].trim()) throw new LocalModelRegistryError(`local model registry: model "${id}" needs a non-empty "${key}" string: ${file}`);
    }
    if (path.basename(entry.file) !== entry.file) throw new LocalModelRegistryError(`local model registry: model "${id}" file must be a bare filename (no directories): ${file}`);
    if (!/^https?:\/\//.test(entry.url)) throw new LocalModelRegistryError(`local model registry: model "${id}" url must start with http(s): ${file}`);
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) throw new LocalModelRegistryError(`local model registry: model "${id}" needs a positive integer "bytes": ${file}`);
  }
  if (typeof parsed.default !== "string" || !models[parsed.default]) {
    throw new LocalModelRegistryError(`local model registry: "default" is ${JSON.stringify(parsed.default)}, not one of ${Object.keys(models).join(", ")}: ${file}`);
  }
  return { path: file, default: parsed.default, models };
}

function entryOf(registry, id) {
  const entry = registry.models[id];
  if (!entry) throw new LocalModelRegistryError(`unknown local model "${id}"; available: ${Object.keys(registry.models).join(", ")}`);
  return { id, ...entry };
}

/** One registry entry by id (with its `id`), or a clear error listing what exists. */
export function localModel(id, { file = REGISTRY_FILE } = {}) {
  return entryOf(loadLocalModels({ file }), id);
}

/** The registry's default entry. */
export function defaultLocalModel({ file = REGISTRY_FILE } = {}) {
  const registry = loadLocalModels({ file });
  return entryOf(registry, registry.default);
}

// Resolved once at import. LOCAL_MODEL_FILE / LOCAL_MODEL_URL keep working for older callers,
// derived from the registry default; a malformed registry throws here rather than degrading.
export const LOCAL_MODELS = loadLocalModels();
export const LOCAL_MODEL_ID = LOCAL_MODELS.default;
export const LOCAL_MODEL_FILE = LOCAL_MODELS.models[LOCAL_MODEL_ID].file;
export const LOCAL_MODEL_URL = LOCAL_MODELS.models[LOCAL_MODEL_ID].url;
export const LOCAL_MODEL_BYTES = LOCAL_MODELS.models[LOCAL_MODEL_ID].bytes;
export const LOCAL_MODEL_LABEL = LOCAL_MODELS.models[LOCAL_MODEL_ID].label;

export const LOCAL_DEFAULTS = Object.freeze({
  port: 8092,
  llamaPort: 8090,
  // 16384 tokens: a 100-candidate step renders to ~11.7k prompt tokens, so the old 8192 default
  // could not serve a real browser step (see experiments/gguf-provider/RESULTS.md).
  ctx: 16384,
  model: LOCAL_MODEL_ID,
  llamaUrl: "http://127.0.0.1:8090",
  nProbs: 512,
});

/** Below this share of the option-label mass the answer is treated as "not read out" (HTTP 422). */
export const MIN_LABEL_MASS = 0.5;

/** Files the one-command launcher uses (~/.jev-browser/{models,run}) for one registry entry. */
export function localPaths(home = os.homedir(), model = { id: LOCAL_MODEL_ID, file: LOCAL_MODEL_FILE }) {
  const root = path.join(home, ".jev-browser");
  const models = path.join(root, "models");
  return { root, models, run: path.join(root, "run"), id: model.id, file: model.file, modelFile: path.join(models, model.file) };
}

/** `llama-server` on PATH, then the Homebrew prefix (macOS default). Never throws. */
export function findLlamaServer({ env = process.env, extra = ["/opt/homebrew/bin"] } = {}) {
  const dirs = [...new Set([...(env.PATH ?? "").split(path.delimiter).filter(Boolean), ...extra])];
  for (const dir of dirs) {
    const candidate = path.join(dir, "llama-server");
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // not here — keep looking
    }
  }
  return null;
}

/** GET JSON with a short timeout; null on any failure (unreachable, non-JSON, timeout). */
export async function getJson(url, timeoutMs = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The GGUF path a llama.cpp server says it is serving — `/props.model_path`, falling back to the
 * name llama.cpp puts in `/v1/models`. null when the server does not tell us, so callers can warn
 * instead of guessing.
 */
export async function llamaServedModel(url, timeoutMs = 2000) {
  const base = url.replace(/\/$/, "");
  const props = await getJson(`${base}/props`, timeoutMs);
  if (typeof props?.model_path === "string" && props.model_path) return props.model_path;
  const models = await getJson(`${base}/v1/models`, timeoutMs);
  const name = models?.models?.[0]?.name ?? models?.data?.[0]?.id;
  return typeof name === "string" && name ? name : null;
}

/**
 * What `doctor` reports for the local backend: the binary, which registry entry is active and
 * how much of its file is on disk, and whether either server is up (and which model it serves).
 */
export async function localStatus({ home = os.homedir(), port = LOCAL_DEFAULTS.port, llamaPort = LOCAL_DEFAULTS.llamaPort, model = LOCAL_MODEL_ID } = {}) {
  const entry = LOCAL_MODELS.models[model] ? { id: model, ...LOCAL_MODELS.models[model] } : null;
  const paths = localPaths(home, entry ?? { id: model, file: LOCAL_MODEL_FILE });
  const status = {
    ...paths,
    port,
    llamaPort,
    registry: { path: LOCAL_MODELS.path, default: LOCAL_MODELS.default, ids: Object.keys(LOCAL_MODELS.models) },
    id: entry?.id ?? model,
    label: entry?.label ?? null,
    expectedBytes: entry?.bytes ?? 0,
    llamaServer: null,
    bytes: 0,
    llama: false,
    serving: false,
    servingModel: null,
    endpoint: null, // what answers on `port` when it is not this launcher's wrapper
  };
  try {
    status.llamaServer = findLlamaServer();
  } catch {
    status.llamaServer = null;
  }
  try {
    status.bytes = (await fsp.stat(paths.modelFile)).size;
  } catch {
    status.bytes = 0;
  }
  status.llama = ((await getJson(`http://127.0.0.1:${llamaPort}/health`, 1000)) ?? {}).status === "ok";
  const live = await getJson(`http://127.0.0.1:${port}/health`, 1000);
  status.serving = live?.service === SERVICE;
  status.servingModel = status.serving ? live.model ?? null : null;
  // This port may be serving something that is not this launcher: a Kev checkpoint, say, when
  // TYPESAFE_BASE_URL points at 8008 and the GGUF wrapper is not running. `port` is the port the
  // caller cares about, so report whatever answers there instead of implying the port is dead.
  status.endpoint = null;
  if (!status.serving) {
    const cards = await getJson(`http://127.0.0.1:${port}/v1/models`, 1000);
    const card = cards?.models?.[0] ?? cards?.data?.[0];
    if (card) {
      status.endpoint = {
        port,
        name: card.name ?? card.id ?? null,
        kind: card.run || card.base ? "kev" : "readout",
        run: card.run ?? null,
        base: card.base ?? null,
      };
    }
  }
  return status;
}

export class ReadoutError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ReadoutError";
    this.details = details;
    if (details?.status) this.status = details.status; // llama.cpp's own status, e.g. 400 for an oversized prompt
  }
}

/** Sampler settings that leave the reported distribution untouched (true next-token softmax). */
export const UNMASKED_SAMPLERS = Object.freeze({
  temperature: 1.0,
  top_k: 0, // 0 = disabled (no top-k truncation of the reported candidates)
  top_p: 1.0,
  min_p: 0.0,
  typical_p: 1.0,
  repeat_penalty: 1.0,
  presence_penalty: 0.0,
  frequency_penalty: 0.0,
  mirostat: 0,
  seed: 1234,
});

export class LlamaServer {
  constructor({ url = LOCAL_DEFAULTS.llamaUrl, nProbs = LOCAL_DEFAULTS.nProbs, cachePrompt = true, timeoutMs = 120_000 } = {}) {
    this.url = url.replace(/\/$/, "");
    this.nProbs = nProbs;
    this.cachePrompt = cachePrompt;
    this.timeoutMs = timeoutMs;
  }

  async #post(route, body) {
    const response = await fetch(`${this.url}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message ?? parsed?.message ?? text;
      } catch {
        // not JSON — keep the raw body
      }
      throw new ReadoutError(`llama.cpp ${route} failed (${response.status}): ${String(detail).trim().slice(0, 400)}`, { status: response.status, body: text.slice(0, 2000) });
    }
    return JSON.parse(text);
  }

  async healthy() {
    return ((await getJson(`${this.url}/health`, 2000)) ?? {}).status === "ok";
  }

  /** Token ids for a string, using the served model's real tokenizer. */
  async tokenize(content) {
    return (await this.#post("/tokenize", { content })).tokens;
  }

  /** Render chat messages with the model's real chat template (llama-server --jinja). */
  async applyTemplate(messages, opts = {}) {
    return (await this.#post("/apply-template", { messages, ...opts })).prompt;
  }

  /**
   * Probabilities of the FIRST token that follows `prompt`.
   * @returns {Promise<{candidates: Array<{id:number, token:string, logprob:number}>, sampled: object|null, usage: object, ms: number}>}
   */
  async firstTokenDistribution(prompt) {
    const started = performance.now();
    const data = await this.#post("/completion", {
      prompt,
      n_predict: 1,
      n_probs: this.nProbs,
      cache_prompt: this.cachePrompt,
      stream: false,
      ...UNMASKED_SAMPLERS,
    });
    const ms = performance.now() - started;
    const entry = data.completion_probabilities?.[0];
    if (!entry) throw new ReadoutError("/completion returned no completion_probabilities", { data });
    const candidates = (entry.top_logprobs ?? []).map((c) => ({ id: c.id, token: c.token, logprob: c.logprob }));
    return {
      candidates,
      sampled: { id: entry.id, token: entry.token, logprob: entry.logprob },
      usage: {
        prompt_tokens: data.timings?.prompt_n ?? null,
        cached_tokens: data.timings?.cache_n ?? null,
        completion_tokens: data.timings?.predicted_n ?? 1,
        prompt_ms: data.timings?.prompt_ms ?? null,
        predicted_ms: data.timings?.predicted_ms ?? null,
      },
      ms,
    };
  }
}

/**
 * Read a distribution over option labels out of a first-token distribution.
 *
 * Each label is looked up under the space-prefixed surface form the model emits after
 * "Answer:" (" A"); the probability of every token id that stands for the label is summed.
 * Labels that are not single tokens in the served tokenizer are reported in `multiToken`
 * and scored 0 (their first token is shared with a longer candidate, so no exact readout
 * exists) — that is what `label_mass` below 1 measures.
 *
 * @param {Array<{id:number,token:string,logprob:number}>} candidates
 * @param {string[]} labels
 * @param {Map<string, number[]>} tokenIdsByLabel  label -> candidate token ids (from the tokenizer)
 */
export function readoutLabels(candidates, labels, tokenIdsByLabel) {
  const byId = new Map();
  for (const candidate of candidates) byId.set(candidate.id, candidate);
  const raw = {};
  const missing = [];
  const multiToken = [];
  for (const label of labels) {
    const ids = tokenIdsByLabel.get(label) ?? [];
    if (ids.length === 0) {
      raw[label] = 0;
      multiToken.push(label);
      continue;
    }
    let probability = 0;
    let seen = false;
    for (const id of ids) {
      const candidate = byId.get(id);
      if (candidate) {
        probability += Math.exp(candidate.logprob);
        seen = true;
      }
    }
    raw[label] = probability;
    if (!seen) missing.push(label);
  }
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  const probabilities = {};
  for (const label of labels) probabilities[label] = total > 0 ? raw[label] / total : 0;
  return { probabilities, raw, total, missing, multiToken };
}

/** openjev's confidence: 1 - H(p)/log(n), clamped to [0,1] (0 = uniform, 1 = point mass). */
export function confidenceOf(probabilities) {
  const values = Object.values(probabilities).filter((v) => v > 0);
  const n = Object.keys(probabilities).length;
  if (n < 2) return values.length ? 1 : 0;
  const entropy = -values.reduce((acc, p) => acc + p * Math.log(p), 0);
  return Math.min(1, Math.max(0, 1 - entropy / Math.log(n)));
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA", ... (bijective base-26; integer labels are multi-token). */
function labelForIndex(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Canonical option list for a question, in a stable order.
 * - noul   -> true/false
 * - choice -> criteria keys, in insertion order (matches normalizeAnswers' expected key set)
 * - score  -> criteria levels, keyed "0".."n-1"
 */
function optionsFor(question) {
  if (question.type === "noul") {
    const criteria = question.criteria ?? { true: "True", false: "False" };
    return [
      { key: "true", text: String(criteria.true ?? "True") },
      { key: "false", text: String(criteria.false ?? "False") },
    ];
  }
  if (question.type === "choice") return Object.entries(question.criteria ?? {}).map(([key, text]) => ({ key, text: String(text) }));
  if (question.type === "score") return (question.criteria ?? []).map((text, i) => ({ key: String(i), text: String(text) }));
  throw new Error(`unsupported question type: ${question.type}`);
}

function instructionsText(instructions) {
  if (typeof instructions === "string") return instructions;
  const parts = [];
  if (instructions?.question) parts.push(instructions.question);
  for (const rule of instructions?.rules ?? []) parts.push(`- ${rule}`);
  return parts.join("\n");
}

/** The question block appended to the user turn (the state is a separate, shared part). */
function renderQuestionBlock(question, labels) {
  const options = optionsFor(question);
  const lines = options.map((o, i) => `${labels[i]}: ${o.text}`);
  const note = question.type === "noul" ? `Option ${labels[0]} means True, option ${labels[1]} means False.` : null;
  return {
    options,
    text: [
      instructionsText(question.instructions),
      ...(note ? [note] : []),
      "",
      "Options:",
      ...lines,
      "",
      `Answer with the letter of the single best option (${labels[0]}-${labels[options.length - 1]}).`,
      "Answer:",
    ].join("\n"),
  };
}

const SYSTEM_PROMPT =
  "You are an expert classification model. You are given a state and one question about it. " +
  "You always answer with the label letter of exactly one option, and nothing else.";

/** Build one prompt per question; each ends with the "Answer:" cue the readout reads after. */
async function renderPrompts({ server, state, questions, labels }) {
  const stateText = typeof state === "string" ? state : JSON.stringify(state, null, 2);
  const prompts = {};
  const optionMeta = {};
  for (const [id, question] of Object.entries(questions)) {
    const block = renderQuestionBlock(question, labels);
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `State:\n${stateText}\n\n${block.text}` },
    ];
    let full;
    try {
      full = await server.applyTemplate(messages, { chat_template_kwargs: { enable_thinking: false } });
    } catch {
      full = await server.applyTemplate(messages);
    }
    prompts[id] = `${trimAssistantHeader(full)}Answer:`;
    optionMeta[id] = { options: block.options, labels: labels.slice(0, block.options.length) };
  }
  return { prompts, optionMeta };
}

/** Drop the trailing "<|im_start|>assistant\n" the template appends, so we own the cue. */
function trimAssistantHeader(text) {
  const markers = ["<|im_start|>assistant\n", "<|assistant|>\n", "<start_of_turn>model\n", "assistant\n"];
  for (const marker of markers) if (text.endsWith(marker)) return text.slice(0, -marker.length);
  return text;
}

/** Token ids to look up for each label — only the space-prefixed form the model emits here. */
async function labelTokenIds(server, labels) {
  const map = new Map();
  for (const label of labels) {
    const ids = [];
    const tokens = await server.tokenize(` ${label}`);
    if (tokens.length === 1) ids.push(tokens[0]);
    map.set(label, ids);
  }
  return map;
}

/** Alphabet of labels that are single tokens in the served tokenizer (skips "AY", "BQ", ...). */
async function verifiedAlphabet(server, count) {
  const out = [];
  for (let i = 0; out.length < count && i < count * 4 + 64; i++) {
    const label = labelForIndex(i);
    const ids = await labelTokenIds(server, [label]);
    if ((ids.get(label) ?? []).length > 0) out.push(label);
  }
  if (out.length < count) throw new Error(`only ${out.length} single-token labels available, needed ${count}`);
  return out;
}

/**
 * Local provider: answers a batch of Jev questions about one state by first-token readout.
 * `systemOne` and `health` are the interface `handleLocalRequest` needs; any object with
 * those two methods works (that is how the unit tests stub the llama.cpp server).
 */
export class LocalProvider {
  constructor({ url = LOCAL_DEFAULTS.llamaUrl, model = LOCAL_DEFAULTS.model, nProbs = LOCAL_DEFAULTS.nProbs } = {}) {
    this.server = new LlamaServer({ url, nProbs });
    this.model = model;
    this.#alphabetCache = new Map(); // option count -> { labels, tokenIds }
  }

  #alphabetCache;

  /** Verified single-token alphabet big enough for `count` options (built once per size). */
  async #alphabet(count) {
    const cached = this.#alphabetCache.get(count);
    if (cached) return cached;
    const labels = await verifiedAlphabet(this.server, count);
    const tokenIds = await labelTokenIds(this.server, labels);
    const entry = { labels, tokenIds };
    this.#alphabetCache.set(count, entry);
    return entry;
  }

  /** Whether the llama.cpp server behind this provider is up. */
  async health() {
    return this.server.healthy();
  }

  /**
   * Answer a batch of questions about one state.
   * @returns {Promise<{model:string, answers:object, usage:object}>} — the TypeSafe HTTP contract
   */
  async systemOne({ state, questions, model = this.model }) {
    const started = performance.now();
    validateQuestions(questions);
    const entries = Object.entries(questions);
    const maxOptions = Math.max(...entries.map(([, question]) => optionsFor(question).length));
    const { labels, tokenIds } = await this.#alphabet(maxOptions);
    const alphabetMs = performance.now() - started;

    const { prompts, optionMeta } = await renderPrompts({ server: this.server, state, questions, labels });
    const renderMs = performance.now() - started - alphabetMs;

    const answers = {};
    const perQuestion = {};
    let promptTokens = 0;
    let completionTokens = 0;
    let readoutMs = 0;

    for (const [id, question] of entries) {
      const meta = optionMeta[id];
      const activeTokenIds = new Map(meta.labels.map((label) => [label, tokenIds.get(label) ?? []]));
      const readStarted = performance.now();
      const distribution = await this.server.firstTokenDistribution(prompts[id]);
      const read = readoutLabels(distribution.candidates, meta.labels, activeTokenIds);
      readoutMs += performance.now() - readStarted;
      promptTokens += distribution.usage.prompt_tokens ?? 0;
      completionTokens += distribution.usage.completion_tokens ?? 0;

      const probabilities = {};
      meta.labels.forEach((label, i) => {
        probabilities[meta.options[i].key] = read.probabilities[label] ?? 0;
      });
      const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
      const topKey = ranked[0]?.[0] ?? null;

      if (question.type === "noul") {
        answers[id] = { type: "noul", noul: probabilities.true ?? 0 };
      } else if (question.type === "choice") {
        answers[id] = { type: "choice", probabilities, choice: topKey, confidence: confidenceOf(probabilities) };
      } else if (question.type === "score") {
        answers[id] = {
          type: "score",
          probabilities,
          score: Object.entries(probabilities).reduce((acc, [key, p]) => acc + Number(key) * p, 0),
          legend: (question.criteria ?? []).map(String),
          confidence: confidenceOf(probabilities),
        };
      } else {
        throw new Error(`unsupported question type for ${id}: ${question.type}`);
      }

      perQuestion[id] = {
        ms: Math.round(distribution.ms),
        prompt_tokens: distribution.usage.prompt_tokens,
        cached_tokens: distribution.usage.cached_tokens,
        label_mass: read.total,
        missing_labels: read.missing,
        multi_token_labels: read.multiToken,
        top: ranked.slice(0, 3).map(([key, p]) => [key, Number(p.toFixed(4))]),
      };
    }

    return {
      model,
      answers,
      usage: {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        ms_total: Math.round(performance.now() - started),
        ms_alphabet: Math.round(alphabetMs),
        ms_render: Math.round(renderMs),
        ms_readout: Math.round(readoutMs),
        per_question: perQuestion,
      },
    };
  }
}

/**
 * Questions whose captured option-label mass fell short of `threshold`: the model put its
 * probability elsewhere, so the answer would be an artefact of zero-filled labels.
 */
export function lowMassQuestions(response, threshold = MIN_LABEL_MASS) {
  const out = [];
  for (const [id, detail] of Object.entries(response?.usage?.per_question ?? {})) {
    const mass = Number(detail?.label_mass);
    if (Number.isFinite(mass) && mass < threshold) out.push({ id, mass });
  }
  return out;
}

const httpError = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, `request body larger than ${limit} bytes`, "BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Serve the Jev HTTP contract from `provider` (anything with `health()` and
 * `systemOne({state, questions, model})`):
 *
 *   GET  /health          -> {status: "ok"} | 503 {status: "backend-down"} (both tagged jev-local)
 *   GET  /v1/models       -> {models: [{name, ...}]}      (the shape the skill's client reads)
 *   POST /v1/systemone    -> {model, answers, usage}      422 when an answer was not read out
 *
 * The 422 (`LOW_LABEL_MASS`) names the question: fewer than half of the probability mass
 * landed on its option labels, so answering would be guesswork rather than a readout.
 */
export async function handleLocalRequest(req, res, provider) {
  const started = performance.now();
  try {
    const route = new URL(req.url, "http://127.0.0.1").pathname;

    if (req.method === "GET" && (route === "/health" || route === "/health/live")) {
      const healthy = await provider.health();
      return sendJson(res, healthy ? 200 : 503, { status: healthy ? "ok" : "backend-down", service: SERVICE, model: provider.model ?? LOCAL_DEFAULTS.model });
    }

    if (req.method === "GET" && route.startsWith("/v1/models")) {
      return sendJson(res, 200, {
        models: [{ name: provider.model ?? LOCAL_DEFAULTS.model, description: "Local llama.cpp first-token readout backend (experimental)", modalities: ["text"] }],
      });
    }

    if (req.method !== "POST" || route !== "/v1/systemone") {
      return sendJson(res, 404, { error: { message: `not found: ${req.method} ${route}`, code: "NOT_FOUND" } });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      if (error.status) throw error;
      throw httpError(400, `request body is not JSON: ${error.message}`, "INVALID_JSON");
    }

    validateQuestions(body.questions);
    const response = await provider.systemOne({ state: body.state, questions: body.questions, model: body.model ?? provider.model });

    const low = lowMassQuestions(response);
    if (low.length > 0) {
      const message = low
        .map(({ id, mass }) => `question ${id}: only ${(mass * 100).toFixed(1)}% of the probability mass landed on its option labels (needs >= ${MIN_LABEL_MASS * 100}%)`)
        .join("; ");
      throw httpError(422, message, "LOW_LABEL_MASS", { questions: low });
    }

    return sendJson(res, 200, { ...response, usage: { ...response.usage, ms_wall: Math.round(performance.now() - started) } });
  } catch (error) {
    const status = error.status ?? (error.code === "INVALID_QUESTIONS" ? 422 : 500);
    const code = error.code ?? "PROVIDER_ERROR";
    process.stderr.write(`[local] ${code}: ${error.message}\n`);
    return sendJson(res, status, { error: { message: error.message, code, ...(error.questions ? { questions: error.questions } : {}) } });
  }
}
