# Backends

These are the **browser** backends (`--backend ego|chrome|safari`). The *judging* backend — which
model answers the questions — is a separate axis called a **tier**: hosted Jev (the default), the
local GGUF readout, or Kev 4B. See [`SKILL.md`](../SKILL.md#judging-tiers) or run
`jev-browser tier list`.

All backends share one perception layer (`lib/observe.mjs`): a script injected
into the page lists visible interactive elements (links, buttons, inputs,
selects, checkboxes, ARIA widgets, open shadow roots), tags them with
`data-jev-id`, and returns url, title, headings, visible text, dialog text and
scroll state. Actions address elements by that attribute, so behaviour is the
same across browsers.

## ego lite (default)

- Requires the ego lite app and the `ego-browser` CLI (`ego-browser --version`).
- The controller loop runs inside `ego-browser nodejs` for the whole job (one
  process per run). Config and inputs are passed through a 0600 temp file that
  is deleted immediately after being read, because the ego runtime does not
  inherit environment variables.
- One task space per run, page `p1`. On success the page is kept open for the
  user (`ego.keepOnSuccess`); otherwise the space is closed.
- On a blocker the space is handed to the user (`task.handOff()`); the result
  contains `resume.spaceId`. After the user acts, continue with
  `jev-browser run --backend ego --space-id <id> --goal "…"` (no `--url`).
- Named services: `ego.serverName` / `JEV_BROWSER_EGO_SERVER_NAME`.
- Screenshots need a visible ego window; if `screenshot` times out, run
  `open -a "ego lite"` once.

## Chrome (DevTools protocol)

- Launch mode (default): starts Chrome with `--remote-debugging-port` on a free
  port and a dedicated profile (`chrome.userDataDir`). Chrome refuses remote
  debugging on the default profile, so the user's main profile is never touched;
  logins made in the dedicated profile persist between runs. Non-headless
  launches are detached and stay open on success.
- Attach mode: set `chrome.cdpUrl` (or `--cdp-url`) to `http://127.0.0.1:9222`
  after starting Chrome yourself with
  `--remote-debugging-port=9222 --user-data-dir=/path/to/profile`. A new tab is
  created for the run and closed unless kept.
- Input is dispatched with real CDP mouse/keyboard events; typing uses
  `Input.insertText` so framework listeners fire.
- Launched instances get `--use-mock-keychain` (macOS) and
  `--password-store=basic` (Linux) so Chrome never opens the system keychain
  and no "Keychain Not Found" dialog appears. Passwords saved inside the
  dedicated profile are therefore encrypted with a mock key, which is fine as
  long as the profile is only used by jev-browser.
- Node 22+ is required for the global `WebSocket`.
- Executable lookup order: `chrome.executable` → `CHROME_PATH` → well-known paths for Chrome,
  Chromium, Canary, Edge and Brave (macOS, Linux, Windows).
- On Linux the launcher adds `--disable-dev-shm-usage --disable-gpu`; when `CI` is set it also
  adds `--no-sandbox` (container runners lack user namespaces). The GitHub Actions workflow
  runs the mock e2e suite this way on `ubuntu-latest`.

## Safari (safaridriver / WebDriver)

- Enable once: Safari → Settings → Advanced → "Show features for web
  developers", then Develop → "Allow Remote Automation" (or
  `sudo safaridriver --enable`). Until then the backend fails fast with code
  `SAFARI_AUTOMATION_DISABLED`.
- `safaridriver -p <port>` is started per run; the session is deleted on
  failure and kept open on success (`safari.keepOnSuccess`).
- Uses the W3C WebDriver endpoints (`/url`, `/element`, `/element/:id/click`,
  `/element/:id/value`, `/execute/sync`, `/screenshot`, `/back`).
- Safari cannot run headless; a window will appear.

## Choosing

| need | backend |
| --- | --- |
| the user's existing logins, cookies, extensions; collaborate in the user's browser | ego |
| unattended runs, CI, no window | chrome `--headless` |
| attach to a browser you already control | chrome `--cdp-url` |
| WebKit-specific behaviour | safari |
