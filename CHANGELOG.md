# Changelog

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
