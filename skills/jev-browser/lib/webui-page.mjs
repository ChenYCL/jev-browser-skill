// The page the local WebUI serves. One file, inline CSS and JS, no external assets and no CDN —
// the server has no route that could fetch one, and the page carries no configuration: everything
// it shows arrives later from /api/*, so a served page can never contain an API key.
//
// The markup is a template literal, so the embedded script uses string concatenation and
// document.createElement (never its own template literals) and renders every value with
// textContent — which is also what keeps a config value or a log line from becoming markup.
export const WEBUI_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jev-browser WebUI</title>
<style>
  :root {
    --bg: #0f1115; --panel: #161a21; --panel-2: #1c212a; --line: #2a3040;
    --fg: #e7eaf0; --muted: #98a2b3; --accent: #6b9dff; --ok: #4bbf7a; --warn: #d9a441; --bad: #e8695d;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; padding: 16px 22px 10px; }
  h1 { font-size: 18px; margin: 0; font-weight: 650; letter-spacing: .2px; }
  h2 { font-size: 14px; margin: 0 0 10px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .6px; }
  h3 { font-size: 14px; margin: 0 0 6px; }
  .tag { font: 11px/1 var(--mono); color: var(--bg); background: var(--accent); border-radius: 4px; padding: 3px 6px; vertical-align: middle; }
  .muted { color: var(--muted); }
  .mono { font-family: var(--mono); }
  nav { display: flex; gap: 4px; padding: 0 22px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  nav button { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted);
    padding: 9px 12px; font: inherit; cursor: pointer; }
  nav button:hover { color: var(--fg); }
  nav button.active { color: var(--fg); border-bottom-color: var(--accent); }
  main { padding: 18px 22px 60px; max-width: 1180px; }
  .panel { display: none; }
  .panel.active { display: block; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px 14px; }
  .grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  .grid label.wide { grid-column: 1 / -1; }
  input, select, textarea { background: var(--panel-2); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 7px 9px; font: inherit; width: 100%; }
  textarea { font-family: var(--mono); font-size: 12.5px; min-height: 132px; resize: vertical; }
  input:focus, select:focus, textarea:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
  button { background: var(--panel-2); color: var(--fg); border: 1px solid var(--line); border-radius: 6px;
    padding: 7px 12px; font: inherit; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button.primary { background: var(--accent); color: #0b0d11; border-color: var(--accent); font-weight: 600; }
  button.danger { color: var(--bad); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  .badge { font: 11px/1 var(--mono); border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px; color: var(--muted); }
  .badge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
  .badge.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .badge.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .badge.def { color: var(--bg); background: var(--accent); border-color: var(--accent); }
  pre.log { background: #0b0d11; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px;
    font: 12px/1.55 var(--mono); white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow: auto; margin: 0; }
  pre.json { background: #0b0d11; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px;
    font: 12px/1.5 var(--mono); white-space: pre-wrap; word-break: break-word; max-height: 340px; overflow: auto; margin: 0; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .4px; }
  td.num, th.num { text-align: right; font-family: var(--mono); }
  .bar { display: inline-block; height: 7px; background: var(--accent); border-radius: 4px; vertical-align: middle; }
  .bar-wrap { display: inline-block; width: 110px; background: var(--panel-2); border-radius: 4px; margin-right: 6px; }
  .kv-row { display: grid; grid-template-columns: 1fr 1.4fr auto; gap: 8px; margin-bottom: 6px; }
  .hint { font-size: 12px; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .stack > * + * { margin-top: 10px; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 14px; }
  .notes { margin: 8px 0 0; padding-left: 18px; color: var(--muted); font-size: 12.5px; }
  .notes li { margin: 2px 0; }
</style>
</head>
<body>
<header>
  <h1>jev-browser <span class="tag">WebUI</span></h1>
  <span class="badge ok" title="The server binds 127.0.0.1 only; nothing here is reachable from your network.">127.0.0.1 only</span>
  <span class="muted" id="tier-summary">loading…</span>
</header>
<nav id="tabs"></nav>
<main>
  <section class="panel" id="panel-tiers">
    <div class="card">
      <h2>What a run would use right now</h2>
      <pre class="json" id="tier-status"></pre>
      <div class="row" style="margin-top:10px">
        <button id="tier-refresh">Refresh</button>
        <span class="muted hint">Same resolution as <span class="mono">jev-browser tier status</span> — lib/tiers.mjs, not a copy.</span>
      </div>
    </div>
    <div id="tier-cards" class="cols"></div>
    <div class="card">
      <h2>Launcher output</h2>
      <p class="muted hint" style="margin-top:0">stdout / stderr of the local server this page started — the model download shows up here.</p>
      <div id="tier-logs" class="stack"></div>
    </div>
  </section>

  <section class="panel" id="panel-config">
    <div class="card">
      <h2>Edit (writes ~/.config/jev-browser/config.json)</h2>
      <form id="cfg-form" class="grid">
        <label>baseUrl <input id="cfg-baseUrl" type="text" spellcheck="false" placeholder="https://api.typesafe.ai"></label>
        <label>model <input id="cfg-model" type="text" spellcheck="false" placeholder="jev-latest"></label>
        <label>thresholds.profile <select id="cfg-profile"></select></label>
        <label>thresholds.goalDone <input id="cfg-goalDone" type="text" inputmode="decimal"></label>
        <label>thresholds.goalDoneFinal <input id="cfg-goalDoneFinal" type="text" inputmode="decimal"></label>
        <label>backend <select id="cfg-backend"></select></label>
        <label>maxSteps <input id="cfg-maxSteps" type="text" inputmode="numeric"></label>
        <label>budgetUsd <input id="cfg-budgetUsd" type="text" inputmode="decimal"></label>
        <label class="wide">API key (write-only — the value is never sent back to this page)
          <input id="cfg-apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="leave empty to keep the current key">
          <span class="hint muted" id="cfg-key-state"></span>
        </label>
        <div class="row" style="grid-column:1/-1">
          <button class="primary" type="submit">Save to user config</button>
          <button type="button" id="cfg-reload">Reload</button>
          <span class="muted hint" id="cfg-msg"></span>
        </div>
      </form>
    </div>
    <div class="card">
      <h2>Effective configuration and where each value came from</h2>
      <table id="cfg-table"></table>
      <p class="muted hint" id="cfg-paths" style="margin-bottom:0"></p>
    </div>
    <div class="card">
      <h2>Unset a key this WebUI wrote</h2>
      <div class="chips" id="cfg-unset"></div>
      <p class="muted hint" id="cfg-unset-note" style="margin-bottom:0">Only keys present in the user config file are listed; unsetting restores whatever the defaults and the environment provide.</p>
    </div>
    <div class="card" id="cfg-diff-card" style="display:none">
      <h2>Last write</h2>
      <table id="cfg-diff"></table>
    </div>
  </section>

  <section class="panel" id="panel-doctor">
    <div class="card">
      <h2>Environment</h2>
      <div class="row">
        <button class="primary" id="doctor-live">Run (live)</button>
        <button id="doctor-offline">Run (offline)</button>
        <span class="muted hint" id="doctor-msg"></span>
      </div>
    </div>
    <div class="card">
      <table id="doctor-table"></table>
      <pre class="json" id="doctor-text" style="display:none;margin-top:12px"></pre>
    </div>
  </section>

  <section class="panel" id="panel-models">
    <div class="card">
      <h2>Registry (lib/local-models.json)</h2>
      <table id="models-table"></table>
      <p class="muted hint" id="models-note" style="margin:0"></p>
    </div>
    <div class="card">
      <h2>Use a file that is already on disk</h2>
      <div class="row">
        <select id="models-file" style="max-width:520px"></select>
        <button id="models-start-file">Start jev-local with this file</button>
      </div>
      <p class="muted hint" style="margin-bottom:0" id="models-root"></p>
    </div>
    <div class="card">
      <h2>Local backend status</h2>
      <pre class="json" id="models-status">loading…</pre>
    </div>
  </section>

  <section class="panel" id="panel-judge">
    <div class="card">
      <h2>One request against the configured endpoint</h2>
      <div class="stack">
        <label class="muted hint" for="judge-state">state (JSON, or plain text)</label>
        <textarea id="judge-state" spellcheck="false"></textarea>
        <label class="muted hint" for="judge-questions">questions (JSON: noul / choice / score, as in references/questions.md)</label>
        <textarea id="judge-questions" spellcheck="false"></textarea>
        <div class="row">
          <input id="judge-model" type="text" placeholder="model id (default: the effective config)" style="max-width:320px">
          <button class="primary" id="judge-run">Run</button>
          <span class="muted hint" id="judge-msg"></span>
        </div>
      </div>
    </div>
    <div class="card">
      <h2>Answers</h2>
      <div id="judge-result"><p class="muted">Nothing yet.</p></div>
    </div>
  </section>

  <section class="panel" id="panel-run">
    <div class="card">
      <h2>Run a goal</h2>
      <div class="stack">
        <div class="grid">
          <label>goal <input id="run-goal" type="text" placeholder="Open the pricing page and start a free trial of the Team plan"></label>
          <label>start URL <input id="run-url" type="text" spellcheck="false" placeholder="https://example.com"></label>
          <label>backend <select id="run-backend">
            <option value="">from config</option><option value="ego">ego</option>
            <option value="chrome">chrome</option><option value="safari">safari</option></select></label>
          <label>max steps <input id="run-maxSteps" type="text" inputmode="numeric" placeholder="from config"></label>
          <label>budget USD <input id="run-budget" type="text" inputmode="decimal" placeholder="from config"></label>
        </div>
        <div>
          <div class="row" style="justify-content:space-between">
            <h3 style="margin:0">inputs — sent to the model as candidate values</h3>
            <button type="button" id="run-add-input">Add input</button>
          </div>
          <div id="run-inputs" style="margin-top:8px"></div>
        </div>
        <div>
          <div class="row" style="justify-content:space-between">
            <h3 style="margin:0">secrets — typed but never sent to the model, never echoed here</h3>
            <button type="button" id="run-add-secret">Add secret</button>
          </div>
          <div id="run-secrets" style="margin-top:8px"></div>
        </div>
        <div class="row">
          <button class="primary" id="run-start">Start</button>
          <button class="danger" id="run-stop" disabled>Stop</button>
          <span class="muted hint" id="run-msg"></span>
        </div>
      </div>
    </div>
    <div class="card">
      <h2>Progress (stderr of jev-browser run)</h2>
      <pre class="log" id="log-run">no run yet</pre>
    </div>
    <div class="card">
      <h2>Result</h2>
      <div id="run-result"><p class="muted">Nothing yet.</p></div>
    </div>
    <div class="card">
      <h2>Journal (per step)</h2>
      <div id="run-journal"><p class="muted">Nothing yet.</p></div>
    </div>
  </section>
</main>
<script>
(function () {
  "use strict";

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (key) {
      var value = a[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function byId(id) { return document.getElementById(id); }
  function td(value, extra) { return el("td", extra ? { class: extra } : {}, [String(value === null || value === undefined ? "—" : value)]); }
  function th(value, extra) { return el("th", extra ? { class: extra } : {}, [String(value)]); }

  async function api(method, path, body) {
    var options = { method: method, cache: "no-store" };
    if (body !== undefined) {
      options.headers = { "content-type": "application/json" };
      options.body = JSON.stringify(body);
    }
    var response = await fetch(path, options);
    var text = await response.text();
    var data;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text }; }
    if (!response.ok) throw new Error(data && data.error ? data.error : method + " " + path + " -> HTTP " + response.status);
    return data;
  }

  function note(id, message, kind) {
    var node = byId(id);
    node.className = "hint " + (kind || "muted");
    node.textContent = message || "";
  }

  // ---------------------------------------------------------------- log panes

  var LOGS = [];
  function logPane(id, channel) {
    var box = byId(id);
    box.textContent = "no output yet.";
    var pane = { box: box, channel: channel, since: 0, label: channel, fresh: true };
    LOGS.push(pane);
    return pane;
  }
  function appendLog(pane, line) {
    if (pane.fresh) { pane.box.textContent = ""; pane.fresh = false; }
    var prefix = line.stream === "stderr" ? "! " : "  ";
    pane.box.textContent += prefix + line.text + "\\n";
    if (pane.box.textContent.length > 200000) pane.box.textContent = pane.box.textContent.slice(-150000);
    pane.box.scrollTop = pane.box.scrollHeight;
  }
  async function pollLogs() {
    for (var i = 0; i < LOGS.length; i++) {
      var pane = LOGS[i];
      try {
        var data = await api("GET", "/api/logs?channel=" + encodeURIComponent(pane.channel) + "&since=" + pane.since);
        (data.lines || []).forEach(function (line) { appendLog(pane, line); });
        pane.since = data.next;
        pane.running = data.running;
      } catch (error) { /* the channel may not exist yet */ }
    }
    renderRunState();
  }
  setInterval(pollLogs, 600);

  // ---------------------------------------------------------------- tabs

  var TABS = [
    ["tiers", "Tiers"], ["config", "Config"], ["doctor", "Doctor"],
    ["models", "Models"], ["judge", "Judge"], ["run", "Run"]
  ];
  var mounted = {};
  function showTab(name) {
    TABS.forEach(function (tab) {
      byId("panel-" + tab[0]).className = "panel" + (tab[0] === name ? " active" : "");
    });
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (button) {
      button.className = button.getAttribute("data-tab") === name ? "active" : "";
    });
    if (!mounted[name]) {
      mounted[name] = true;
      if (name === "tiers") loadTiers();
      if (name === "config") loadConfig();
      if (name === "models") loadModels();
    }
  }
  var tabs = byId("tabs");
  TABS.forEach(function (tab) {
    tabs.appendChild(el("button", { type: "button", "data-tab": tab[0], text: tab[1], onclick: function () { showTab(tab[0]); } }));
  });

  // ---------------------------------------------------------------- tiers

  function tierCard(tier, local) {
    var bar = tier.bar || {};
    var children = [
      el("div", { class: "row", style: "justify-content:space-between" }, [
        el("h3", {}, [tier.tier, tier.default ? " " : "", tier.default ? el("span", { class: "badge def", text: "default" }) : null]),
        el("span", { class: "badge mono", text: tier.port ? "127.0.0.1:" + tier.port : "https" })
      ]),
      el("p", { class: "muted", style: "margin:6px 0", text: tier.what }),
      el("table", {}, [
        el("tbody", {}, [
          el("tr", {}, [th("needs"), td(tier.needs)]),
          el("tr", {}, [th("20 items"), td(tier.score)]),
          el("tr", {}, [th("goal_done"), td(String(bar.goalDone) + " / " + String(bar.goalDoneFinal))]),
          el("tr", {}, [th("start"), td(tier.start)]),
          el("tr", {}, [th("env"), td(Object.keys(tier.env).map(function (k) { return k + "=" + tier.env[k]; }).join(" "))])
        ])
      ]),
      el("ul", { class: "notes" }, (tier.notes || []).map(function (text) { return el("li", { text: text }); }))
    ];
    if (local) {
      var port = el("input", { type: "text", value: String(tier.port || ""), "aria-label": "port", style: "max-width:110px" });
      var llama = tier.tier === "local-readout" ? el("input", { type: "text", value: "8090", "aria-label": "llamaPort", style: "max-width:110px" }) : null;
      var state = el("span", { class: "badge " + (local.running ? "ok" : ""), text: local.running ? "running" : "stopped" });
      children.push(el("div", { class: "row", style: "margin-top:10px" }, [
        el("span", { class: "muted hint", text: "port" }), port,
        llama ? el("span", { class: "muted hint", text: "llama port" }) : null, llama,
        el("button", {
          class: "primary", type: "button", text: "Start",
          onclick: async function () {
            try {
              await api("POST", "/api/tiers/start", { tier: tier.tier, port: port.value, llamaPort: llama ? llama.value : undefined });
              await loadTiers();
            } catch (error) { window.alert("start failed: " + error.message); }
          }
        }),
        el("button", {
          class: "danger", type: "button", text: "Stop",
          onclick: async function () {
            try { await api("POST", "/api/tiers/stop", { tier: tier.tier }); await loadTiers(); }
            catch (error) { window.alert("stop failed: " + error.message); }
          }
        }),
        state
      ]));
    }
    var useBox = el("div", { class: "stack", style: "margin-top:10px;display:none" });
    children.push(el("div", { class: "row", style: "margin-top:10px" }, [
      el("button", {
        type: "button", text: "Use this tier",
        onclick: async function () {
          try {
            var data = await api("GET", "/api/tiers/use?tier=" + encodeURIComponent(tier.tier));
            clear(useBox);
            useBox.appendChild(el("pre", { class: "json", text: data.text }));
            useBox.appendChild(el("div", { class: "row" }, [
              el("button", {
                class: "danger", type: "button", text: "Save this tier to the user config (writes a file)",
                onclick: async function () {
                  var detail = data.baseUrl + (data.apiKey ? " and apiKey=" + data.apiKey : "");
                  if (!window.confirm("Write " + detail + " to the user config file (~/.config/jev-browser/config.json)?")) return;
                  try {
                    var out = await api("POST", "/api/tiers/use", { tier: tier.tier, port: local ? port.value : undefined });
                    useBox.appendChild(el("pre", { class: "json", text: out.text }));
                  } catch (error) { window.alert("save failed: " + error.message); }
                }
              })
            ]));
            useBox.style.display = "block";
          } catch (error) { window.alert("could not load: " + error.message); }
        }
      })
    ]));
    children.push(useBox);
    return el("div", { class: "card" }, children);
  }

  async function loadTiers() {
    var data;
    try {
      data = await api("GET", "/api/tiers");
    } catch (error) {
      byId("tier-status").textContent = "could not read the tiers: " + error.message;
      return;
    }
    byId("tier-status").textContent = data.statusText;
    byId("tier-summary").textContent = "tier: " + data.status.tier + " · baseUrl " + data.status.baseUrl +
      (data.keySet ? "" : " · no API key set");
    var cards = clear(byId("tier-cards"));
    var localByTier = {};
    (data.local || []).forEach(function (entry) { localByTier[entry.tier] = entry; });
    (data.tiers || []).forEach(function (tier) { cards.appendChild(tierCard(tier, localByTier[tier.tier])); });
  }
  byId("tier-refresh").addEventListener("click", loadTiers);

  // ---------------------------------------------------------------- config

  var CFG_EDITABLE = ["baseUrl", "model", "backend", "maxSteps", "budgetUsd", "thresholds.profile", "thresholds.goalDone", "thresholds.goalDoneFinal"];
  var lastConfig = null;

  function fillSelect(select, values, current) {
    clear(select);
    values.forEach(function (value) { select.appendChild(el("option", { value: value, text: value })); });
    if (current !== undefined && current !== null) select.value = current;
  }
  function valueAt(config, dotted) {
    return dotted.split(".").reduce(function (node, key) { return node === null || node === undefined ? node : node[key]; }, config);
  }

  async function loadConfig() {
    var data;
    try { data = await api("GET", "/api/config"); }
    catch (error) { note("cfg-msg", "could not read the config: " + error.message, "bad"); return; }
    lastConfig = data;
    fillSelect(byId("cfg-profile"), data.profiles, valueAt(data.config, "thresholds.profile"));
    fillSelect(byId("cfg-backend"), data.backends, data.config.backend);
    byId("cfg-baseUrl").value = data.config.baseUrl || "";
    byId("cfg-model").value = data.config.model || "";
    byId("cfg-goalDone").value = String(valueAt(data.config, "thresholds.goalDone"));
    byId("cfg-goalDoneFinal").value = String(valueAt(data.config, "thresholds.goalDoneFinal"));
    byId("cfg-maxSteps").value = String(data.config.maxSteps);
    byId("cfg-budgetUsd").value = String(data.config.budgetUsd);
    byId("cfg-apiKey").value = "";
    byId("cfg-key-state").textContent = data.keySet ? "a key is set (" + (data.sources.some(function (s) { return s.kind === "env" && (s.keys || []).indexOf("apiKey") >= 0; }) ? "from TYPESAFE_API_KEY" : "stored in the config file") + ")" : "no key set — set one for hosted Jev";

    var table = clear(byId("cfg-table"));
    var head = el("tr", {}, [th("key"), th("value"), th("default")]);
    table.appendChild(el("thead", {}, [head]));
    var body = el("tbody");
    var flat = data.config;
    var rows = [
      ["baseUrl", data.config.baseUrl, data.defaults.baseUrl],
      ["model", data.config.model, data.defaults.model],
      ["backend", data.config.backend, data.defaults.backend],
      ["maxSteps", data.config.maxSteps, data.defaults.maxSteps],
      ["budgetUsd", data.config.budgetUsd, data.defaults.budgetUsd],
      ["thresholds.profile", valueAt(flat, "thresholds.profile"), data.defaults.profile],
      ["thresholds.goalDone", valueAt(flat, "thresholds.goalDone"), "per profile"],
      ["thresholds.goalDoneFinal", valueAt(flat, "thresholds.goalDoneFinal"), "per profile"],
      ["apiKey", data.keySet ? "(set)" : "(unset)", null]
    ];
    rows.forEach(function (row) {
      body.appendChild(el("tr", {}, [
        td(row[0], "mono"),
        td(String(row[1])),
        td(row[2] === null || row[2] === undefined ? "—" : String(row[2]))
      ]));
    });
    table.appendChild(body);
    byId("cfg-paths").textContent = "user file " + data.paths.userFile + " · project file " + data.paths.projectFile +
      " · sources: " + (data.sources.map(function (s) { return s.kind; }).join(" < ") || "defaults");

    var unset = clear(byId("cfg-unset"));
    var keys = (data.userSetKeys || []).filter(function (key) { return CFG_EDITABLE.indexOf(key) >= 0 || key === "apiKey"; });
    if (!keys.length) unset.appendChild(el("span", { class: "muted hint", text: "nothing in the user config file right now." }));
    keys.forEach(function (key) {
      unset.appendChild(el("button", {
        class: "danger", type: "button", text: "unset " + key,
        onclick: async function () {
          try {
            var out = await api("POST", "/api/config/unset", { key: key });
            renderDiff(out.diff);
            await loadConfig();
          } catch (error) { note("cfg-msg", error.message, "bad"); }
        }
      }));
    });
  }

  function renderDiff(diff) {
    var card = byId("cfg-diff-card");
    var table = clear(byId("cfg-diff"));
    if (!diff || !diff.length) { card.style.display = "none"; return; }
    card.style.display = "block";
    table.appendChild(el("thead", {}, [el("tr", {}, [th("key"), th("before"), th("after")])]));
    table.appendChild(el("tbody", {}, diff.map(function (entry) {
      return el("tr", {}, [td(entry.path, "mono"), td(String(entry.from)), td(String(entry.to))]);
    })));
  }

  byId("cfg-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var patch = {
      baseUrl: byId("cfg-baseUrl").value,
      model: byId("cfg-model").value,
      backend: byId("cfg-backend").value,
      maxSteps: byId("cfg-maxSteps").value,
      budgetUsd: byId("cfg-budgetUsd").value,
      "thresholds.profile": byId("cfg-profile").value,
      "thresholds.goalDone": byId("cfg-goalDone").value,
      "thresholds.goalDoneFinal": byId("cfg-goalDoneFinal").value
    };
    note("cfg-msg", "saving…");
    try {
      var out = await api("POST", "/api/config", { patch: patch, apiKey: byId("cfg-apiKey").value || undefined });
      note("cfg-msg", "saved " + out.saved.join(", "), "ok");
      renderDiff(out.diff);
      await loadConfig();
    } catch (error) { note("cfg-msg", error.message, "bad"); }
  });
  byId("cfg-reload").addEventListener("click", loadConfig);

  // ---------------------------------------------------------------- doctor

  async function runDoctor(live) {
    note("doctor-msg", "running…");
    try {
      var data = await api("GET", "/api/doctor?live=" + (live ? "1" : "0"));
      note("doctor-msg", data.report.ok ? "all required checks pass" : "some checks failed", data.report.ok ? "ok" : "bad");
      var table = clear(byId("doctor-table"));
      table.appendChild(el("thead", {}, [el("tr", {}, [th(""), th("check"), th("detail"), th("hint")])]));
      table.appendChild(el("tbody", {}, data.report.checks.map(function (check) {
        var icon = check.status === "ok" ? "\\u2714" : check.status === "warn" ? "\\u2022" : "\\u2718";
        var klass = check.status === "ok" ? "ok" : check.status === "warn" ? "warn" : "bad";
        return el("tr", {}, [
          td(icon, klass),
          td(check.name, "mono"),
          td(check.detail),
          td(check.hint || "")
        ]);
      })));
      var text = byId("doctor-text");
      text.style.display = "block";
      text.textContent = data.text;
    } catch (error) { note("doctor-msg", error.message, "bad"); }
  }
  byId("doctor-live").addEventListener("click", function () { runDoctor(true); });
  byId("doctor-offline").addEventListener("click", function () { runDoctor(false); });

  // ---------------------------------------------------------------- models

  function humanBytes(bytes) {
    if (!bytes) return "0";
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GiB";
    return Math.round(bytes / 1048576) + " MiB";
  }

  async function loadModels() {
    var data;
    try { data = await api("GET", "/api/models"); }
    catch (error) { note("models-note", "could not read the registry: " + error.message, "bad"); return; }
    var table = clear(byId("models-table"));
    table.appendChild(el("thead", {}, [el("tr", {}, [th("id"), th("label"), th("size"), th("on disk"), th("")])]));
    table.appendChild(el("tbody", {}, (data.entries || []).map(function (entry) {
      var state = entry.downloaded ? el("span", { class: "badge ok", text: "downloaded" })
        : entry.partial ? el("span", { class: "badge warn", text: "partial " + humanBytes(entry.bytesOnDisk) })
        : el("span", { class: "badge", text: "not downloaded" });
      return el("tr", {}, [
        el("td", { class: "mono" }, [entry.id, entry.default ? " " : "", entry.default ? el("span", { class: "badge def", text: "default" }) : null]),
        td(entry.label),
        td(humanBytes(entry.expectedBytes), "num"),
        el("td", {}, [state]),
        el("td", {}, [el("button", {
          class: "primary", type: "button", text: "Start",
          onclick: async function () {
            try { await api("POST", "/api/models/start", { modelName: entry.id }); await loadTiers(); showTab("tiers"); }
            catch (error) { window.alert("start failed: " + error.message); }
          }
        })])
      ]);
    })));
    byId("models-note").textContent = data.registryError
      ? "registry problem: " + data.registryError
      : "Permanent default: " + (data.registry ? data.registry.default : "?") +
        ". This page never rewrites lib/local-models.json — to change the default for good, edit its \\"default\\" field; for one run use the buttons here or run: node bin/jev-local.mjs --list-models";
    var select = clear(byId("models-file"));
    if (!(data.onDisk || []).length) select.appendChild(el("option", { value: "", text: "no .gguf files on disk" }));
    (data.onDisk || []).forEach(function (file) {
      select.appendChild(el("option", { value: file.path, text: file.name + " — " + humanBytes(file.bytes) }));
    });
    byId("models-start-file").disabled = !(data.onDisk || []).length;
    byId("models-root").textContent = "Only files under " + data.root + " may be named (the same directory the launcher downloads into).";
    byId("models-status").textContent = JSON.stringify(data.status ?? { error: data.statusError }, null, 2);
  }
  byId("models-start-file").addEventListener("click", async function () {
    try { await api("POST", "/api/models/start", { modelPath: byId("models-file").value }); await loadTiers(); showTab("tiers"); }
    catch (error) { window.alert("start failed: " + error.message); }
  });

  // ---------------------------------------------------------------- judge

  var EXAMPLE_STATE = JSON.stringify({
    goal: "Start a free trial of the Team plan",
    page: {
      url: "https://example.com/pricing",
      title: "Pricing",
      headings: ["# Pricing", "## Starter", "## Team"],
      visible_text: "Starter $0 per month. Team $29 per month. Business $99 per month."
    }
  }, null, 2);
  var EXAMPLE_QUESTIONS = JSON.stringify({
    goal_done: { type: "noul", instructions: "Does \\u0060page\\u0060 show the goal \\u0060goal\\u0060 accomplished?" },
    action: {
      type: "choice",
      instructions: "Which action should be taken next?",
      criteria: { click: "Click an element on the page", stop: "The goal is already done" }
    }
  }, null, 2);
  byId("judge-state").value = EXAMPLE_STATE;
  byId("judge-questions").value = EXAMPLE_QUESTIONS;

  function answerBlock(id, answer) {
    var children = [el("h3", { class: "mono", text: id })];
    children.push(el("p", { class: "muted hint", style: "margin:2px 0 8px", text: "type " + answer.type +
      (answer.choice ? " · choice " + answer.choice : "") +
      (answer.score !== undefined && answer.score !== null ? " · score " + answer.score : "") +
      (answer.confidence !== null && answer.confidence !== undefined ? " · confidence " + Number(answer.confidence).toFixed(3) : "") }));
    var rows = (answer.ranked || Object.keys(answer.probabilities || {}).map(function (key) { return [key, answer.probabilities[key]]; }));
    var table = el("table", {}, [
      el("thead", {}, [el("tr", {}, [th("option"), th("probability", "num"), th("", "num")])]),
      el("tbody", {}, rows.map(function (pair) {
        var probability = Number(pair[1]);
        var wrap = el("div", { class: "bar-wrap" }, [el("span", { class: "bar", style: "width:" + Math.round(probability * 100) + "%" })]);
        return el("tr", {}, [td(pair[0], "mono"), td(probability.toFixed(4), "num"), el("td", { class: "num" }, [wrap])]);
      }))
    ]);
    children.push(table);
    return el("div", { class: "card", style: "margin-bottom:12px" }, children);
  }

  byId("judge-run").addEventListener("click", async function () {
    note("judge-msg", "asking…");
    try {
      var data = await api("POST", "/api/judge", {
        state: byId("judge-state").value,
        questions: byId("judge-questions").value,
        model: byId("judge-model").value || undefined
      });
      note("judge-msg", data.model + " · " + data.ms + " ms · $" + Number(data.costUsd || 0).toFixed(6) + (data.cacheHit ? " (cached)" : ""), "ok");
      var out = clear(byId("judge-result"));
      Object.keys(data.answers).forEach(function (id) { out.appendChild(answerBlock(id, data.answers[id])); });
      out.appendChild(el("pre", { class: "json", text: JSON.stringify({ model: data.model, usage: data.usage, baseUrl: data.baseUrl }, null, 2) }));
    } catch (error) { note("judge-msg", error.message, "bad"); }
  });

  // ---------------------------------------------------------------- run

  function kvRow(container, key, value) {
    var keyInput = el("input", { type: "text", placeholder: "name", value: key || "", spellcheck: "false" });
    var valueInput = el("input", { type: value === null ? "password" : "text", placeholder: value === null ? "value (never echoed)" : "value", value: value || "" });
    var row = el("div", { class: "kv-row" }, [
      keyInput, valueInput,
      el("button", { type: "button", text: "remove", onclick: function () { container.removeChild(row); } })
    ]);
    container.appendChild(row);
  }
  function readRows(container) {
    var rows = [];
    Array.prototype.forEach.call(container.querySelectorAll(".kv-row"), function (row) {
      var inputs = row.querySelectorAll("input");
      rows.push({ key: inputs[0].value, value: inputs[1].value });
    });
    return rows;
  }
  byId("run-add-input").addEventListener("click", function () { kvRow(byId("run-inputs"), "", ""); });
  byId("run-add-secret").addEventListener("click", function () { kvRow(byId("run-secrets"), "", null); });
  kvRow(byId("run-inputs"), "", "");

  var runTimer = null;
  async function renderRunState() {
    if (!runTimer) return;
    var data;
    try { data = await api("GET", "/api/run"); } catch (error) { return; }
    byId("run-stop").disabled = !data.running;
    if (data.running) note("run-msg", "running…");
    if (data.ready && data.result) {
      clearInterval(runTimer);
      runTimer = null;
      note("run-msg", data.result.status + " · " + data.result.steps + " steps" +
        (data.result.usage ? " · $" + Number(data.result.usage.costUsd || 0).toFixed(6) : ""), data.result.status === "success" ? "ok" : "warn");
      var out = clear(byId("run-result"));
      out.appendChild(el("table", {}, [
        el("tbody", {}, [
          el("tr", {}, [th("status"), td(String(data.result.status) + (data.result.reason ? " — " + data.result.reason : ""))]),
          el("tr", {}, [th("steps"), td(String(data.result.steps))]),
          el("tr", {}, [th("final"), td(String(data.result.finalTitle || "") + " <" + String(data.result.finalUrl || "") + ">")]),
          el("tr", {}, [th("goal_done"), td(String(data.result.goalDoneProbability))]),
          el("tr", {}, [th("usage"), td(JSON.stringify(data.result.usage || {}))]),
          el("tr", {}, [th("journal"), td(data.journal && data.journal.dir ? data.journal.dir : String(data.result.journalDir || "—"))])
        ])
      ]));
      var journal = clear(byId("run-journal"));
      var rows = data.journal && data.journal.rows ? data.journal.rows : [];
      if (!rows.length) journal.appendChild(el("p", { class: "muted", text: data.journal && data.journal.error ? data.journal.error : "no steps were journaled." }));
      else {
        journal.appendChild(el("table", {}, [
          el("thead", {}, [el("tr", {}, [th("step", "num"), th("goal_done", "num"), th("blocker"), th("action"), th("chosen"), th("changed")])]),
          el("tbody", {}, rows.map(function (row) {
            return el("tr", {}, [
              td(row.step, "num"),
              td(row.goalDone === null || row.goalDone === undefined ? "—" : Number(row.goalDone).toFixed(3), "num"),
              td(row.blocker || "—"),
              td(row.finalCheck ? "final check" : (row.action || "—")),
              td(row.label || "—"),
              td(row.changed === null || row.changed === undefined ? "—" : String(row.changed))
            ]);
          }))
        ]));
      }
    } else if (data.ready && !data.result) {
      clearInterval(runTimer);
      runTimer = null;
      note("run-msg", data.resultError || data.error || ("exit code " + data.exitCode), "bad");
    }
  }

  byId("run-start").addEventListener("click", async function () {
    note("run-msg", "starting…");
    var log = byId("log-run");
    log.textContent = "";
    try {
      var out = await api("POST", "/api/run", {
        goal: byId("run-goal").value,
        url: byId("run-url").value,
        backend: byId("run-backend").value || undefined,
        maxSteps: byId("run-maxSteps").value || undefined,
        budgetUsd: byId("run-budget").value || undefined,
        inputs: readRows(byId("run-inputs")),
        secrets: readRows(byId("run-secrets"))
      });
      log.textContent = "$ " + out.command + "\\n";
      note("run-msg", "run " + out.runId);
      if (runTimer) clearInterval(runTimer);
      runTimer = setInterval(renderRunState, 700);
    } catch (error) { note("run-msg", error.message, "bad"); }
  });
  byId("run-stop").addEventListener("click", async function () {
    try { await api("POST", "/api/run/stop", {}); note("run-msg", "stopping…", "warn"); }
    catch (error) { note("run-msg", error.message, "bad"); }
  });

  // ---------------------------------------------------------------- boot

  logPane("log-run", "run");
  var tierLogs = clear(byId("tier-logs"));
  ["local-readout", "kev"].forEach(function (name) {
    var box = el("pre", { class: "log", text: "no output yet — start the " + name + " launcher above" });
    box.id = "log-tier-" + name;
    tierLogs.appendChild(el("div", {}, [el("h3", { class: "mono", text: "tier:" + name }), box]));
    logPane(box.id, "tier:" + name);
  });

  showTab("tiers");
  loadConfig();
  loadModels();
})();
</script>
</body>
</html>
`;
