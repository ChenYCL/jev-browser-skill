# The question set (how Jev is used)

Design follows NanoJev's split: the model answers **local, atomic questions**
about the current page; **code** composes them into behaviour. All questions of
a step are sent in one `POST /v1/systemone` request (speculative fan-out); they
are independent and evaluated in parallel on the same `state`.

## State sent each step

```json
{
  "goal": "Start a free trial of the Team plan",
  "inputs": { "email": "ada@example.com", "password": "[secret value: hidden from the model, available to type]" },
  "page": {
    "url": "https://…/pricing", "title": "Pricing · Widgetry",
    "headings": ["# Pricing", "## Starter", "## Team", "## Business"],
    "dialog": null,
    "scroll_position": "page fits in the viewport",
    "visible_text": "…up to observation.maxTextChars…",
    "elements": [ { "id": "e7", "description": "button 'Start free trial'", "in_viewport": true }, … ],
    "omitted_elements": 0
  },
  "previous_page": { "url": "…", "title": "…", "text_excerpt": "…", "element_count": 12 },
  "last_action": "clicked link 'Pricing' → /pricing",
  "history": { "steps_taken": 1, "recent_urls": ["https://…/"] }
}
```

`inputs` values are truncated to 200 characters; secrets are replaced by a
fixed marker. Quoted strings in the goal are added as `quoted_1`, `quoted_2`, ….

## Questions

| id | type | asked when | consumed by code as |
| --- | --- | --- | --- |
| `goal_done` | noul | always | success when ≥ `thresholds.goalDone` (0.85); ≥ `goalDoneFinal` (0.7) on the final check or when the model chose `stop` |
| `blocker` | choice: none, login_required, verification_challenge, consent_or_permission_dialog, error_page, missing_information | always | `needs_user` when a non-none option has probability ≥ `thresholds.blocker` (0.6) |
| `action` | choice over the **legal** actions only: click, type, select, scroll_down, scroll_up, go_back, navigate, wait, stop | always | preference order for candidate actions |
| `click_target` | choice over clickable element ids + `none` | clickable elements exist | element ranking for `click`; if `none` outranks every element, clicking is skipped |
| `type_target` | choice over editable element ids + `none` | editable elements and inputs exist | field ranking for `type` |
| `type_value` | choice over input keys + `none` | same | which input goes into the field |
| `submit_after_type` | noul | same | press Enter after typing when ≥ 0.5 |
| `select_target` | choice over dropdown ids + `none` | dropdowns exist | which dropdown to change (the option is asked in a second, dependent request) |
| `navigate_target` | choice over URL-valued input keys | ≥ 2 URL inputs | which URL to load |
| `progress` | score: moved away / no change / closer / accomplished | a previous page exists | when P(moved away) ≥ `thresholds.regressed` (0.6) the next action is `go_back` |

Legal-action filtering is done in code (like NanoJev's collision filter in
Snake): `scroll_down` is offered only when content lies below, `go_back` only
with history, `type` only with inputs and editable fields. The model breaks ties
among legal moves.

## Controller policy (code)

1. Observe: inject the shared enumerator, get url/title/text/elements; tag
   elements with `data-jev-id`. Hash the observation (url + text + element
   names, not scroll position).
2. Stop early on budget, time, or a state seen more than four times.
3. Ask the questions above in one request.
4. Success / blocker checks.
5. Build the candidate list in model preference order: action rank first, then
   target rank; skip actions whose `none` option wins. Take the first candidate
   not blocked by memory. Memory blocks `(stateHash, actionKey)` pairs whose
   execution produced no page change or an error, so the next step tries the
   next candidate instead of repeating.
6. Execute, settle (load event + `settleMs`), observe again; after
   `thresholds.noChangeLimit` (3) consecutive no-change actions the run is
   `stuck`.
7. Out of steps: one final `goal_done` check so a goal completed by the last
   action still counts.

## Tuning

- Element descriptions are what Jev sees; if a target is described poorly
  (`(unnamed)`), the site lacks accessible names. Aria labels and visible text
  are picked up; consider `observation.maxNameChars`.
- Raise `thresholds.goalDone` for actions with side effects, lower it for
  read-only goals. Validate on your own sites; treat 0.85 as a starting point.
- Jev 1.13 reads literally, does not count, and does not compare dates: put
  exact names in the goal, keep counting/ordering in code.
- When many questions matter, batching is nearly free in latency; cost is
  input-token based (≈$0.042 per million).
