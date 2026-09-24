// EXPERIMENTAL — not part of the jev-browser skill.
// A zero-Python local provider that speaks the TypeSafe/Jev `/v1/systemone` contract
// on top of a llama.cpp server, by reading option-label probabilities at the first
// generated token (no training, no text generation, no output parsing).

import { LlamaServer, readoutLabels, confidenceOf, DEFAULT_SERVER, DEFAULT_N_PROBS } from "./readout.mjs";
import { optionsFor, renderPrompts, labelTokenIds } from "./render.mjs";
import { verifiedAlphabet } from "./render.mjs";

export class GgufProvider {
  /**
   * @param {object} opts
   * @param {string} [opts.url]         llama-server base URL
   * @param {string} [opts.model]       model id echoed back in the response
   * @param {number} [opts.nProbs]      candidates requested per readout
   * @param {string} [opts.ending]      "answer" | "answer-space" | "chat"
   * @param {boolean} [opts.verbose]    print per-question readout detail to stderr
   */
  constructor({ url = DEFAULT_SERVER, model = "gguf-local", nProbs = DEFAULT_N_PROBS, ending = "answer", verbose = false } = {}) {
    this.server = new LlamaServer({ url, nProbs });
    this.model = model;
    this.ending = ending;
    this.verbose = verbose;
    this.#alphabetCache = new Map(); // count -> { labels, tokenIds }
  }

  #alphabetCache;

  /** Verified single-token alphabet big enough for `count` options (built once per size). */
  async #alphabet(count) {
    const cached = this.#alphabetCache.get(count);
    if (cached) return cached;
    const surface = this.ending === "chat" ? "bare" : "spaced";
    const labels = await verifiedAlphabet(this.server, count, { surface });
    const tokenIds = await labelTokenIds(this.server, labels, { surface });
    const entry = { labels, tokenIds, surface };
    this.#alphabetCache.set(count, entry);
    return entry;
  }

  async health() {
    return this.server.healthy();
  }

  /**
   * Answer a batch of questions about one state.
   * @returns {Promise<{model:string, answers:object, usage:object}>} — the HTTP contract of Jev
   */
  async systemOne({ state, questions, model = this.model }) {
    const t0 = performance.now();
    if (!questions || typeof questions !== "object" || Array.isArray(questions) || Object.keys(questions).length === 0) {
      throw new Error("questions must be a non-empty object keyed by question id");
    }
    const entries = Object.entries(questions);
    const maxOptions = Math.max(...entries.map(([, q]) => optionsFor(q).length));
    const { labels, tokenIds } = await this.#alphabet(maxOptions);
    const tokenizeAndTemplateMs = performance.now() - t0;

    const { prompts, optionMeta } = await renderPrompts({ server: this.server, state, questions, labels, ending: this.ending });
    const renderMs = performance.now() - t0 - tokenizeAndTemplateMs;

    const answers = {};
    const detail = {};
    let promptTokens = 0;
    let completionTokens = 0;
    let readoutMs = 0;

    for (const [id, question] of entries) {
      const meta = optionMeta[id];
      const activeLabels = meta.labels;
      const activeTokenIds = new Map(activeLabels.map((l) => [l, tokenIds.get(l) ?? []]));
      const tRead = performance.now();
      const dist = await this.server.firstTokenDistribution(prompts[id]);
      const read = readoutLabels(dist.candidates, activeLabels, activeTokenIds);
      readoutMs += performance.now() - tRead;
      promptTokens += dist.usage.prompt_tokens ?? 0;
      completionTokens += dist.usage.completion_tokens ?? 0;

      const probs = {};
      activeLabels.forEach((label, i) => {
        probs[meta.options[i].key] = read.probabilities[label] ?? 0;
      });
      const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]);
      const topKey = ranked[0]?.[0] ?? null;

      if (question.type === "noul") {
        answers[id] = { type: "noul", noul: probs.true ?? 0 };
      } else if (question.type === "choice") {
        answers[id] = { type: "choice", probabilities: probs, choice: topKey, confidence: confidenceOf(probs) };
      } else if (question.type === "score") {
        const score = Object.entries(probs).reduce((acc, [k, p]) => acc + Number(k) * p, 0);
        answers[id] = {
          type: "score",
          probabilities: probs,
          score,
          legend: (question.criteria ?? []).map(String),
          confidence: confidenceOf(probs),
        };
      } else {
        throw new Error(`unsupported question type for ${id}: ${question.type}`);
      }

      detail[id] = {
        ms: Math.round(dist.ms),
        prompt_tokens: dist.usage.prompt_tokens,
        cached_tokens: dist.usage.cached_tokens,
        label_mass: read.total,
        missing_labels: read.missing,
        multi_token_labels: read.multiToken,
        top: ranked.slice(0, 3).map(([k, p]) => [k, Number(p.toFixed(4))]),
        sampled_token: dist.sampled?.token,
      };
      if (this.verbose) {
        process.stderr.write(
          `[readout] ${id} ${Math.round(dist.ms)}ms labels=${read.probabilities ? Object.keys(read.probabilities).length : 0} ` +
            `labelMass=${read.total.toFixed(3)} top=${JSON.stringify(detail[id].top)}\n`,
        );
      }
    }

    return {
      model,
      answers,
      usage: {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        ms_total: Math.round(performance.now() - t0),
        ms_alpha: Math.round(tokenizeAndTemplateMs),
        ms_render: Math.round(renderMs),
        ms_readout: Math.round(readoutMs),
        per_question: detail,
      },
    };
  }
}
