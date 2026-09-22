# Configuration

Precedence (later wins): built-in defaults → `~/.config/jev-browser/config.json`
→ `./jev-browser.config.json` (or the file named by `$JEV_BROWSER_CONFIG`) →
environment variables → CLI flags / MCP tool arguments.

`jev-browser config show` prints the effective configuration with the API key
masked and the list of sources that contributed.

## Keys

| key | default | meaning |
| --- | --- | --- |
| `apiKey` | null | TypeSafe API key; prefer the `TYPESAFE_API_KEY` env var. `config set-key --from-env` stores it (0600) for MCP hosts |
| `baseUrl` | `https://api.typesafe.ai` | API base URL (`TYPESAFE_BASE_URL`) |
| `model` | `jev-latest` | `jev-latest`, `jev-preview`, or a pinned id such as `jev-1.13.0` (`TYPESAFE_DEFAULT_MODEL`) |
| `timeoutMs` | 20000 | per-request timeout |
| `maxRetries` | 2 | retries on 429/5xx/network errors with backoff, honouring `retry-after` |
| `pricePerMtok` | 0.042 | USD per million input tokens, used for cost estimates |
| `backend` | `ego` | `ego` \| `chrome` \| `safari` (`JEV_BROWSER_BACKEND`) |
| `maxSteps` | 25 | actions per run (`JEV_BROWSER_MAX_STEPS`) |
| `budgetUsd` | 0.25 | stop when estimated spend reaches this (`JEV_BROWSER_BUDGET_USD`) |
| `maxMs` | 300000 | wall-clock limit |
| `settleMs` | 400 | pause after each action once the page has loaded |
| `loadTimeoutMs` | 15000 | navigation / load wait |
| `thresholds.goalDone` | 0.85 | success threshold on the `goal_done` noul |
| `thresholds.goalDoneFinal` | 0.7 | success threshold for the final check / model `stop` |
| `thresholds.blocker` | 0.6 | probability of a non-`none` blocker that pauses for the user |
| `thresholds.noChangeLimit` | 3 | consecutive no-effect actions before `stuck` |
| `thresholds.regressed` | 0.6 | P(moved away) that forces `go_back` |
| `observation.maxCandidates` | 100 | interactive elements offered (API max 255) |
| `observation.maxTextChars` | 3000 | visible text sent |
| `observation.maxHeadings` | 12 | headings sent |
| `observation.maxNameChars` | 80 | element name length |
| `journalDir` | `~/.config/jev-browser/journal` | per-run journals (`JEV_BROWSER_JOURNAL_DIR`) |
| `keepJournal` | true | write journals |
| `ego.serverName` | null | `--ego-server-name` for a named ego service (`JEV_BROWSER_EGO_SERVER_NAME`) |
| `ego.keepOnSuccess` | true | leave the result page open in ego lite |
| `ego.spaceName` | null | task-space name (defaults to the goal) |
| `chrome.cdpUrl` | null | attach to a running Chrome (`JEV_BROWSER_CHROME_CDP_URL`) |
| `chrome.executable` | null | path override (also `CHROME_PATH`) |
| `chrome.userDataDir` | `~/.config/jev-browser/chrome-profile` | dedicated profile (logins persist between runs) |
| `chrome.headless` | false | headless mode (`JEV_BROWSER_HEADLESS=1`) |
| `chrome.windowSize` | `1280,900` | window size |
| `chrome.keepOnSuccess` | true | leave the launched window open on success (never in headless) |
| `chrome.extraArgs` | [] | extra Chrome flags |
| `safari.port` | 0 | safaridriver port (0 = free port) |
| `safari.keepOnSuccess` | true | leave Safari open on success |

## Examples

Project file for a CI-like run with Chrome:

```json
{ "backend": "chrome", "chrome": { "headless": true, "keepOnSuccess": false }, "maxSteps": 15, "budgetUsd": 0.1 }
```

User file pinning a model and stricter success:

```json
{ "model": "jev-1.13.0", "thresholds": { "goalDone": 0.9 } }
```

Command-line equivalents: `--backend chrome --headless --max-steps 15 --budget-usd 0.1 --model jev-1.13.0`.
