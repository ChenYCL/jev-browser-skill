---
name: jev-browser
license: MIT
description: >
  Browser use / computer use where TypeSafe's Jev (System One model) supplies
  calibrated judgments and code owns the control loop, in the style of NanoJev's
  "atomic judgments + code planning". Use when an agent must accomplish a goal in
  a real browser (open pages, search, sign in, fill forms, add to cart, start a
  trial, reveal content) without a vision model: it drives ego lite by default
  (reusing the user's logged-in Chrome sessions), or Chrome via DevTools protocol,
  or Safari via safaridriver. Also use for any raw Jev judgment (noul / choice /
  score) from the CLI or MCP. Triggers: "browse", "open the site and …", "use the
  browser to …", "jev browser", "computer use", "自动操作浏览器", "用浏览器完成".
metadata:
  version: "0.1.2"
  requires: "Node 22+, TYPESAFE_API_KEY, ego lite (default) or Chrome or Safari"
---

# jev-browser

`jev-browser` accomplishes a natural-language goal in a real browser. Every step
it observes the page, asks **Jev** a handful of small typed questions in one
request (is the goal done? is something blocking? what kind of action? which
element? which provided value?), and **code** executes the chosen action, keeps
memory, enforces budgets and decides when to stop. Jev never generates text:
values to type come from `inputs`, and Jev only selects among them.

The skill directory is self-contained: `bin/jev-browser.mjs` (CLI + MCP server),
`lib/` (controller, questions, TypeSafe client, backends). No npm install is needed.

## Before the first run

```bash
export TYPESAFE_API_KEY=...            # already set on this machine
node <skill-dir>/bin/jev-browser.mjs doctor
```

`doctor` verifies the key against the live API, and reports ego lite, Chrome and
Safari availability plus which agents the skill is installed into. If the skill
was installed with `install`, the `jev-browser` symlink exists in
`~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills` and `~/.cursor/skills`;
call it as `node ~/.claude/skills/jev-browser/bin/jev-browser.mjs …` (or add the
`bin` directory to `PATH`). Below, `jev-browser` stands for that command.

## Run a goal

```bash
jev-browser run --goal "Open the pricing page and start a free trial of the Team plan" \
  --url https://example.com --json
jev-browser run --goal 'Search the catalog for "blue widget" and open its product page' \
  --url https://shop.example.com --input query="blue widget"
jev-browser run --goal "Sign in and reach the dashboard" --url https://app.example.com/login \
  --input email=ada@example.com --secret password=hunter2
```

Rules for good goals and inputs:

- Write the goal in **English** and describe the **end state** ("the trial
  confirmation page is shown"), not a click sequence. Jev reads literally, so
  name the page, item or plan exactly as the site does. Chinese works but with
  lower accuracy; translate the user's goal before calling.
- Anything that must be typed goes in `--input key=value`. Quoted strings inside
  the goal are added as inputs automatically. Use `--secret` for passwords and
  tokens: they are typed but never sent to the model or written to the journal.
- Default backend is **ego lite** (`--backend ego`), which reuses the user's
  signed-in sessions and leaves the result page open on success. Use
  `--backend chrome` for a dedicated Chrome (own profile dir; `--headless` for
  no window; `--cdp-url` to attach to a Chrome started with
  `--remote-debugging-port`). Use `--backend safari` after enabling
  Develop → Allow Remote Automation.
- Budgets: `--max-steps` (25), `--budget-usd` (0.25), `--max-ms` (300000). A
  step costs roughly $0.0002 at a few thousand input tokens.

Other `run` flags: `--keep` / `--no-keep` (leave the final page open; default keep on
success), `--space-id` + `--page-label` (ego: resume), `--screenshot <file>`, `--step-screenshots <dir>`
(one PNG per step, the page as Jev saw it), `--journal-dir <dir>`,
`--no-journal`, `--model <id>`, `-q/--quiet` (no progress on stderr). `judge` accepts
`--state-file` / `--questions-file`; `pick` accepts `--context <json|text>` and `--no-none`;
`doctor --offline` skips the live API probe; `install --copy` copies instead of symlinking
(Windows) and `--home <dir>` targets another home directory.

What leaves the machine: the goal, non-secret inputs, and a compact page view (URL, title,
headings, ≤3000 chars of visible text, element descriptions incl. current values, previous-page
excerpt, last action) go to `api.typesafe.ai` once per step. No screenshots, cookies or HTML;
secrets never. Journals stay local with secrets redacted.

The JSON result carries `status`, `steps`, `finalUrl`, `finalTitle`,
`finalTextExcerpt`, `usage.costUsd`, `journalDir`, and `resume` info:

| status | meaning | what to do |
| --- | --- | --- |
| `success` | `goal_done` probability ≥ threshold (0.85), or ≥ 0.7 on the final check | report the final page to the user |
| `needs_user` | a blocker (login without credentials, CAPTCHA, consent, error, missing info) was judged likely; on ego the browser was handed to the user | tell the user what to do in the browser, then re-run with `--space-id <id>` (ego) to continue |
| `stuck` | repeated no-effect actions, a loop, or Jev judged that nothing listed helps | inspect the journal; refine the goal or add inputs |
| `max_steps` / `budget_exhausted` / `timeout` | limits hit | raise the limit or split the goal |
| `error` | backend or API failure | see `error`; run `doctor` |

Exit codes: 0 success, 3 needs_user, 2 other non-success, 1 usage error.

## Look before acting

```bash
jev-browser observe --url https://example.com --json          # the page as Jev sees it
jev-browser run --dry-run --goal "…" --url https://example.com  # first-step state + questions, no API call
```

`observe` prints url, title, headings, visible text and the interactive
elements with the ids Jev chooses among. Use it to check that the target
element is listed before spending steps; raise `observation.maxCandidates`
(default 100, API max 255) for very dense pages.

## Raw Jev judgments (not browser-specific)

```bash
jev-browser judge --state '{"ticket":"My card was charged twice"}' \
  --questions '{"refund":{"type":"noul","instructions":"Does `ticket` ask for a refund?"}}'
jev-browser pick --question "Which link opens the plans page?" \
  --candidate pricing="link 'Pricing'" --candidate docs="link 'Docs'"
```

Follow the TypeSafe skill for designing questions: one narrow judgment per
question, named state fields referenced in backticks, a `none` option when no
candidate may fit, thresholds evaluated on real data.

## Fully local (experimental)

There are **two local tiers**, and they are not the same trade. The GGUF readout is the default; Kev
is the accuracy tier.

| | **GGUF readout — default** (`jev-local`) | **Kev — accuracy tier** (`jev-kev`) |
| --- | --- | --- |
| how it answers | first-token logprob readout on llama.cpp | trained pointer-head checkpoint on its own MLX runtime |
| needs | Homebrew `llama.cpp`; **no Python** | a Python venv + MLX |
| disk | 2.6 GiB (registry default) | 9.34 GB base + 152 MiB adapter |
| memory | a few GiB | ~18 GB idle, **36 GB GPU footprint** under load at the raised limit — heavy swap on a 48 GB machine |
| 20 graded items | **0.80** (the 0.8B entry 0.50) | **0.95** patched / **0.90** published |
| latency | p50 **≈4.3 s per step** (5 questions, one page state) | mean **2.2 s per item**, 12.2 s worst item, **23.8 s** for the packed 5-question step on a 12k-token state |
| vs hosted Jev (0.95) | below it | **ties it**, and beats it on `click_target` (2/2 vs 1/2) |
| known hole | `goal_done`, `action` ordering, lists past ~50 candidates | refuses the 55-option `click_target` questions unless the optional row-limit patch is applied |

Pick the GGUF tier unless the number is the point: it is one command, needs no Python, and 0.80 is
enough for short states. Pick Kev when you need the accuracy — it is the only local backend that
matches hosted Jev on this set — and accept a Python venv, a 9.34 GB base and tens of GB of GPU
memory for it.

One command serves the same `/v1/systemone` contract from a local llama.cpp server — no API
key, no network, no cost. The answer is read out of the model's first generated token (options
are labelled A, B, C …), so nothing is generated and nothing is parsed:

```bash
node <skill-dir>/bin/jev-local.mjs
# downloads the registry default (Qwen3.5-4B Q4_K_M, 2.6 GiB) once, starts llama-server with
# -c 16384 on :8090, then prints:
# TYPESAFE_BASE_URL=http://127.0.0.1:8092 TYPESAFE_API_KEY=local

export TYPESAFE_BASE_URL=http://127.0.0.1:8092 TYPESAFE_API_KEY=local
jev-browser judge --state-file state.json --questions-file questions.json --json   # $0
```

Which model is served is data, not code: `lib/local-models.json` lists each entry with its GGUF
filename, download URL, exact byte size and label, and its `"default"` picks the one the launcher
uses. Switching models is an edit to that JSON — or one flag for a single run:

- `jev-local --list-models` — every entry with id, label, size and the default marker (exit 0).
- `jev-local --model-name <id>` — serve that registry entry instead of the default.
- `jev-local --model <path.gguf>` — serve a file you already have; add `--model-url <url>` to download it to that path.
- `jev-local --ctx <tokens>` — llama.cpp context, default **16384**, because a 100-candidate `click_target` step renders to ~11.7k prompt tokens and an 8192 context cannot serve a real step; `--port` / `--llama-port` move the two servers, `--download-only` only fetches the file.

Default is the 4B (`qwen3.5-4b-q4-k-m`): a 2.6 GiB download, and a step in a real `run` takes
**p50 ≈4.3 s** on an M3 Max (measured max 18.2 s, against the default 20 s client timeout). The
"~9 s warm / ~18 s cold" step figures in `experiments/gguf-provider/RESULTS.md` are per-question
cold measurements: within a step the provider asks its questions in order, so the page state is
paid once (≈1.2 s) and llama.cpp prefix caching brings every later question down to 0.5–0.7 s.
`--model-name qwen3.5-0.8b-q8` (774 MiB) is ~3× faster per step and much weaker (~0.50 accuracy,
see limits below); pick it for short, few-option judgments on a small disk.

Apple Silicon (Metal via Homebrew `llama.cpp`) — $0 and no data leaving the machine. A llama.cpp already
serving the selected file on the llama port is reused and left running when the launcher exits
(only a server it started itself is stopped with it); one serving a *different* file is refused
rather than silently answered from. A second invocation while one is running prints the same line
and exits 0, and `doctor` reports the active registry id in its `local model` line.

### Kev: the accuracy tier

```bash
node <skill-dir>/bin/jev-kev.mjs
# verifies the checkpoint and its 9.34 GB base in the HF cache (fetching what is missing, resuming
# partials, never re-downloading a file whose size and hash already match), starts the server on
# :8008 and prints:
# TYPESAFE_BASE_URL=http://127.0.0.1:8008 TYPESAFE_API_KEY=local
```

It answers from the same `/v1/systemone` contract, so nothing else changes — the same `judge`, the
same `run`. Extras: `--verify-only` re-hashes the whole cache and downloads nothing, `--download-only`
fetches without starting anything, `--list-files` prints the pinned manifest (sizes and hashes for
all 29 files), and `--source`/`--sources` pin the mirror order (ModelScope is fastest where it hosts
the repo, then huggingface.co, then hf-mirror). A file that fails its published size or hash is
deleted and the next source is tried; if every source fails, the launcher exits 3 rather than caching
the bytes. A server already answering on `--port` is reused when it serves the same checkpoint and
reported as a conflict otherwise.

**The optional row-limit patch is never applied silently.** The released Kev server caps one request
at `state + one branch ≤ 8192` tokens, so a real page's 55-option `click_target` question is refused
with HTTP 422: that is published behaviour, and it scores **18/20** on the 20 graded items with the
packed fixture step refused. `jev-kev --patch-row-limit` makes the cap settable — it prints the diff
and the revert command, and the defaults stay 8192; `jev-kev --row-limit 16384` then serves at the
raised cap for that run and scores **19/20**, tying hosted Jev. Without the patch, `--row-limit`
exits 2 and says so.

Cost: a Python venv plus MLX, a 9.34 GB base, and memory as in the table above. On this 48 GB machine
the raised cap drove swap from 16.7 GB to 28.3 GB used while a full 20-item pass ran; nothing timed
out, but that is the ceiling to plan around. Numbers: `experiments/kev-4b/README.md`.

A single judge is not the same as a whole `run`. Measured over 15 real local runs (goals, journals
and per-step numbers: `docs/local-backend-run-smoke.md`) a run **can** finish — a Wikipedia search
goal reached `status=success` in 4 steps — but the bar for saying so is not the hosted one. Scored
as a termination rule (the first step whose reading crosses the line, §9), `goal_done >= 0.25` —
any value in 0.12–0.28 — called **every one of the 7 runs that reached the goal** a success, at a
page that already showed the goal, and never fired on the 8 runs that never got there: 7 correct
successes, 0 false successes, 0 false `stuck` (the hosted 0.85 gave 4 / 0 / 3). A loopback
`baseUrl` therefore got **0.174**, the geometric midpoint of that band; hosted Jev still gets 0.85
and 0.70. Since a second local tier shipped, that single value is no longer what every loopback
endpoint receives — the bar is a per-backend profile instead (next paragraph), and 0.174 is the
`local-readout` profile's value.

**That band is the GGUF readout's, and it does not transfer to Kev** — so the bar is a per-backend
**profile** (`thresholds.profile`, `auto` by default), not one loopback value. A non-loopback
`baseUrl` is `hosted` (0.85 / 0.70). A loopback one is classified with one `GET /v1/models` at run
start: a Kev card names the checkpoint it loaded (`run`, `base`) → `kev` (**0.482** / 0.482); the GGUF
launcher's card is name-only → `local-readout` (**0.174** / 0.174). If that call fails or the card is
unrecognised the run uses the **highest** bar (0.482) and records why — a false `stuck` is visible, a
false success is not. The resolved profile, value and reason are printed by `doctor` (`goal_done bar`)
and written to the run journal's `run.json` before the first step; pinning `thresholds.profile` (or an
explicit `thresholds.goalDone`) still wins for an endpoint the table does not fit.

Why Kev needs its own number: replaying the same 15 §9 goals against Kev 4B
(`experiments/kev-4b/threshold-replay.{sh,mjs}`, same method, same scoring, ground truth read off the
page each step saw) gives the same shape at a higher level and slightly narrower — **(0.341, 0.683]**
against the readout's (0.111, 0.273]. At **0.174 a Kev run calls four not-met pages a success** (R5
0.341, p3 0.257, g1 0.195, g4 0.188), each stopping before the action that would have finished the
goal; **any value in ~0.35–0.68 is clean** (7 correct successes, 0 false successes, 0 false `stuck`,
8 correct `stuck`), and 0.85 loses a legitimate success (the fixture `/docs` page with the secret
revealed, reading 0.683). Full table: `experiments/kev-4b/README.md`.

What is still weak is choosing the action: `action` selection ranked
`type` last even when `type_target` and `type_value` were both right, and chose `stop` with the
goal one click away, while `click_target` is the strong half (right element first on a 65-element
page, 0.71–0.78). `blocker` is unreliable in the same way — it produced a false `needs_user` on a
plain pricing page. Do not replace `goal_done` with a code-side rule: "the goal's named entity
appears in the final URL or title" false-fired on 4 runs — 2 of them never completed, because
search URLs echo the query and product URLs contain the product name — and loop detection
false-fired on 4 as well; aggregating the last readings never beat the single reading either.

Limits: it is a short-state classifier, not a Jev replacement — no few-shot examples, no
configurable system prompt, no images. Measured on 20 graded items: the default 4B scores 0.80
(hosted Jev 0.95, positional baseline 0.55, the 0.8B entry 0.50 — it tracks position more than
option text, the 4B tracks the text). Accuracy and confidence still fall as option lists grow, so
prefer hosted Jev for element lists past ~50 candidates — `goal_done` is the exception, which is
why it carries the local bar above (selection stayed correct on the 64-candidate page, at 0.71–0.78
instead of ~0.99). When the option labels cannot be read out at all the server answers HTTP 422
`LOW_LABEL_MASS` naming the question instead of guessing. Measured numbers:
`experiments/gguf-provider/RESULTS.md` and
`experiments/gguf-provider/results/local-models-4b.md`.

## MCP (Claude Desktop, Cursor, Codex)

`jev-browser mcp` is a stdio MCP server with tools `jev_browse`, `jev_observe`,
`jev_judge`, `jev_pick`, `jev_doctor`, `jev_config`. Register it with
`jev-browser install --targets claude-desktop` (also `cursor-mcp`, `codex-mcp`).
MCP hosts do not inherit the shell, so the installer stores the API key in
`~/.config/jev-browser/config.json` (mode 0600); `config set-key --from-env`
does the same by hand. See `references/mcp.md`.

## Configuration

Precedence: defaults < `~/.config/jev-browser/config.json` <
`./jev-browser.config.json` (or `$JEV_BROWSER_CONFIG`) < environment < flags.
`jev-browser config show` prints the effective values and their sources;
`config set thresholds.goalDone 0.9` persists a key. All keys, environment
variables and tuning advice are in `references/config.md`; the question set and
threshold semantics are in `references/questions.md`; backend setup and
limitations are in `references/backends.md`.

## Journals and debugging

Every run writes `<journalDir>/<runId>/steps.jsonl` (per step: state hash,
compact answers, chosen action, whether the page changed, cost) plus
`requests.jsonl` and `run.json`. Secrets are redacted. When a run misbehaves,
read the journal to separate missing evidence (element not listed), a model
misjudgment (wrong element chosen), a code error (action failed) and a service
failure (HTTP status), and fix the corresponding layer: observation limits,
question wording or thresholds, backend handling, or retries.

## Tests

From the repository root: `npm test` runs unit tests plus e2e scenarios against a
local fixture site with every available backend (ego, headless Chrome, Safari
when enabled). With `TYPESAFE_API_KEY` set the e2e tests use live Jev (about
$0.01 per backend); `JEV_BROWSER_TEST_MODE=mock` uses a local heuristic stand-in.
