// Minimal TypeSafe System One HTTP client (no SDK dependency).
// Contract: POST {baseUrl}/v1/systemone  Authorization: Bearer <key>
// Request: { model, state, questions }  Response: { model, answers, usage }
import { sha256, sleep, rankProbabilities } from "./util.mjs";

export class TypeSafeError extends Error {
  constructor(message, { status, code, retryable = false, details } = {}) {
    super(message);
    this.name = "TypeSafeError";
    this.status = status;
    this.code = code ?? (status ? `HTTP_${status}` : "REQUEST_FAILED");
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** Validate the question map against the documented API constraints before spending tokens. */
export function validateQuestions(questions) {
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    throw new TypeSafeError("questions must be an object keyed by question id", { code: "INVALID_QUESTIONS" });
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new TypeSafeError("questions must contain at least one question", { code: "INVALID_QUESTIONS" });
  for (const [id, q] of Object.entries(questions)) {
    if (!q || typeof q !== "object") throw new TypeSafeError(`question ${id} must be an object`, { code: "INVALID_QUESTIONS" });
    if (!["noul", "choice", "score"].includes(q.type)) {
      throw new TypeSafeError(`question ${id}: type must be noul, choice or score`, { code: "INVALID_QUESTIONS" });
    }
    if (q.instructions === undefined) throw new TypeSafeError(`question ${id}: instructions required`, { code: "INVALID_QUESTIONS" });
    if (q.type === "choice") {
      const options = q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria) ? Object.keys(q.criteria) : [];
      if (options.length < 2 || options.length > 255) {
        throw new TypeSafeError(`question ${id}: choice needs 2..255 options (got ${options.length})`, { code: "INVALID_QUESTIONS" });
      }
    }
    if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) {
        throw new TypeSafeError(`question ${id}: score needs 2..10 ordered levels`, { code: "INVALID_QUESTIONS" });
      }
    }
    if (q.type === "noul" && q.criteria !== undefined) {
      const keys = Object.keys(q.criteria ?? {});
      if (keys.some((k) => !["true", "false"].includes(k))) {
        throw new TypeSafeError(`question ${id}: noul criteria only accepts true/false`, { code: "INVALID_QUESTIONS" });
      }
    }
  }
}

export const estimateCostUsd = (inputTokens, pricePerMtok = 0.042) =>
  (Number(inputTokens) || 0) * (pricePerMtok / 1e6);

/** True when the contract is served from this machine (a local llama.cpp backend costs nothing). */
export function isLoopbackBaseUrl(baseUrl) {
  try {
    const host = new URL(String(baseUrl)).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** USD per million input tokens actually charged for `baseUrl`: loopback tokens are free, so 0. */
export const pricePerMtokFor = (baseUrl, pricePerMtok = 0.042) => (isLoopbackBaseUrl(baseUrl) ? 0 : pricePerMtok);

/**
 * Normalize answers so every question exposes `probabilities`, `top`, and `ranked`.
 * Nouls become {true, false}; choice/score keep the native map.
 */
export function normalizeAnswers(answers, questions) {
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = answers?.[id];
    if (!a || a.type !== q.type) {
      throw new TypeSafeError(`answer for ${id} missing or of wrong type`, { code: "INVALID_RESPONSE", details: { id } });
    }
    if (q.type === "noul") {
      const p = Number(a.noul);
      if (!(p >= 0 && p <= 1)) throw new TypeSafeError(`noul ${id} out of range`, { code: "INVALID_RESPONSE" });
      out[id] = { type: "noul", noul: p, probabilities: { true: p, false: 1 - p }, top: p >= 0.5 ? "true" : "false" };
      continue;
    }
    const probabilities = { ...(a.probabilities ?? {}) };
    const expected = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    for (const key of expected) if (!(key in probabilities)) probabilities[key] = 0;
    const ranked = rankProbabilities(probabilities);
    out[id] = {
      type: q.type,
      probabilities,
      ranked,
      top: ranked[0]?.[0] ?? null,
      confidence: typeof a.confidence === "number" ? a.confidence : null,
      ...(q.type === "choice" ? { choice: a.choice ?? ranked[0]?.[0] } : { score: a.score, legend: a.legend }),
    };
  }
  return out;
}

export class TypeSafeClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.baseUrl]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxRetries]
   * @param {number} [options.pricePerMtok] USD per million input tokens; ignored (0) for a loopback baseUrl
   * @param {Function} [options.fetchImpl]
   * @param {(row: object) => any} [options.onRequest] journal hook
   * @param {boolean} [options.cache] reuse answers for identical (model,state,questions)
   */
  constructor({ apiKey, baseUrl = "https://api.typesafe.ai", model = "jev-latest", timeoutMs = 20_000, maxRetries = 2, pricePerMtok = 0.042, fetchImpl, onRequest, cache = true } = {}) {
    if (!apiKey) {
      throw new TypeSafeError("Missing TypeSafe API key. Set TYPESAFE_API_KEY or run: jev-browser config set-key", { code: "MISSING_API_KEY" });
    }
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.pricePerMtok = pricePerMtokFor(this.baseUrl, pricePerMtok);
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.onRequest = onRequest;
    this.cacheEnabled = cache;
    this.cache = new Map();
    this.totals = { requests: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };
    this.sequence = 0;
  }

  async models() {
    const response = await this.fetch(`${this.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new TypeSafeError(`models request failed (${response.status})`, { status: response.status });
    return response.json();
  }

  /**
   * Ask a batch of independent questions about one state.
   * Returns { model, answers (normalized), raw, usage, costUsd, ms, cacheHit, requestId }.
   */
  async systemOne({ state, questions, model, signal } = {}) {
    validateQuestions(questions);
    const body = { model: model ?? this.model, state, questions };
    const key = sha256(body);
    if (this.cacheEnabled && this.cache.has(key)) {
      this.totals.cacheHits += 1;
      return { ...this.cache.get(key), cacheHit: true };
    }
    const requestId = `jev-${String(++this.sequence).padStart(5, "0")}`;
    const started = performance.now();
    let attempt = 0;
    let lastError;
    while (attempt <= this.maxRetries) {
      attempt += 1;
      try {
        const raw = await this.#post(body, signal);
        const ms = Math.round(performance.now() - started);
        const usage = raw.usage ?? {};
        const costUsd = estimateCostUsd(usage.input_tokens, this.pricePerMtok);
        this.totals.requests += 1;
        this.totals.inputTokens += usage.input_tokens ?? 0;
        this.totals.outputTokens += usage.output_tokens ?? 0;
        this.totals.costUsd += costUsd;
        this.totals.ms += ms;
        const result = {
          requestId,
          model: raw.model,
          answers: normalizeAnswers(raw.answers, questions),
          raw: raw.answers,
          usage,
          costUsd,
          ms,
          attempts: attempt,
          cacheHit: false,
          inputSha256: key,
        };
        if (this.cacheEnabled) this.cache.set(key, result);
        await this.onRequest?.({ requestId, inputSha256: key, model: raw.model, usage, costUsd, ms, attempts: attempt, status: "succeeded" });
        return result;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof TypeSafeError ? error.retryable : true;
        if (!retryable || attempt > this.maxRetries || signal?.aborted) break;
        const retryAfter = error.retryAfterMs ?? Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
        await sleep(retryAfter);
      }
    }
    await this.onRequest?.({ requestId, inputSha256: key, status: "failed", error: lastError?.code ?? "REQUEST_FAILED", message: sanitize(lastError?.message, this.apiKey) });
    throw lastError;
  }

  async #post(body, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let response;
      try {
        response = await this.fetch(`${this.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        const timedOut = controller.signal.aborted && String(controller.signal.reason?.message).includes("timeout");
        throw new TypeSafeError(timedOut ? `TypeSafe request timed out after ${this.timeoutMs}ms` : `TypeSafe connection failed: ${sanitize(error.message, this.apiKey)}`, {
          code: timedOut ? "TIMEOUT" : "CONNECTION",
          retryable: !signal?.aborted,
        });
      }
      const text = await response.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text.slice(0, 500) };
      }
      if (!response.ok) {
        const retryable = RETRYABLE_STATUS.has(response.status);
        const detail = json?.detail ?? json?.error ?? json?.message ?? json?.raw;
        const error = new TypeSafeError(
          response.status === 401
            ? "TypeSafe rejected the API key (401). Check TYPESAFE_API_KEY."
            : `TypeSafe request failed (${response.status})${detail ? `: ${sanitize(typeof detail === "string" ? detail : JSON.stringify(detail), this.apiKey).slice(0, 400)}` : ""}`,
          { status: response.status, retryable, details: json },
        );
        const ra = Number(response.headers.get("retry-after"));
        if (retryable && Number.isFinite(ra) && ra > 0) error.retryAfterMs = Math.min(ra * 1000, 30_000);
        throw error;
      }
      if (!json || typeof json.answers !== "object") {
        throw new TypeSafeError("TypeSafe response has no answers", { code: "INVALID_RESPONSE", details: json });
      }
      return json;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function sanitize(text, secret) {
  if (typeof text !== "string") return text;
  return secret ? text.split(secret).join("[REDACTED]") : text;
}
