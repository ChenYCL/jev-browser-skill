// EXPERIMENTAL — not part of the jev-browser skill.
// Renders a Jev `/v1/systemone` request (state + questions) into prompts whose next
// token is an option label — the position the logprob readout reads.

import { labelForIndex } from "./labels.mjs";

export const SYSTEM_PROMPT =
  "You are an expert classification model. You are given a state and one question about it. " +
  "You always answer with the label letter of exactly one option, and nothing else.";

const DEFAULT_ENDING = "answer";

/**
 * Canonical option list for a question, in a stable order.
 * - noul   -> [{ key: "true", label: "A" }, { key: "false", label: "B" }]
 * - choice -> criteria keys, in insertion order (matches normalizeAnswers' expected key set)
 * - score  -> criteria levels, keyed "0".."n-1"
 */
export function optionsFor(question) {
  if (question.type === "noul") {
    const criteria = question.criteria ?? { true: "True", false: "False" };
    return [
      { key: "true", text: String(criteria.true ?? "True") },
      { key: "false", text: String(criteria.false ?? "False") },
    ];
  }
  if (question.type === "choice") {
    return Object.entries(question.criteria ?? {}).map(([key, text]) => ({ key, text: String(text) }));
  }
  if (question.type === "score") {
    return (question.criteria ?? []).map((text, i) => ({ key: String(i), text: String(text) }));
  }
  throw new Error(`unsupported question type: ${question.type}`);
}

function instructionsText(instructions) {
  if (typeof instructions === "string") return instructions;
  const parts = [];
  if (instructions?.question) parts.push(instructions.question);
  for (const rule of instructions?.rules ?? []) parts.push(`- ${rule}`);
  return parts.join("\n");
}

/** The question block appended to the user turn (state is a separate, shared part). */
export function renderQuestionBlock(question, labels, { fewShot = null } = {}) {
  const options = optionsFor(question);
  const lines = options.map((o, i) => `${labels[i]}: ${o.text}`);
  const head =
    question.type === "noul"
      ? { question: instructionsText(question.instructions), note: `Option ${labels[0]} means True, option ${labels[1]} means False.` }
      : { question: instructionsText(question.instructions), note: null };
  return {
    options,
    text: [
      head.question,
      ...(head.note ? [head.note] : []),
      ...(fewShot ? ["", fewShot] : []),
      "",
      "Options:",
      ...lines,
      "",
      `Answer with the letter of the single best option (${labels[0]}-${labels[options.length - 1]}).`,
      "Answer:",
    ].join("\n"),
  };
}

/**
 * Build the shared chat prefix (system + state) and one branch prompt per question.
 *
 * `ending`:
 *   "answer"       — prompt ends with "Answer:" (readout position is the label itself)
 *   "answer-space" — prompt ends with "Answer: "
 *   "chat"         — the model's own assistant header is the last thing (no "Answer:")
 */
export async function renderPrompts({ server, state, questions, labels, ending = DEFAULT_ENDING, enableThinking = false, system = SYSTEM_PROMPT, fewShot = null }) {
  const stateText = typeof state === "string" ? state : JSON.stringify(state, null, 2);
  const baseMessages = [
    { role: "system", content: system },
    { role: "user", content: `State:\n${stateText}` },
  ];
  const templateOpts = { chat_template_kwargs: { enable_thinking: enableThinking } };
  const base = await renderVia(server, baseMessages, templateOpts);

  // The chat template closes the user turn and opens the assistant turn. For the
  // "answer" endings we keep the template's assistant header and append the answer
  // cue to it; for "chat" we leave the template untouched.
  const prompts = {};
  const optionMeta = {};
  for (const [id, question] of Object.entries(questions)) {
    const block = renderQuestionBlock(question, labels, { fewShot });
    const messages = [
      { role: "system", content: system },
      { role: "user", content: `State:\n${stateText}\n\n${block.text}` },
    ];
    const full = await renderVia(server, messages, templateOpts);
    prompts[id] = ending === "chat" ? full : `${trimAssistantHeader(full)}${ending === "answer-space" ? "Answer: " : "Answer:"}`;
    optionMeta[id] = { options: block.options, labels: labels.slice(0, block.options.length) };
  }
  return { base, prompts, optionMeta };
}

async function renderVia(server, messages, templateOpts) {
  try {
    return await server.applyTemplate(messages, templateOpts);
  } catch {
    return await server.applyTemplate(messages);
  }
}

/** Drop the trailing "<|im_start|>assistant\n" the template appends, so we own the cue. */
function trimAssistantHeader(text) {
  const markers = ["<|im_start|>assistant\n", "<|assistant|>\n", "<start_of_turn>model\n", "assistant\n"];
  for (const m of markers) if (text.endsWith(m)) return text.slice(0, -m.length);
  return text;
}

/**
 * Token ids to look up for each label, from the served tokenizer.
 * `surface` is the form the model actually emits at the readout position — "spaced"
 * for the "Answer:" endings, "bare" for the model's own assistant header — and only
 * that form is accepted, because a label whose emitted form is multi-token has no
 * exact one-token readout. (`surface: "either"` keeps both and sums them.)
 */
export async function labelTokenIds(server, labels, { surface = "spaced" } = {}) {
  const map = new Map();
  for (const label of labels) {
    const ids = [];
    const forms = surface === "either" ? [` ${label}`, label] : surface === "bare" ? [label] : [` ${label}`];
    for (const form of forms) {
      const tokens = await server.tokenize(form);
      if (tokens.length === 1 && !ids.includes(tokens[0])) ids.push(tokens[0]);
    }
    map.set(label, ids);
  }
  return map;
}

/**
 * Alphabet of labels that are single tokens in the served tokenizer, skipping the
 * combinations Qwen splits (measured: AY, BQ, BZ, CQ, DQ, ...). Mirrors openjev's
 * "verified single-token letter combinations".
 */
export async function verifiedAlphabet(server, count, { surface = "spaced" } = {}) {
  const out = [];
  for (let i = 0; out.length < count && i < count * 4 + 64; i++) {
    const label = labelForIndex(i);
    const ids = await labelTokenIds(server, [label], { surface });
    if ((ids.get(label) ?? []).length > 0) out.push(label);
  }
  if (out.length < count) throw new Error(`only ${out.length} single-token labels available, needed ${count}`);
  return out;
}
