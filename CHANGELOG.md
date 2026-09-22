# Changelog

## 0.1.2 — 2026-09-22

- Goal-aware candidate ordering: elements mentioning goal/input keywords are listed first, so long
  pages (Wikipedia: 500+ links) no longer truncate the relevant link away.
- Dropdown descriptions include the currently selected option (no more re-selecting a set value).
- ego: clicks intercepted by an image/overlay fall back to a forced click, then a DOM click.
- Controller: a model `stop` at 70–85 % goal probability first tries one more untried action;
  a page change now counts as progress even when the backend reports a verification error.
- `scripts/make-demo.mjs`: 1080p H.264 MP4 with crossfades (plus optional GIF preview); replaces
  the GIF-only script.
- README demos: Wikipedia multi-hop, sign-in + contact form with a dropdown, identical buttons.

## 0.1.1 — 2026-09-22

- `run --step-screenshots <dir>` (CLI) / `step_screenshots_dir` (MCP): save the page as Jev saw it
  before every step, plus `final.png`.
- Journals now record `targets`: id → description for the top click/type/select candidates.
- `scripts/make-demo-gif.mjs`: compose a side-by-side GIF/MP4 (page vs. Jev's judgment) from a run.
- README demos recorded in ego lite (GitHub navigation; choosing among identical buttons).
- CI runs unit + mock e2e only; the live suite is local by design, no API key in the cloud.
- Docs: CLI reference, data-flow/privacy section, Windows `--copy` note, env vars.

## 0.1.0 — 2026-09-22

Initial release.

- Controller loop: Jev answers per-step atomic questions (goal_done, blocker, action, click_target,
  type_target, type_value, submit_after_type, select_target, navigate_target, progress) in one request;
  code owns memory (blocked + tried edges), budgets, loop detection and termination.
- Backends: ego lite (default, hand-off/resume), Chrome via CDP (launch or attach, headless), Safari via safaridriver.
- CLI: run, observe, judge, pick, doctor, config, install, mcp.
- MCP stdio server (no dependencies) with jev_browse, jev_observe, jev_judge, jev_pick, jev_doctor, jev_config.
- Installer for Claude Code, Codex, Cursor, skills.sh dir and Claude Desktop (backups, dry-run, uninstall).
- Tests: unit suite, fixture site, mock TypeSafe, e2e scenarios per backend, CLI round-trip.
