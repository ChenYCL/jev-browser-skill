import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGoal, chooseAction, STATUS } from "../../skills/jev-browser/lib/controller.mjs";
import { TypeSafeClient } from "../../skills/jev-browser/lib/typesafe.mjs";
import { DEFAULTS } from "../../skills/jev-browser/lib/config.mjs";
import { sampleObs } from "../helpers/sample.mjs";

/** In-memory driver: a tiny site graph the controller can walk. */
class FakeDriver {
  name = "fake";
  constructor(pages, start) {
    this.pages = pages;
    this.current = start;
    this.log = [];
    this.history = [start];
    this.finished = null;
  }
  async start() {}
  async observe() {
    return structuredClone(this.pages[this.current]);
  }
  async click(id) {
    const el = this.pages[this.current].elements.find((e) => e.id === id);
    if (!el) throw new Error("gone");
    this.log.push(`click ${id}`);
    if (el.to) {
      this.current = el.to;
      this.history.push(el.to);
    }
  }
  async type(id, text, { submit }) {
    this.log.push(`type ${id}=${text}${submit ? "+enter" : ""}`);
    const page = this.pages[this.current];
    const el = page.elements.find((e) => e.id === id);
    el.value = text;
    if (submit && el.to) {
      this.current = el.to;
      this.history.push(el.to);
    }
  }
  async select(id, value) {
    this.log.push(`select ${id}=${value}`);
    this.pages[this.current].elements.find((e) => e.id === id).value = value;
  }
  async scroll(dir) {
    this.log.push(`scroll ${dir}`);
  }
  async back() {
    this.history.pop();
    this.current = this.history.at(-1);
    this.log.push("back");
  }
  async navigate(url) {
    this.log.push(`navigate ${url}`);
  }
  async wait() {
    this.log.push("wait");
  }
  async settle() {}
  async screenshot(file) {
    return file;
  }
  async historyLength() {
    return this.history.length;
  }
  async handOff() {
    this.log.push("handoff");
    return { spaceId: 1 };
  }
  async finish(opts) {
    this.finished = opts;
  }
  describe() {
    return { backend: "fake" };
  }
}

function scriptedClient(script) {
  // script: (state, questions, n) => answers (raw API shape)
  let n = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    n += 1;
    const answers = script(body.state, body.questions, n);
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1000, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return new TypeSafeClient({ apiKey: "k", baseUrl: "http://mock", fetchImpl, cache: false });
}

const choice = (probabilities) => ({ type: "choice", choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0], probabilities, confidence: 0.9 });
const noul = (p) => ({ type: "noul", noul: p });
const baseAnswers = (questions, patch) => {
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") answers[id] = noul(0.05);
    else if (q.type === "score") answers[id] = { type: "score", score: 2, probabilities: { 0: 0.05, 1: 0.1, 2: 0.8, 3: 0.05 }, legend: {}, confidence: 0.8 };
    else {
      const keys = Object.keys(q.criteria);
      const probabilities = Object.fromEntries(keys.map((k) => [k, 1 / keys.length]));
      answers[id] = choice(probabilities);
    }
  }
  return { ...answers, ...patch(questions) };
};

async function tempConfig(overrides = {}) {
  const journalDir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-journal-"));
  return { ...structuredClone(DEFAULTS), journalDir, keepJournal: true, settleMs: 0, ...overrides };
}

test("controller clicks toward the goal, verifies success, writes a journal", async () => {
  const pages = {
    home: sampleObs({ url: "http://x/", title: "Home", text: "Welcome", elements: [{ id: "e1", role: "link", name: "Pricing", href: "/pricing", clickable: true, inViewport: true, to: "pricing" }] }),
    pricing: sampleObs({ url: "http://x/pricing", title: "Pricing", text: "Plans", elements: [] , scroll: { y: 0, max: 0, atTop: true, atBottom: true } }),
  };
  const driver = new FakeDriver(pages, "home");
  const client = scriptedClient((state, questions) =>
    baseAnswers(questions, (q) => ({
      goal_done: noul(state.page.title === "Pricing" ? 0.95 : 0.02),
      blocker: choice({ none: 0.95, error_page: 0.05 }),
      ...(q.action ? { action: choice(Object.fromEntries(Object.keys(q.action.criteria).map((k) => [k, k === "click" ? 0.8 : 0.2 / (Object.keys(q.action.criteria).length - 1)]))) } : {}),
      ...(q.click_target ? { click_target: choice({ e1: 0.9, none: 0.1 }) } : {}),
    })),
  );
  const config = await tempConfig();
  const result = await runGoal({ driver, client, config, goal: "Open the pricing page", startUrl: "http://x/" });
  assert.equal(result.status, STATUS.success);
  assert.deepEqual(driver.log, ["click e1"]);
  assert.equal(result.steps, 2);
  assert.equal(driver.finished.success, true);
  const steps = (await fs.readFile(path.join(result.journalDir, "steps.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(steps.length, 2);
  assert.equal(steps[1].outcome, "success");
  const run = JSON.parse(await fs.readFile(path.join(result.journalDir, "run.json"), "utf8"));
  assert.equal(run.status, "success");
});

test("controller types a secret without sending it to the model, then submits", async () => {
  const pages = {
    login: sampleObs({ url: "http://x/login", title: "Sign in", text: "Sign in", scroll: { y: 0, max: 0, atTop: true, atBottom: true }, elements: [
      { id: "e1", role: "textbox", name: "Email", inputType: "email", value: "", editable: true, clickable: false, inViewport: true },
      { id: "e2", role: "textbox", name: "Password", inputType: "password", value: "", editable: true, clickable: false, inViewport: true, to: "dash" },
      { id: "e3", role: "button", name: "Sign in", clickable: true, inViewport: true, to: "dash" },
    ] }),
    dash: sampleObs({ url: "http://x/dash", title: "Dashboard", text: "Welcome, a@b.c", elements: [], scroll: { y: 0, max: 0, atTop: true, atBottom: true } }),
  };
  const driver = new FakeDriver(pages, "login");
  const seenStates = [];
  const client = scriptedClient((state, questions) => {
    seenStates.push(JSON.stringify(state));
    const email = state.page.elements.find((e) => e.id === "e1");
    const emailFilled = email && /current value/.test(email.description);
    return baseAnswers(questions, (q) => ({
      goal_done: noul(state.page.title === "Dashboard" ? 0.99 : 0.01),
      blocker: choice({ none: 0.97, login_required: 0.03 }),
      ...(q.action ? { action: choice(Object.fromEntries(Object.keys(q.action.criteria).map((k) => [k, k === "type" ? 0.7 : k === "click" ? 0.2 : 0.1 / (Object.keys(q.action.criteria).length - 2)]))) } : {}),
      ...(q.type_target ? { type_target: choice(emailFilled ? { e2: 0.9, e1: 0.05, none: 0.05 } : { e1: 0.9, e2: 0.05, none: 0.05 }) } : {}),
      ...(q.type_value ? { type_value: choice(emailFilled ? { password: 0.9, email: 0.05, none: 0.05 } : { email: 0.9, password: 0.05, none: 0.05 }) } : {}),
      ...(q.submit_after_type ? { submit_after_type: noul(emailFilled ? 0.9 : 0.1) } : {}),
      ...(q.click_target ? { click_target: choice({ e3: 0.9, none: 0.1 }) } : {}),
    }));
  });
  const config = await tempConfig();
  const result = await runGoal({ driver, client, config, goal: "Sign in", startUrl: "http://x/login", inputs: { email: "a@b.c" }, secrets: { password: "hunter2" } });
  assert.equal(result.status, STATUS.success);
  assert.deepEqual(driver.log, ["type e1=a@b.c", "type e2=hunter2+enter"]);
  assert.equal(seenStates.some((s) => s.includes("hunter2")), false, "secret never reaches the model");
  const journal = await fs.readFile(path.join(result.journalDir, "steps.jsonl"), "utf8");
  assert.equal(journal.includes("hunter2"), false, "secret never reaches the journal");
});

test("controller hands off on a confident blocker", async () => {
  const pages = { admin: sampleObs({ url: "http://x/admin", title: "Restricted", text: "Administrator access required", elements: [], scroll: { y: 0, max: 0, atTop: true, atBottom: true } }) };
  const driver = new FakeDriver(pages, "admin");
  const client = scriptedClient((_state, questions) => baseAnswers(questions, () => ({ goal_done: noul(0.01), blocker: choice({ missing_information: 0.85, none: 0.15 }) })));
  const config = await tempConfig();
  const result = await runGoal({ driver, client, config, goal: "View admin reports", startUrl: "http://x/admin" });
  assert.equal(result.status, STATUS.needs_user);
  assert.equal(result.blocker, "missing_information");
  assert.deepEqual(driver.log, ["handoff"]);
  assert.equal(driver.finished, null, "finish is not called after a hand-off");
});

test("controller marks no-effect actions as blocked and tries the next candidate", async () => {
  const pages = {
    home: sampleObs({ url: "http://x/", title: "Home", text: "Welcome", scroll: { y: 0, max: 0, atTop: true, atBottom: true }, elements: [
      { id: "e1", role: "button", name: "Broken", clickable: true, inViewport: true },
      { id: "e2", role: "link", name: "Pricing", href: "/pricing", clickable: true, inViewport: true, to: "pricing" },
    ] }),
    pricing: sampleObs({ url: "http://x/pricing", title: "Pricing", text: "Plans", elements: [], scroll: { y: 0, max: 0, atTop: true, atBottom: true } }),
  };
  const driver = new FakeDriver(pages, "home");
  const client = scriptedClient((state, questions) =>
    baseAnswers(questions, (q) => ({
      goal_done: noul(state.page.title === "Pricing" ? 0.95 : 0.02),
      blocker: choice({ none: 0.95, error_page: 0.05 }),
      ...(q.action ? { action: choice(Object.fromEntries(Object.keys(q.action.criteria).map((k) => [k, k === "click" ? 0.8 : 0.2 / (Object.keys(q.action.criteria).length - 1)]))) } : {}),
      ...(q.click_target ? { click_target: choice({ e1: 0.6, e2: 0.35, none: 0.05 }) } : {}),
    })),
  );
  const config = await tempConfig();
  const result = await runGoal({ driver, client, config, goal: "Open the pricing page", startUrl: "http://x/" });
  assert.equal(result.status, STATUS.success);
  assert.deepEqual(driver.log, ["click e1", "click e2"]);
});

test("controller stops on budget, max steps, and repeated no-change", async () => {
  const dead = sampleObs({ url: "http://x/", title: "Dead", text: "nothing", scroll: { y: 0, max: 0, atTop: true, atBottom: true }, elements: [{ id: "e1", role: "button", name: "Nope", clickable: true, inViewport: true }] });
  const script = (_state, questions) =>
    baseAnswers(questions, (q) => ({
      goal_done: noul(0.01),
      blocker: choice({ none: 0.9, error_page: 0.1 }),
      ...(q.action ? { action: choice(Object.fromEntries(Object.keys(q.action.criteria).map((k) => [k, k === "click" ? 0.9 : 0.1 / (Object.keys(q.action.criteria).length - 1)]))) } : {}),
      ...(q.click_target ? { click_target: choice({ e1: 0.95, none: 0.05 }) } : {}),
    }));

  let driver = new FakeDriver({ dead: structuredClone(dead) }, "dead");
  let result = await runGoal({ driver, client: scriptedClient(script), config: await tempConfig({ thresholds: { ...DEFAULTS.thresholds, noChangeLimit: 2 } }), goal: "impossible", startUrl: "http://x/" });
  assert.equal(result.status, STATUS.stuck);

  driver = new FakeDriver({ dead: structuredClone(dead) }, "dead");
  result = await runGoal({ driver, client: scriptedClient(script), config: await tempConfig({ budgetUsd: 0.00001 }), goal: "impossible", startUrl: "http://x/" });
  assert.equal(result.status, STATUS.budget_exhausted);

  // wait is harmless but never changes the page → blocked → next candidate → eventually stuck; with maxSteps=1 we hit max_steps first
  driver = new FakeDriver({ dead: structuredClone(dead) }, "dead");
  result = await runGoal({ driver, client: scriptedClient(script), config: await tempConfig({ maxSteps: 1 }), goal: "impossible", startUrl: "http://x/" });
  assert.equal(result.status, STATUS.max_steps);
  assert.equal(result.goalDoneProbability, 0.01);
});

test("chooseAction respects none preferences and blocked memory", () => {
  const obs = sampleObs();
  const meta = { allowedActions: ["click", "type", "scroll_down", "stop"], urlInputKeys: [] };
  const decision = {
    actions: [["click", 0.5], ["scroll_down", 0.3], ["stop", 0.2]],
    clickTargets: [["e1", 0.3], ["e3", 0.2]],
    clickNone: 0.5, // none beats every element → click not viable
    typeTargets: [], typeValues: [], selectTargets: [], navigateTargets: [], progress: null,
  };
  const chosen = chooseAction({ decision, obs, meta, blocked: new Set(), hash: "h", allInputs: {}, thr: DEFAULTS.thresholds });
  assert.equal(chosen.kind, "scroll_down");
  const blockedScroll = chooseAction({ decision, obs, meta, blocked: new Set(["h|scroll_down"]), hash: "h", allInputs: {}, thr: DEFAULTS.thresholds });
  assert.equal(blockedScroll.kind, "stop");
  const regress = chooseAction({ decision: { ...decision, progress: { probabilities: { 0: 0.8 } } }, obs, meta: { ...meta, allowedActions: [...meta.allowedActions, "go_back"] }, blocked: new Set(), hash: "h", allInputs: {}, thr: DEFAULTS.thresholds });
  assert.equal(regress.kind, "go_back");
});

test("controller defers a stop at 70–85% goal probability to one more untried action", async () => {
  const pages = {
    reissue: sampleObs({ url: "http://x/3310-2017", title: "Nokia 3310 (2017)", text: "reissue", scroll: { y: 0, max: 0, atTop: true, atBottom: true }, elements: [
      { id: "e1", role: "link", name: "Nokia 3310", href: "/3310", clickable: true, inViewport: true, to: "original" },
    ] }),
    original: sampleObs({ url: "http://x/3310", title: "Nokia 3310", text: "the original", elements: [], scroll: { y: 0, max: 0, atTop: true, atBottom: true } }),
  };
  const driver = new FakeDriver(pages, "reissue");
  const client = scriptedClient((state, questions) =>
    baseAnswers(questions, (q) => ({
      goal_done: noul(state.page.title === "Nokia 3310" ? 0.95 : 0.75),
      blocker: choice({ none: 0.98, error_page: 0.02 }),
      ...(q.action ? { action: choice(Object.fromEntries(Object.keys(q.action.criteria).map((k) => [k, k === "stop" ? 0.7 : k === "click" ? 0.25 : 0.05 / (Object.keys(q.action.criteria).length - 2)]))) } : {}),
      ...(q.click_target ? { click_target: choice({ e1: 0.8, none: 0.2 }) } : {}),
    })),
  );
  const result = await runGoal({ driver, client, config: await tempConfig(), goal: "Open the Nokia 3310 article", startUrl: "http://x/3310-2017" });
  assert.equal(result.status, STATUS.success);
  assert.deepEqual(driver.log, ["click e1"], "the stop was deferred and the untried link was followed");
  assert.equal(result.finalUrl, "http://x/3310");
});
