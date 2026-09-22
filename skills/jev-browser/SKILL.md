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
  version: "0.1.0"
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
