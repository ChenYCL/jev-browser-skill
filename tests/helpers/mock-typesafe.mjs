// A deterministic stand-in for api.typesafe.ai used when no key is available
// (or JEV_BROWSER_TEST_MODE=mock). It answers with keyword heuristics so the
// controller logic can be exercised offline and for free.
import http from "node:http";

const STOP = new Set(["the", "and", "for", "page", "open", "with", "into", "from", "link", "button", "text", "field", "your", "this", "that", "are", "you"]);
const words = (s) => (String(s ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
const overlap = (a, b) => {
  const set = new Set(words(a));
  return words(b).filter((w) => set.has(w)).length;
};

function softmax(scores, temperature = 1) {
  const keys = Object.keys(scores);
  const max = Math.max(...Object.values(scores));
  const exps = keys.map((k) => Math.exp((scores[k] - max) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0);
  return Object.fromEntries(keys.map((k, i) => [k, exps[i] / sum]));
}

function confidence(probabilities) {
  const values = Object.values(probabilities).sort((a, b) => b - a);
  const n = values.length;
  return n < 2 ? 1 : Math.max(0, Math.min(1, (n * values[0] - 1) / (n - 1)));
}

/** Heuristic answer for the browsing question set. */
export function heuristicAnswers(state, questions) {
  const goal = state?.goal ?? "";
  const page = state?.page ?? {};
  const pageText = `${page.title ?? ""} ${(page.headings ?? []).join(" ")} ${page.visible_text ?? ""}`;
  const title = String(page.title ?? "").toLowerCase();
  const elements = (page.elements ?? []).map((e) => ({ ...e, description: String(e.description).toLowerCase() }));
  const answers = {};
  const fixture = state?.__fixture_answers ?? {};
  for (const [id, q] of Object.entries(questions)) {
    if (fixture[id] !== undefined) {
      answers[id] = fixture[id];
      continue;
    }
    if (q.type === "noul") {
      if (id === "goal_done") {
        const g = goal.toLowerCase();
        const t = pageText.toLowerCase();
        const done =
          (g.includes("pricing") && /pricing/.test(title) && !/trial/.test(g)) ||
          (/trial/.test(g) && /trial has started/.test(t)) ||
          (/sign in|log in/.test(g) && /welcome,/.test(t)) ||
          (/blue widget/.test(g) && /open/.test(g) && /^blue widget/.test(title)) ||
          (/add .* cart|to your cart/.test(g) && /added .* to your cart/.test(t)) ||
          (/message|contact/.test(g) && /thanks,/.test(t)) ||
          (/secret code/.test(g) && /secret code is/.test(t));
        answers[id] = { type: "noul", noul: done ? 0.97 : 0.03 };
      } else if (id === "submit_after_type") {
        answers[id] = { type: "noul", noul: /search/.test(goal.toLowerCase()) ? 0.9 : 0.1 };
      } else answers[id] = { type: "noul", noul: 0.1 };
      continue;
    }
    if (q.type === "score") {
      const n = q.criteria.length;
      const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 2 ? 0.7 : 0.3 / (n - 1)]));
      answers[id] = { type: "score", score: Object.entries(probabilities).reduce((s, [k, p]) => s + Number(k) * p, 0), legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), typeof c === "string" ? c : JSON.stringify(c)])), probabilities, confidence: confidence(probabilities) };
      continue;
    }
    // choice
    const options = Object.keys(q.criteria);
    let scores = Object.fromEntries(options.map((o) => [o, 0]));
    const t = pageText.toLowerCase();
    if (id === "blocker") {
      scores.none = 3;
      if (/administrator access is required|no self-service sign-in/.test(t)) scores.missing_information = 6;
      if (/please sign in/.test(t) && !/password/.test(JSON.stringify(state.inputs ?? {}))) scores.login_required = 6;
      if (/page not found|does not exist/.test(t)) scores.error_page = 6;
    } else if (id === "action") {
      const inputs = state.inputs && typeof state.inputs === "object" ? state.inputs : {};
      const emptyFields = elements.filter((e) => /text field .*empty/.test(e.description));
      const fieldsWantValues = emptyFields.filter((e) => Object.keys(inputs).some((k) => overlap(k, e.description) > 0 || (/password/.test(k) && /password/.test(e.description)) || (/query|search/.test(k) && /search/.test(e.description))));
      const unsetSelect = elements.find((e) => /dropdown/.test(e.description) && /choose/i.test(e.description));
      scores.click = 2;
      if (options.includes("type") && fieldsWantValues.length) scores.type = 5;
      if (options.includes("select") && unsetSelect && /billing|sales|support|topic/.test(goal.toLowerCase()) && !fieldsWantValues.length) scores.select = 6;
      if (options.includes("scroll_down") && /secret code|advanced/.test(goal.toLowerCase()) && !/show the secret code/.test(JSON.stringify(page.elements))) scores.scroll_down = 6;
      if (options.includes("stop") && /impossible|nothing/.test(goal.toLowerCase())) scores.stop = 7;
    } else if (id === "click_target") {
      const g = goal.toLowerCase();
      const wantsTrial = /trial/.test(g);
      for (const opt of options) {
        if (opt === "none") continue;
        const desc = String(q.criteria[opt]).toLowerCase();
        scores[opt] = overlap(goal, desc) * 2;
        if (wantsTrial && /start free trial/.test(desc)) {
          // choose the trial button under the plan named in the goal, using element order
          const el = elements.find((e) => e.id === opt);
          const idx = elements.indexOf(el);
          const planIdx = elements.slice(0, idx).filter((e) => /start free trial/.test(e.description)).length;
          const names = ["starter", "team", "business"];
          if (g.includes(names[planIdx])) scores[opt] += 10;
        }
        if (/sign in/.test(g) && /button 'sign in'/.test(desc)) scores[opt] += 6;
        if (/trial|plan|pricing|price/.test(g) && /link '(see )?pricing'/.test(desc) && !/start free trial/.test(JSON.stringify(elements))) scores[opt] += 6;
        if (/cart/.test(g) && /add to cart/.test(desc)) scores[opt] += 6;
        if (/message|contact/.test(g) && /send message/.test(desc)) scores[opt] += 6;
        if (/secret code/.test(g) && /show the secret code/.test(desc)) scores[opt] += 8;
        if (/blue widget/.test(g) && /link 'blue widget'/.test(desc)) scores[opt] += 8;
        if (/blue widget/.test(g) && /search results/.test(t) && /link 'blue widget'/.test(desc)) scores[opt] += 4;
      }
      scores.none = 1;
    } else if (id === "type_target") {
      const inputs = state.inputs && typeof state.inputs === "object" ? state.inputs : {};
      for (const opt of options) {
        if (opt === "none") continue;
        const desc = String(q.criteria[opt]).toLowerCase();
        if (/current value/.test(desc)) continue;
        for (const key of Object.keys(inputs)) {
          if (overlap(key, desc) > 0) scores[opt] += 4;
          if (/password/.test(key) && /password/.test(desc)) scores[opt] += 4;
          if (/query|search/.test(key) && /search/.test(desc)) scores[opt] += 4;
          if (/email/.test(key) && /email/.test(desc)) scores[opt] += 4;
          if (/name/.test(key) && /your name/.test(desc)) scores[opt] += 4;
          if (/message/.test(key) && /message/.test(desc)) scores[opt] += 4;
        }
      }
      // Prefer the first empty field in DOM order when tied (forms fill top-down).
      let first = true;
      for (const opt of options) {
        if (opt !== "none" && scores[opt] > 0) {
          if (first) scores[opt] += 1;
          first = false;
        }
      }
      scores.none = 1;
    } else if (id === "type_value") {
      // Which input belongs in the best type_target field? Approximate with the highest-scoring field.
      const inputs = state.inputs && typeof state.inputs === "object" ? state.inputs : {};
      const emptyFields = elements.filter((e) => /text field .*empty/.test(e.description)).map((e) => e.description.toLowerCase());
      const field = emptyFields.find((d) => Object.keys(inputs).some((k) => overlap(k, d) > 0 || (/password/.test(k) && /password/.test(d)) || (/query|search/.test(k) && /search/.test(d)) || (/email/.test(k) && /email/.test(d)) || (/name/.test(k) && /your name/.test(d)) || (/message/.test(k) && /message/.test(d)))) ?? "";
      for (const opt of options) {
        if (opt === "none") continue;
        if (overlap(opt, field) > 0) scores[opt] += 4;
        if (/password/.test(opt) && /password/.test(field)) scores[opt] += 4;
        if (/query|search/.test(opt) && /search/.test(field)) scores[opt] += 4;
        if (/email/.test(opt) && /email/.test(field)) scores[opt] += 4;
        if (/name/.test(opt) && /your name/.test(field)) scores[opt] += 4;
        if (/message/.test(opt) && /message/.test(field)) scores[opt] += 4;
      }
      scores.none = 1;
    } else if (id === "select_target") {
      for (const opt of options) if (opt !== "none") scores[opt] = 3;
      scores.none = 1;
    } else if (id === "option") {
      for (const opt of options) if (opt !== "none") scores[opt] = overlap(goal, q.criteria[opt]) * 3 + overlap(JSON.stringify(state.inputs ?? {}), q.criteria[opt]);
      scores.none = 0.5;
    } else {
      for (const opt of options) scores[opt] = overlap(goal, q.criteria[opt]);
    }
    const probabilities = softmax(scores, 0.6);
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    answers[id] = { type: "choice", choice, probabilities, confidence: confidence(probabilities) };
  }
  return answers;
}

export function createMockTypeSafe({ answer = heuristicAnswers, onRequest } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: "missing bearer token" }));
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: [{ name: "jev-latest", description: "mock" }] }));
    }
    if (req.method !== "POST" || req.url !== "/v1/systemone") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: "not found" }));
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      res.writeHead(422, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: "invalid json" }));
    }
    requests.push(json);
    const hook = onRequest?.(json, requests.length);
    if (hook?.status) {
      res.writeHead(hook.status, { "content-type": "application/json", ...(hook.headers ?? {}) });
      return res.end(JSON.stringify(hook.body ?? { detail: "mock failure" }));
    }
    const inputTokens = Math.ceil(body.length / 3.6);
    let answers;
    try {
      answers = answer(json.state, json.questions);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: `mock answerer crashed: ${error.message}` }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "jev-mock-1.0", answers, usage: { input_tokens: inputTokens, output_tokens: 0 } }));
  });
  return {
    server,
    requests,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      this.baseUrl = `http://127.0.0.1:${server.address().port}`;
      return this.baseUrl;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
