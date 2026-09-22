# MCP server (Claude Desktop, Cursor, Codex, other hosts)

`jev-browser mcp` speaks MCP over stdio (JSON-RPC, newline-delimited) with no
dependencies. Tools:

| tool | arguments | returns |
| --- | --- | --- |
| `jev_browse` | `goal` (required), `url`, `inputs`, `secrets`, `backend`, `max_steps`, `budget_usd`, `space_id`, `keep`, `headless`, `screenshot_path` | the run result (`status`, `finalUrl`, `finalTitle`, `finalTextExcerpt`, `usage`, `journalDir`, `resume`) |
| `jev_observe` | `url` (required), `backend`, `headless`, `screenshot_path` | the page as Jev sees it |
| `jev_judge` | `state`, `questions`, `model` | raw TypeSafe answers |
| `jev_pick` | `question`, `candidates` (id → description), `context`, `allow_none` | best candidate + ranked probabilities |
| `jev_doctor` | — | environment report |
| `jev_config` | — | effective config (key masked) |

Results are returned both as text (`content[0].text`, JSON) and as
`structuredContent`.

## Registering

```bash
jev-browser install --targets claude-desktop        # ~/Library/Application Support/Claude/claude_desktop_config.json
jev-browser install --targets cursor-mcp            # ~/.cursor/mcp.json
jev-browser install --targets codex-mcp             # ~/.codex/config.toml  [mcp_servers.jev-browser]
```

Each edit is backed up next to the file (`*.bak.<timestamp>`); `--dry-run`
previews, `--uninstall` reverts. The entry is:

```json
{ "command": "<absolute path to node>", "args": ["<skill>/bin/jev-browser.mjs", "mcp"] }
```

Hosts start the server without your shell environment, so the installer copies
`TYPESAFE_API_KEY` into `~/.config/jev-browser/config.json` (0600) when it is
exported; otherwise run `jev-browser config set-key <key>`. Restart the host
after registering.

## Claude Desktop notes

- The `ego` backend opens pages in ego lite on the same machine; Claude Desktop
  sees the returned result, and the user sees the browser.
- Long runs: each `jev_browse` call is bounded by `max_steps` / `budget_usd`;
  keep goals small and chain calls, resuming ego task spaces with `space_id`
  after a `needs_user` result.
