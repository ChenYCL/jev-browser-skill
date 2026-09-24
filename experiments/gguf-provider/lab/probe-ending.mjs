// EXPERIMENTAL — not part of the jev-browser skill.
// Which prompt ending puts the option label at the readout position?
// Prints the tail of each rendered prompt and the model's top tokens there.
//
//   node experiments/gguf-provider/lab/probe-ending.mjs [--url http://127.0.0.1:8090]
import { LlamaServer } from "../lib/readout.mjs";
import { renderPrompts } from "../lib/render.mjs";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const server = new LlamaServer({ url: arg("--url", "http://127.0.0.1:8090"), nProbs: 20 });

const state = {
  goal: "find today's price of AAPL",
  inputs: "none provided",
  page: {
    url: "https://example.com/",
    title: "Example Domain",
    headings: ["# Example Domain"],
    dialog: null,
    scroll_position: "page fits in the viewport",
    visible_text: "Example Domain This domain is for use in documentation examples without needing permission.",
    elements: [{ id: "e1", description: "link 'Learn more' -> https://iana.org/domains/example", in_viewport: true }],
    omitted_elements: 0,
  },
  previous_page: null,
  last_action: null,
  history: { steps_taken: 0, recent_urls: [] },
};

const questions = {
  goal_done: {
    type: "noul",
    instructions: {
      question: "Is `goal` already fully accomplished according to what `page` shows right now?",
      rules: ["Judge only from `page`.", "A page that merely offers a way to accomplish `goal` does not count."],
    },
    criteria: { true: "`page` shows the end result that `goal` asks for.", false: "At least one more action is needed." },
  },
};

const labels = ["A", "B", "C", "D", "E", "F", "G", "H"];
for (const ending of ["answer", "answer-space", "chat"]) {
  const { prompts } = await renderPrompts({ server, state, questions, labels, ending });
  const dist = await server.firstTokenDistribution(prompts.goal_done);
  console.log(`\n=== ending: ${ending} ===`);
  console.log(`prompt tail: ${JSON.stringify(prompts.goal_done.slice(-120))}`);
  console.log(`prompt tokens: ${dist.usage.prompt_tokens}`);
  console.log(`top tokens at readout position:`);
  for (const c of dist.candidates.slice(0, 12)) console.log(`   ${JSON.stringify(c.token).padEnd(16)} id=${String(c.id).padEnd(7)} p=${Math.exp(c.logprob).toFixed(4)}`);
}
