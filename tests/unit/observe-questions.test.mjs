import test from "node:test";
import assert from "node:assert/strict";
import { describeElement, elementFingerprint, observationHash, pageStateForModel, ENUMERATOR_SOURCE, enumeratorExpression } from "../../skills/jev-browser/lib/observe.mjs";
import { buildStepQuestions, interpretAnswers, inputsForModel, buildSelectOptionQuestions } from "../../skills/jev-browser/lib/questions.mjs";
import { validateQuestions } from "../../skills/jev-browser/lib/typesafe.mjs";
import { sampleObs } from "../helpers/sample.mjs";


test("describeElement produces compact model-facing descriptions", () => {
  const obs = sampleObs();
  assert.equal(describeElement(obs.elements[0]), "link 'Pricing' → /pricing");
  assert.equal(describeElement(obs.elements[1]), `text field 'Search' (placeholder "Search products", empty)`);
  assert.equal(describeElement(obs.elements[3]), "dropdown 'Quantity' (options: 1 | 2)");
  assert.equal(describeElement(obs.elements[4]), "checkbox 'Gift wrap' (unchecked)");
});

test("observationHash ignores scroll position but tracks content", () => {
  const a = observationHash(sampleObs());
  const b = observationHash(sampleObs({ scroll: { y: 300, max: 900, atTop: false, atBottom: false } }));
  const c = observationHash(sampleObs({ text: "changed" }));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(elementFingerprint(sampleObs().elements[0]), "link|Pricing|/pricing||");
});

test("pageStateForModel keeps ids and descriptions", () => {
  const page = pageStateForModel(sampleObs());
  assert.equal(page.elements[0].id, "e1");
  assert.equal(page.scroll_position, "at the top; more content below");
  assert.deepEqual(page.headings, ["# Products"]);
});

test("enumerator source is a self-contained function expression", () => {
  assert.match(ENUMERATOR_SOURCE.trim(), /^\(function jevEnumerate/);
  assert.match(enumeratorExpression({ maxCandidates: 3 }), /\)\(\{"maxCandidates":3\}\)$/);
  // eslint-disable-next-line no-new-func
  assert.doesNotThrow(() => new Function(`return (${ENUMERATOR_SOURCE})`));
});

test("buildStepQuestions asks only applicable questions and hides secrets", () => {
  const obs = sampleObs();
  const { state, questions, meta } = buildStepQuestions({ obs, goal: "Search for 'blue widget'", inputs: { query: "blue widget", password: "hunter2" }, secretKeys: ["password"] });
  validateQuestions(questions);
  assert.deepEqual(Object.keys(questions).sort(), ["action", "blocker", "click_target", "goal_done", "select_target", "submit_after_type", "type_target", "type_value"]);
  assert.deepEqual(meta.allowedActions, ["click", "type", "select", "scroll_down", "wait", "stop"]);
  assert.equal(JSON.stringify(state).includes("hunter2"), false);
  assert.equal(JSON.stringify(questions).includes("hunter2"), false);
  assert.equal(state.inputs.password, "[secret value: hidden from the model, available to type]");
  assert.deepEqual(Object.keys(questions.click_target.criteria), ["e1", "e3", "e4", "e5", "none"]);
  assert.deepEqual(Object.keys(questions.type_target.criteria), ["e2", "none"]);
  assert.deepEqual(Object.keys(questions.type_value.criteria), ["query", "password", "none"]);
  assert.equal(questions.type_value.criteria.password.includes("secret"), true);
});

test("buildStepQuestions adds progress/go_back/navigate when applicable", () => {
  const obs = sampleObs({ scroll: { y: 0, max: 0, atTop: true, atBottom: true } });
  const { questions, meta } = buildStepQuestions({ obs, goal: "g", inputs: { home: "https://example.com", docs: "https://example.com/docs" }, previous: sampleObs(), lastAction: "clicked link 'Pricing'", historyLength: 2 });
  assert.ok(questions.progress);
  assert.equal(questions.progress.criteria.length, 4);
  assert.ok(questions.navigate_target);
  assert.deepEqual(meta.allowedActions, ["click", "type", "select", "go_back", "navigate", "wait", "stop"]);
  assert.equal(inputsForModel({}), "none provided");
});

test("interpretAnswers ranks and strips none", () => {
  const meta = { allowedActions: ["click", "type", "stop"] };
  const answers = {
    goal_done: { type: "noul", noul: 0.1 },
    blocker: { type: "choice", top: "none", probabilities: { none: 0.9, error_page: 0.1 }, confidence: 0.9 },
    action: { type: "choice", ranked: [["click", 0.6], ["scroll_down", 0.3], ["type", 0.1]], confidence: 0.5 },
    click_target: { type: "choice", ranked: [["e1", 0.7], ["none", 0.2], ["e3", 0.1]], probabilities: { e1: 0.7, none: 0.2, e3: 0.1 } },
  };
  const d = interpretAnswers(answers, meta);
  assert.deepEqual(d.actions, [["click", 0.6], ["type", 0.1]]);
  assert.deepEqual(d.clickTargets, [["e1", 0.7], ["e3", 0.1]]);
  assert.equal(d.clickNone, 0.2);
  assert.equal(d.blocker.top, "none");
});

test("buildSelectOptionQuestions maps options to opt indexes", () => {
  const obs = sampleObs();
  const { questions, optionValues } = buildSelectOptionQuestions({ obs, element: obs.elements[3], goal: "buy two" });
  validateQuestions(questions);
  assert.deepEqual(Object.keys(questions.option.criteria), ["opt0", "opt1", "none"]);
  assert.deepEqual(optionValues, ["1", "2"]);
});
