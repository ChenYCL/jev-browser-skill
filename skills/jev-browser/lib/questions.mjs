// The per-step question set. Following NanoJev's split, the model only makes
// small local judgments (is the goal done? what kind of action? which element?);
// code owns memory, budgets, sequencing and termination.
//
// Questions are independent and evaluated in parallel on the same state, so the
// speculative ones (click_target when the action may not be a click, etc.) are
// asked up front and consumed only when relevant.
import { describeElement, pageStateForModel, summarizeObservation } from "./observe.mjs";
import { looksLikeUrl, truncate } from "./util.mjs";

export const ACTION_DESCRIPTIONS = Object.freeze({
  click: {
    what: "Click one element listed in `page.elements` (a link, button, checkbox, radio, tab, menu item, or similar).",
    use_when: "The next step toward `goal` is to open, choose, submit, toggle, or confirm something that is listed.",
  },
  type: {
    what: "Type one of the provided `inputs` values into a text field listed in `page.elements`.",
    use_when: "A form field or search box must be filled before progress is possible, and a suitable value exists in `inputs`.",
  },
  select: {
    what: "Choose an option in a dropdown listed in `page.elements`.",
    use_when: "A dropdown must be set to a value implied by `goal` or `inputs`.",
  },
  scroll_down: {
    what: "Scroll down to reveal content below the current viewport.",
    use_when: "The element or information needed for `goal` is probably further down and is not listed in `page.elements`.",
  },
  scroll_up: {
    what: "Scroll up to reveal content above the current viewport.",
    use_when: "The needed element or information is probably above the current position.",
  },
  go_back: {
    what: "Go back to the previous page in browser history.",
    use_when: "The current page is a wrong turn (irrelevant, an error, or a dead end) and the previous page offered a better path.",
  },
  navigate: {
    what: "Load a URL that is provided in `inputs` directly.",
    use_when: "`inputs` contains a URL that is the destination or a necessary starting point for `goal`.",
  },
  wait: {
    what: "Do nothing for a moment because the page is still loading or a result is still pending.",
    use_when: "The visible text or a dialog indicates loading, processing, or a countdown.",
  },
  stop: {
    what: "Stop: no listed action can make progress toward `goal`.",
    use_when: "`goal` is already accomplished as shown by `page`, or it is impossible from here with the listed actions.",
  },
});

export const BLOCKERS = Object.freeze({
  none: "No obstacle: the page can be operated normally (a login form that can be filled with provided `inputs` is not an obstacle).",
  login_required: "The page requires signing in and `inputs` does not provide the credentials needed to sign in.",
  verification_challenge: "A CAPTCHA, one-time code, two-factor prompt, or similar human verification is shown.",
  consent_or_permission_dialog: "A modal dialog demanding consent, permissions, or a choice from the user blocks the content and nothing listed dismisses it.",
  error_page: "The page shows an error (not found, access denied, server error, network failure) instead of the expected content.",
  missing_information: "Progress requires information (an account, payment details, a value) that is neither on the page nor in `inputs`.",
});

export const PROGRESS_LEVELS = Object.freeze([
  "`page` moved away from `goal`: a wrong page, an error, or lost progress compared with `previous_page`.",
  "No meaningful change toward `goal` compared with `previous_page`.",
  "`page` is closer to `goal` than `previous_page` was.",
  "`page` now shows `goal` accomplished.",
]);

/** Model-facing view of inputs: secrets are hidden, keys stay visible. */
export function inputsForModel(inputs = {}, secretKeys = []) {
  const entries = Object.entries(inputs);
  if (entries.length === 0) return "none provided";
  return Object.fromEntries(
    entries.map(([key, value]) => [key, secretKeys.includes(key) ? "[secret value: hidden from the model, available to type]" : truncate(String(value), 200)]),
  );
}

/**
 * Build the state and question set for one controller step.
 * @returns {{ state: object, questions: object, meta: object }}
 */
export function buildStepQuestions({ obs, goal, inputs = {}, secretKeys = [], previous = null, lastAction = null, historyLength = 1, stepsTaken = 0, visitedUrls = [] }) {
  const page = pageStateForModel(obs);
  const clickable = obs.elements.filter((el) => el.clickable);
  const editable = obs.elements.filter((el) => el.editable);
  const selects = obs.elements.filter((el) => el.selectable);
  const inputKeys = Object.keys(inputs);
  const urlInputKeys = inputKeys.filter((k) => !secretKeys.includes(k) && looksLikeUrl(String(inputs[k])));

  const allowedActions = ["click"];
  if (editable.length && inputKeys.length) allowedActions.push("type");
  if (selects.length) allowedActions.push("select");
  if (obs.scroll.max > 0 && !obs.scroll.atBottom) allowedActions.push("scroll_down");
  if (obs.scroll.max > 0 && !obs.scroll.atTop) allowedActions.push("scroll_up");
  if (historyLength > 1) allowedActions.push("go_back");
  if (urlInputKeys.length) allowedActions.push("navigate");
  allowedActions.push("wait", "stop");
  if (!clickable.length) allowedActions.splice(allowedActions.indexOf("click"), 1);

  const state = {
    goal,
    inputs: inputsForModel(inputs, secretKeys),
    page,
    previous_page: previous ? summarizeObservation(previous, 600) : null,
    last_action: lastAction,
    history: { steps_taken: stepsTaken, recent_urls: visitedUrls.slice(-5) },
  };

  const questions = {
    goal_done: {
      type: "noul",
      instructions: {
        question: "Is `goal` already fully accomplished according to what `page` shows right now?",
        rules: [
          "Judge only from `page` (its url, title, headings, visible_text, dialog and elements).",
          "A page that merely offers a way to accomplish `goal` does not count as accomplished.",
          "If `goal` asks to open or view something, it is accomplished when that thing is what `page` shows.",
          "If `goal` asks to perform an action (submit, add, sign in, start), it is accomplished only when `page` shows the result or confirmation of that action.",
        ],
      },
      criteria: {
        true: "`page` shows the end result that `goal` asks for.",
        false: "At least one more action is needed, `page` shows something else, or it is unclear.",
      },
    },
    blocker: {
      type: "choice",
      instructions: {
        question: "Does `page` present an obstacle that an automated browser agent cannot resolve with the listed elements and `inputs`, stopping progress toward `goal`?",
        rules: ["Pick `none` unless the obstacle is clearly visible in `page`.", "Cookie banners or dialogs that have a listed button to dismiss them are not obstacles."],
      },
      criteria: { ...BLOCKERS },
    },
    action: {
      type: "choice",
      instructions: {
        question: "Which single browser action should be performed next to make progress toward `goal` from the current `page`?",
        rules: [
          "Prefer acting on elements already listed in `page.elements` over scrolling.",
          "Use `type` only when a value in `inputs` belongs in a listed text field.",
          "Use `stop` when `goal` is already accomplished or nothing listed can help.",
          "Consider `last_action` and `history`: do not repeat an action that produced no change.",
        ],
      },
      criteria: Object.fromEntries(allowedActions.map((a) => [a, ACTION_DESCRIPTIONS[a]])),
    },
  };

  if (clickable.length) {
    questions.click_target = {
      type: "choice",
      instructions: {
        question: "If the next action is a click, which element in `page.elements` should be clicked to make progress toward `goal`?",
        rules: ["Choose `none` if no listed element helps.", "Each option id refers to `page.elements[].id`."],
      },
      criteria: { ...Object.fromEntries(clickable.map((el) => [el.id, describeElement(el)])), none: "No listed element should be clicked." },
    };
  }
  if (editable.length && inputKeys.length) {
    questions.type_target = {
      type: "choice",
      instructions: {
        question: "If the next action is typing, which text field in `page.elements` should receive a value from `inputs` to make progress toward `goal`?",
        rules: ["Prefer empty fields over fields that already contain the right value.", "Choose `none` if no listed field should be filled now."],
      },
      criteria: { ...Object.fromEntries(editable.map((el) => [el.id, describeElement(el)])), none: "No listed text field should be filled now." },
    };
    questions.type_value = {
      type: "choice",
      instructions: {
        question: "If the next action is typing, which entry of `inputs` belongs in the text field that should be filled next?",
        rules: ["Match the field's label, placeholder and type to the meaning of the input key.", "Choose `none` if no provided input belongs there."],
      },
      criteria: {
        ...Object.fromEntries(inputKeys.map((key) => [key, secretKeys.includes(key) ? `inputs.${key} (a secret value such as a password)` : `inputs.${key} = "${truncate(String(inputs[key]), 80)}"`])),
        none: "No provided input belongs in the field.",
      },
    };
    questions.submit_after_type = {
      type: "noul",
      instructions: {
        question: "After typing the value into the chosen text field, should the Enter key be pressed immediately to submit (as with a search box or a single-field form)?",
        rules: ["Answer no when other fields still need values or when a separate submit button must be clicked after all fields are filled."],
      },
      criteria: {
        true: "Pressing Enter right after typing is the natural way to submit this field (search boxes, single-field forms, the last field of a form).",
        false: "More fields must be filled first, or a separate button should be clicked, or Enter would do nothing useful.",
      },
    };
  }
  if (selects.length) {
    questions.select_target = {
      type: "choice",
      instructions: { question: "If the next action is choosing a dropdown option, which dropdown in `page.elements` should be changed to make progress toward `goal`?" },
      criteria: { ...Object.fromEntries(selects.map((el) => [el.id, describeElement(el)])), none: "No listed dropdown needs changing." },
    };
  }
  if (urlInputKeys.length > 1) {
    questions.navigate_target = {
      type: "choice",
      instructions: { question: "If the next action is loading a URL directly, which URL from `inputs` should be loaded?" },
      criteria: Object.fromEntries(urlInputKeys.map((key) => [key, `inputs.${key} = ${inputs[key]}`])),
    };
  }
  if (previous && lastAction) {
    questions.progress = {
      type: "score",
      instructions: { question: "Compared with `previous_page`, how did `last_action` change progress toward `goal`, judging by `page`?" },
      criteria: [...PROGRESS_LEVELS],
    };
  }

  return {
    state,
    questions,
    meta: {
      allowedActions,
      clickableIds: clickable.map((el) => el.id),
      editableIds: editable.map((el) => el.id),
      selectIds: selects.map((el) => el.id),
      inputKeys,
      urlInputKeys,
      questionCount: Object.keys(questions).length,
      candidateCount: clickable.length + editable.length + selects.length,
    },
  };
}

/** Second, dependent request: which option of a chosen dropdown. */
export function buildSelectOptionQuestions({ obs, element, goal, inputs = {}, secretKeys = [] }) {
  const options = (element.options ?? []).filter((o) => o.value !== "" || o.label);
  const criteria = Object.fromEntries(options.map((o, i) => [`opt${i}`, o.label ? `${o.label}${o.value && o.value !== o.label ? ` (value: ${o.value})` : ""}` : o.value]));
  criteria.none = "No option fits `goal` and `inputs`.";
  return {
    state: { goal, inputs: inputsForModel(inputs, secretKeys), page: { url: obs.url, title: obs.title, visible_text: truncate(obs.text, 1500) }, dropdown: describeElement(element) },
    questions: {
      option: {
        type: "choice",
        instructions: { question: "Which option of `dropdown` should be selected to satisfy `goal` and `inputs`?" },
        criteria,
      },
    },
    optionValues: options.map((o) => o.value),
  };
}

/** Turn normalized answers into a decision structure the controller consumes. */
export function interpretAnswers(answers, meta) {
  const rankedWithoutNone = (id) => (answers[id]?.ranked ?? []).filter(([key]) => key !== "none");
  const noneP = (id) => answers[id]?.probabilities?.none ?? 0;
  const blocker = answers.blocker;
  return {
    goalDone: answers.goal_done?.noul ?? 0,
    blocker: { top: blocker?.top ?? "none", p: blocker?.probabilities?.[blocker?.top] ?? 0, confidence: blocker?.confidence ?? null, probabilities: blocker?.probabilities ?? {} },
    actions: (answers.action?.ranked ?? []).filter(([key]) => meta.allowedActions.includes(key)),
    actionConfidence: answers.action?.confidence ?? null,
    clickTargets: rankedWithoutNone("click_target"),
    clickNone: noneP("click_target"),
    typeTargets: rankedWithoutNone("type_target"),
    typeNone: noneP("type_target"),
    typeValues: rankedWithoutNone("type_value"),
    typeValueNone: noneP("type_value"),
    submitAfterType: answers.submit_after_type?.noul ?? 0,
    selectTargets: rankedWithoutNone("select_target"),
    selectNone: noneP("select_target"),
    navigateTargets: answers.navigate_target?.ranked ?? [],
    progress: answers.progress ? { score: answers.progress.score, probabilities: answers.progress.probabilities, confidence: answers.progress.confidence } : null,
  };
}
