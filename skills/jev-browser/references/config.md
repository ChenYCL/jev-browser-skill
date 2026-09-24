# Configuration

Precedence (later wins): built-in defaults → `~/.config/jev-browser/config.json`
→ `./jev-browser.config.json` (or the file named by `$JEV_BROWSER_CONFIG`) →
environment variables → CLI flags / MCP tool arguments.

`jev-browser config show` prints the effective configuration with the API key
masked and the list of sources that contributed.

## Keys

| key | default | meaning |
| --- | --- | --- |
| `apiKey` | null | TypeSafe API key; prefer the `TYPESAFE_API_KEY` env var. `config set-key --from-env` stores it (0600) for MCP hosts. A local tier uses the literal placeholder `local` — the local server ignores the `Authorization` header, but the client requires a non-empty key; `jev-browser setup <tier>` and `jev-browser tier use <tier> --persist` store a local tier's `baseUrl` + `apiKey` for you (`config set apiKey local` by hand) |
| `baseUrl` | `https://api.typesafe.ai` | API base URL (`TYPESAFE_BASE_URL`) |
| `model` | `jev-latest` | `jev-latest`, `jev-preview`, or a pinned id such as `jev-1.13.0` (`TYPESAFE_DEFAULT_MODEL`) |
| `timeoutMs` | 20000 | per-request timeout |
| `maxRetries` | 2 | retries on 429/5xx/network errors with backoff, honouring `retry-after` |
| `pricePerMtok` | 0.042 | USD per million input tokens, used for cost estimates; a loopback `baseUrl` (127.0.0.1 / localhost / ::1, i.e. a local model) is priced at 0 |
| `backend` | `ego` | `ego` \| `chrome` \| `safari` (`JEV_BROWSER_BACKEND`) |
| `maxSteps` | 25 | actions per run (`JEV_BROWSER_MAX_STEPS`) |
| `budgetUsd` | 0.25 | stop when estimated spend reaches this (`JEV_BROWSER_BUDGET_USD`) |
| `maxMs` | 300000 | wall-clock limit |
| `settleMs` | 400 | pause after each action once the page has loaded |
| `loadTimeoutMs` | 15000 | navigation / load wait |
| `thresholds.profile` | `auto` | `auto` \| `hosted` \| `local-readout` \| `kev` — which `goal_done` bar to use; `auto` classifies a loopback endpoint with one `GET /v1/models` at run start |
| `thresholds.goalDone` | from the profile (`0.85` hosted, `0.174` readout, `0.482` kev) | success threshold on the `goal_done` noul |
| `thresholds.goalDoneFinal` | from the profile (`0.7` hosted, else the same as `goalDone`) | success threshold for the final check / model `stop` |
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

## Termination thresholds on a local backend

The tiers themselves — what each backend is, what it needs, how to start it, its port, its 20-item
score and the bar it gets — are listed once, in [`SKILL.md`](../SKILL.md#judging-tiers), and
`jev-browser tier list | status | use` prints the same thing from the CLI. This section is only
about the thresholds.

`goal_done` is the question that ends a run, but its *value* depends on the backend — and the two
local backends this skill ships read it on scales that do not overlap. So the value is a **profile**:

| `thresholds.profile` | `goalDone` / `goalDoneFinal` | measured on |
| --- | --- | --- |
| `hosted` | 0.85 / 0.70 | the shipped Jev default |
| `local-readout` (GGUF, `bin/jev-local.mjs`) | 0.174 / 0.174 | `docs/local-backend-run-smoke.md` §9 — band 0.111 – 0.273 |
| `kev` (`bin/jev-kev.mjs`) | 0.482 / 0.482 | `experiments/kev-4b/README.md` — band 0.341 – 0.683 |

`auto` (the default) picks one: a non-loopback `baseUrl` is `hosted`; a loopback one
(`127.0.0.1` / `localhost` / `::1`) is classified from **one `GET /v1/models`** at run start, because
only the endpoint knows which backend it is. A Kev card names the checkpoint it loaded (`run`, `base`)
→ `kev`; the GGUF launcher's card is name-only → `local-readout`. If that call fails or the card is
one this build does not recognise, the run uses the **highest** bar (0.482) and says so in the journal:
a false `stuck` stops the run where you can see it, while a false success is silent.

Each band above is the maximin geometric midpoint of its own measured sides (√(0.111 × 0.273) and
√(0.341 × 0.683) — 1.57× and 1.41× from each side respectively). Code-side rules are not a
substitute: "the goal's named entity appears in the final URL or title" false-fired on 4 of the 15
runs (2 of them never reached the goal) and loop detection false-fired on 4, so the threshold stays
the rule and only its value moves.

**Pinning it by hand is the fallback, not the instruction.** A value any layer provides still wins —
`thresholds.profile: "kev"` in a config file (or `config set thresholds.profile kev`), or an explicit
`config set thresholds.goalDone 0.4` — which is what you want when the profile table does not fit your
endpoint (a new checkpoint, a fine-tune, a backend this build has never seen). `jev-browser doctor`
prints the pair a run would use, the profile it came from and why (`goal_done bar`), and the run
journal's `run.json` carries the same record — profile, reason, applied values and the raw
classification — written before the first step.

The readout's side, in full: 7 successful and 8 never-successful runs, one machine, one 4B
quantization, three sites; the lower edge (0.12) is only 1.08× the worst not-met reading observed
(0.111, inside a run that did succeed). Real sites will spread wider, so re-measure before trusting
either local bar with a model nobody has scored.

**The Kev band, and why the readout's bar must not be reused for it.** Kev (`bin/jev-kev.mjs`) is a
trained pointer-head checkpoint, not a first-token logprob readout: on the real fixture page the Kev
4B says **0.0607** where the GGUF 0.8B said 0.6952 and the GGUF 4B said 0.006. Replaying the same 15
§9 goals against Kev 4B, scored the same way (first step crossing the line, ground truth from the page
that step saw; readings, labels and scorer in `experiments/kev-4b/threshold-replay.{sh,mjs}`):

| threshold | correct success | false success | false stuck | correct stuck |
| --- | --- | --- | --- | --- |
| **0.174 (the readout's bar)** | 7 | **4** | 0 | 4 |
| 0.25 | 7 | 2 | 0 | 6 |
| 0.35 – 0.68 | **7** | **0** | **0** | **8** |
| 0.482 (this profile) | 7 | 0 | 0 | 8 |
| 0.85 (the hosted default) | 5 | 0 | 2 | 8 |

At 0.174 four not-met pages read as success (R5 0.341, p3 0.257, g1 0.195, g4 0.188) and each stops
the run before the action that would have finished the goal. At 0.85 a legitimate Kev success —
the fixture `/docs` page with the secret revealed, reading 0.683 — is lost as a false `stuck`.

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
