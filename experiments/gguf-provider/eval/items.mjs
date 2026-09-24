// EXPERIMENTAL — not part of the jev-browser skill.
// The eval set: items whose ground truth is known BY CONSTRUCTION.
//
// Two families:
//  - browser: a REAL page state captured with `jev-browser run --dry-run` (the fixture
//    files in ../fixtures/), with the correct answer read off the state by hand and
//    recorded in `why`. No synthetic element lists.
//  - noul: short passage + yes/no question, answer obvious from the passage.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export function loadFixture(file) {
  const raw = readFileSync(join(FIXTURES, file), "utf8");
  return JSON.parse(raw.slice(raw.indexOf("{")));
}

const DDG = "raw_duckduckgo_com_html__q_apple_stock_price.txt";
const DDG_TYPED = "raw_ddg_typed.txt";
const WIKI = "raw_en_wikipedia_org_wiki_Main_Page.txt";
const WIKI_TYPED = "raw_wiki_typed.txt";
const GITHUB = "raw_github_login.txt";

/** Browser-decision items. `expect` is keyed by question id. */
export const BROWSER_ITEMS = [
  {
    id: "ddg-click-target-aapl",
    fixture: DDG,
    state: { goal: "find today's price of AAPL" },
    expect: { click_target: "e1" },
    why: "e1 is the only organic result actually about the AAPL quote ('View today's Apple Inc stock price and latest AAPL news and analysis' -> investing.com); e2/e4 are DuckDuckGo chrome and e7.. are ads.",
  },
  {
    id: "ddg-action-aapl",
    fixture: DDG,
    state: { goal: "find today's price of AAPL" },
    expect: { action: "click" },
    why: "Allowed actions are click/select/scroll_down/wait/stop; the next step is opening the quote page, so click.",
  },
  {
    id: "ddg-blocker-aapl",
    fixture: DDG,
    state: { goal: "find today's price of AAPL" },
    expect: { blocker: "none" },
    why: "No login wall, CAPTCHA, consent modal or error page is present.",
  },
  {
    id: "ddg-goal-done-aapl",
    fixture: DDG,
    state: { goal: "find today's price of AAPL" },
    expect: { goal_done: false },
    why: "visible_text contains no price and the title is 'apple stock price at DuckDuckGo' - a results page only OFFERS a way to reach the price, which the question rules exclude.",
  },
  {
    id: "ddg-typed-action",
    fixture: DDG_TYPED,
    state: { goal: "search for the nvidia stock price" },
    expect: { action: "type" },
    why: "inputs.query is provided and the page has a text field (e3), so typing is the next step.",
  },
  {
    id: "ddg-typed-type-target",
    fixture: DDG_TYPED,
    state: { goal: "search for the nvidia stock price" },
    expect: { type_target: "e3" },
    why: "e3 is the search field 'q' (currently holding the previous query); there is no other text field.",
  },
  {
    id: "ddg-typed-submit",
    fixture: DDG_TYPED,
    state: { goal: "search for the nvidia stock price" },
    expect: { submit_after_type: true },
    why: "A single search box submits on Enter (the page also has a Search button, but pressing Enter is the natural way to submit this field).",
  },
  {
    id: "wiki-login-click-target",
    fixture: WIKI,
    state: { goal: "log in to Wikipedia" },
    expect: { click_target: "e9" },
    why: "e9 is the only 'Log in' link on the page.",
  },
  {
    id: "wiki-typed-type-target",
    fixture: WIKI_TYPED,
    state: { goal: "search Wikipedia for the article about bacteria" },
    expect: { type_target: "e1" },
    why: "e1 is the only text field ('Search Wikipedia'); e3 is a link named 'bacteria', not a field.",
  },
  {
    id: "github-login-type-target",
    fixture: GITHUB,
    state: { goal: "sign in to GitHub" },
    expect: { type_target: "e3" },
    why: "e3 is the empty required 'Username or email address' field; e5 is the password field that comes after it.",
  },
  {
    id: "github-login-type-value",
    fixture: GITHUB,
    state: { goal: "sign in to GitHub" },
    expect: { type_value: "username" },
    why: "The chosen field is the username field, and inputs.username is the matching (non-secret) input.",
  },
  {
    id: "github-login-submit",
    fixture: GITHUB,
    state: { goal: "sign in to GitHub" },
    expect: { submit_after_type: false },
    why: "The password field is still empty, so Enter must not be pressed yet.",
  },
  {
    id: "github-login-action",
    fixture: GITHUB,
    state: { goal: "sign in to GitHub" },
    expect: { action: "type" },
    why: "Both credentials are in inputs and both required fields are listed, so typing is the next step.",
  },
  {
    id: "github-login-blocker",
    fixture: GITHUB,
    state: { goal: "sign in to GitHub" },
    expect: { blocker: "none" },
    why: "The login form is fillable with the provided inputs, so it is explicitly not an obstacle.",
  },
];

/** Questions the controller only consumes conditionally; reported separately. */
export const SPECULATIVE_ITEMS = [
  {
    id: "ddg-typed-select-target",
    fixture: DDG_TYPED,
    state: { goal: "search for the nvidia stock price" },
    expect: { select_target: "none" },
    why: "Searching does not require changing the region or time dropdown.",
  },
];

const T = "The passage states this.";
const F = "The passage does not state this.";

const noulQuestion = (question, trueDesc, falseDesc) => ({
  type: "noul",
  instructions: { question, rules: ["Answer only from the passage in the state."] },
  criteria: { true: trueDesc, false: falseDesc },
});

/**
 * The score question (`progress`) only exists from the second step on, because it needs
 * a `previous_page` and a `last_action`. Both come from real captures: the previous page
 * is the captured Wikipedia main page, the current page is the captured Special:UserLogin
 * page reached by clicking its 'Log in' link.
 */
export const PROGRESS_ITEM = {
  id: "wiki-progress-after-login-click",
  fixture: "raw_wiki_loginpage.txt",
  state: {
    goal: "log in to Wikipedia",
    previous_page: null, // filled in by the eval from the main-page fixture
    last_action: "click e9 'Log in'",
  },
  question: {
    type: "score",
    instructions: { question: "Compared with `previous_page`, how did `last_action` change progress toward `goal`, judging by `page`?" },
    criteria: [
      "`page` moved away from `goal`: a wrong page, an error, or lost progress compared with `previous_page`.",
      "No meaningful change toward `goal` compared with `previous_page`.",
      "`page` is closer to `goal` than `previous_page` was.",
      "`page` now shows `goal` accomplished.",
    ],
  },
  expect: { progress: 2 },
  why: "Clicking 'Log in' replaced the encyclopedia main page with the real login form: closer to the goal than before, but the goal (being signed in) is not accomplished.",
};

export const NOUL_ITEMS = [
  { id: "bq-paris", passage: "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France. It was completed in 1889 and is 330 metres tall.", question: "Is the Eiffel Tower located in Paris?", expect: true, why: "Passage says Paris." },
  { id: "bq-penguins", passage: "Penguins are flightless seabirds. Their wings have evolved into flippers, so they cannot fly.", question: "Can penguins fly?", expect: false, why: "Passage says they are flightless." },
  { id: "bq-python", passage: "Python is a high-level, interpreted programming language created by Guido van Rossum and first released in 1991.", question: "Was Python created before 1990?", expect: false, why: "Passage gives 1991." },
  { id: "bq-everest", passage: "Mount Everest is Earth's highest mountain above sea level, at 8,849 metres, in the Mahalangur Himal sub-range of the Himalayas.", question: "Is Mount Everest taller than 8,000 metres?", expect: true, why: "8,849 > 8,000." },
  { id: "bq-trap-failed", passage: "The passage records that the experiment failed and the team stopped the run early.", question: "Did the experiment succeed?", expect: false, why: "Explicitly failed - a polarity trap.", trap: true },
];

/** Build the provider request for one item. */
export function requestFor(item, fixtureCache) {
  if (item.passage !== undefined) {
    const state = { passage: item.passage, question: item.question };
    const questions = { answer: noulQuestion(item.question, T, F) };
    return { state, questions, graded: "answer", expect: item.expect };
  }
  const fixture = fixtureCache[item.fixture] ?? (fixtureCache[item.fixture] = loadFixture(item.fixture));
  const state = structuredClone(fixture.state);
  Object.assign(state, item.state);
  if (item.id === PROGRESS_ITEM.id) {
    const wiki = fixtureCache[WIKI] ?? (fixtureCache[WIKI] = loadFixture(WIKI));
    state.previous_page = {
      url: wiki.state.page.url,
      title: wiki.state.page.title,
      text_excerpt: wiki.state.page.visible_text.slice(0, 600),
      element_count: wiki.state.page.elements.length,
    };
  }
  const graded = Object.keys(item.expect)[0];
  const question = item.question ?? fixture.questions[graded];
  return { state, questions: { [graded]: structuredClone(question) }, graded, expect: item.expect[graded] };
}
