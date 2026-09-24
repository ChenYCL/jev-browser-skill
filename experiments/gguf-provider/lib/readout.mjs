// EXPERIMENTAL — not part of the jev-browser skill.
// First-token logprob readout against a local llama.cpp server.
//
// The trick (mirrors ekzhang/openjev-sglang): render the question with labelled
// options, generate exactly ONE token, and read the probability mass the model puts
// on each option label at that position. No training, no text generation, no parsing.
//
// All samplers are disabled (temperature 1.0, top_k 0, top_p 1, min_p 0, no penalties)
// so the reported probabilities are the model's true next-token softmax over the
// first `nProbs` tokens.

export const DEFAULT_SERVER = "http://127.0.0.1:8090";
export const DEFAULT_N_PROBS = 512;

/** Sampler settings that leave the distribution untouched. */
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

export class ReadoutError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ReadoutError";
    this.details = details;
  }
}

export class LlamaServer {
  constructor({ url = DEFAULT_SERVER, nProbs = DEFAULT_N_PROBS, cachePrompt = true, timeoutMs = 120_000 } = {}) {
    this.url = url.replace(/\/$/, "");
    this.nProbs = nProbs;
    this.cachePrompt = cachePrompt;
    this.timeoutMs = timeoutMs;
    this.stats = { calls: 0, promptTokens: 0, completionTokens: 0, promptMs: 0, predictedMs: 0 };
  }

  async #post(path, body) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new ReadoutError(`POST ${path} -> ${res.status}`, { body: text.slice(0, 2000) });
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async healthy() {
    try {
      const res = await fetch(`${this.url}/health`);
      return (await res.json()).status === "ok";
    } catch {
      return false;
    }
  }

  /** Token ids for a string, using the served model's real tokenizer. */
  async tokenize(content) {
    return (await this.#post("/tokenize", { content })).tokens;
  }

  /** Render chat messages with the model's real chat template (needs --jinja). */
  async applyTemplate(messages, opts = {}) {
    return (await this.#post("/apply-template", { messages, ...opts })).prompt;
  }

  /**
   * Probabilities of the FIRST token that follows `prompt`.
   * @returns {Promise<{candidates: Array<{id:number, token:string, logprob:number}>, sampled: object|null, usage: object, ms: number}>}
   */
  async firstTokenDistribution(prompt) {
    const t0 = performance.now();
    const data = await this.#post("/completion", {
      prompt,
      n_predict: 1,
      n_probs: this.nProbs,
      cache_prompt: this.cachePrompt,
      stream: false,
      ...UNMASKED_SAMPLERS,
    });
    const ms = performance.now() - t0;
    const entry = data.completion_probabilities?.[0];
    if (!entry) throw new ReadoutError("/completion returned no completion_probabilities", { data });
    const candidates = (entry.top_logprobs ?? []).map((c) => ({ id: c.id, token: c.token, logprob: c.logprob }));
    const usage = {
      prompt_tokens: data.timings?.prompt_n ?? null,
      cached_tokens: data.timings?.cache_n ?? null,
      completion_tokens: data.timings?.predicted_n ?? 1,
      prompt_ms: data.timings?.prompt_ms ?? null,
      predicted_ms: data.timings?.predicted_ms ?? null,
    };
    this.stats.calls += 1;
    this.stats.promptTokens += usage.prompt_tokens ?? 0;
    this.stats.completionTokens += usage.completion_tokens ?? 1;
    this.stats.promptMs += usage.prompt_ms ?? 0;
    this.stats.predictedMs += usage.predicted_ms ?? 0;
    return { candidates, sampled: { id: entry.id, token: entry.token, logprob: entry.logprob }, usage, ms };
  }
}

/**
 * Read a distribution over option labels out of a first-token distribution.
 *
 * Each label is looked up under both surface forms the model may emit — the bare
 * label ("A") and the space-prefixed label (" A") — and the two token probabilities
 * are ADDED, because either surface form means the same answer. Labels that are not
 * single tokens in the served tokenizer are reported in `multiToken` and scored 0
 * (their first token is shared with a longer candidate, so no exact readout exists).
 *
 * @param {Array<{id:number,token:string,logprob:number}>} candidates
 * @param {string[]} labels
 * @param {Map<string, number[]>} tokenIdsByLabel  label -> candidate token ids (from the tokenizer)
 */
export function readoutLabels(candidates, labels, tokenIdsByLabel) {
  const byId = new Map();
  for (const c of candidates) byId.set(c.id, c);
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
    let p = 0;
    let seen = false;
    for (const id of ids) {
      const c = byId.get(id);
      if (c) {
        p += Math.exp(c.logprob);
        seen = true;
      }
    }
    raw[label] = p;
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
  const h = -values.reduce((acc, p) => acc + p * Math.log(p), 0);
  const c = 1 - h / Math.log(n);
  return Math.min(1, Math.max(0, c));
}
