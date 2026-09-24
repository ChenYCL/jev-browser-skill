# Local GGUF backend — measured results

First-token logprob readout on top of `llama.cpp`: the question is rendered with labelled options,
exactly one token is generated, and the probability mass on each option label at that position is
the answer. No training, no text generation, no output parsing, no API key.

Default model is now **Qwen3.5-4B Q4_K_M**; the 0.8B stays as a selectable, faster/weaker entry.
Full ranking and caveats: `results/local-models-4b.md`.

- Machine: Apple M3 Max / 48 GB / macOS 25.6.0 arm64, Node 26.9.0 (no Python involved).
- Ship model: `Qwen3.5-4B-Q4_K_M.gguf` — 2,740,937,888 B, sha256 `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`,
  from `unsloth/Qwen3.5-4B-GGUF` (`llama-server /props` reports `model_ftype = Q4_K - Medium`, arch `qwen35`).
- Reference model: `Qwen3.5-0.8B-Q8_0.gguf` — 811,843,840 B, sha256
  `0ad885ffd4bb022fc4f0d33a3308fa108ef8613159d3b3a67e23abca056b7a6c`, from `unsloth/Qwen3.5-0.8B-GGUF`.
- Server: `llama-server` (Homebrew `llama.cpp` 0.4.0, Metal via MPS), **`-c 16384`** — see *Context size*.
- Product copy of this provider: `skills/jev-browser/lib/local.mjs`, one command in
  `skills/jev-browser/bin/jev-local.mjs`. The code here and the code there are the same algorithm.

## Accuracy — 20 graded items (ground truth known by construction)

| model | all (20) | browser (15) | noul (5) | action + click_target (5) |
| --- | --- | --- | --- | --- |
| **Qwen3.5-4B Q4_K_M (ships)** | **16 · 0.800** | 12 · 0.800 | 4 · 0.800 | 2 · 0.400 |
| Qwen3.5-0.8B Q8_0 (reference) | 10 · 0.500 | 7 · 0.467 | 3 · 0.600 | 1 · 0.200 |
| "always answer the option listed first" | 11 · 0.550 | 9 · 0.600 | 2 · 0.400 | 2 · 0.400 |
| hosted Jev (ceiling, same items) | 19 · 0.950 | 14 · 0.933 | 5 · 1.000 | 5 · 1.000 |

The 4B is the first local candidate to clear the positional prior (+5 items) and to be close enough
to hosted Jev to be useful for short decisions. Its errors on the graded set: `ddg-click-target-aapl`
(see caveats), `ddg-typed-action`, `github-login-action`, `bq-penguins`.

Readout quality on the 4B: captured label mass **mean 0.9407 / min 0.7958**, **0 non-single-token
labels** (the alphabet verification skipped everything the tokenizer splits). One 100-option item
lost 32 tail labels outside the 512-candidate window.

**Rotation (text, not position).** Rotating the option list while keeping the labels: on the
100-option `wiki-login-click-target` the 4B hit the exact expected element at every rotation
(k=0/3/7 → `e8`/`e5`/`e1`, P≈0.99). The 0.8B instead kept answering inside the first few slots
(`e1`/`e2`/`e4`/`e6`) — i.e. the 4B reads the option text, the 0.8B reads position.

**Confidence is usable as an abstention signal on the 4B** (it was not on the 0.8B): 12 choice/score
answers, mean confidence 0.516; wrong answers average 0.233 (most confident wrong: 0.598). Filtering
at `confidence ≥ 0.5` keeps 8/12 answers with 7/8 correct; at `≥ 0.7`, 4/12 with 4/4.

## Latency — one real browser step, 5 questions

State 16,111 B — the skill's own first-step question set (`goal_done` noul, `blocker` 6 options,
`action` 5, `click_target` 55, `select_target` 3); 13,729 prompt tokens cold, 6,859 warm. Numbers
below are from a clean re-run with nothing else running (a concurrent-download run produced the same
answers, 13.8 s wall).

| model | cold | warm (prefix cache hot) | RSS |
| --- | --- | --- | --- |
| **Qwen3.5-4B Q4_K_M** | **18,298 ms** | **9,002 ms** | 3,362 MiB |
| Qwen3.5-0.8B Q8_0 | 2,933 ms | 1,745 ms | not measured |

Per question, 4B warm: `goal_done` 703 ms · `blocker` 815 ms · `action` 705 ms ·
**`click_target` 6,135 ms** · `select_target` 630 ms. Per question, 0.8B warm: 151 / 159 / 127 /
1,165 / 132 ms. The whole step is the repeated prefill of the state per question, and `click_target`
dominates because it lists 55–100 options. The 0.8B through the skill itself
(`jev-browser judge` against `TYPESAFE_BASE_URL`) was 2,673 ms wall for the same questions with
`normalizeAnswers` consuming the answers unchanged (27/27 checks); local tokens cost **$0**.

## Context size

A rendered prompt is dominated by the option list: with the skill's default
`observation.maxCandidates` of 100, `click_target` is about **11.7k tokens** (11,748 measured on the
55-option fixture step). The launcher now spawns `llama.cpp` with **`-c 16384`** (its `--ctx`
default) for that reason; at `-c 8192` llama.cpp hard-fails the request with
`400 request (11748 tokens) exceeds the available context size (8192 tokens)`
(`exceed_context_size_error`), so 8192 is not usable with the default candidate count. Starting
`llama-server` by hand is no longer required.

## Where it breaks

- Long element lists stay the weak spot: even at 4B, `click_target` costs ~6 s and the `action`
  slice is 2/5 — it is the question that also dominates latency.
- Free-form `type_value` and pass-`goal_done` judgments on long states were the 0.8B's worst cases;
  the 4B reads both correctly on the fixtures (goal_done 0.006 for an unmet goal) but they remain
  the least tested.
- Anything visual: the state is text only.
- Product guard: when the readout cannot find the option labels at all (label not a single token,
  candidates truncated) the mass drops and the server answers HTTP 422 `LOW_LABEL_MASS` naming the
  question instead of guessing.

## Ranking and what is still unmeasured

`results/local-models-4b.md` is the full ranking. Two caveats from it are load-bearing:

- Candidates 2 and 3 (`Qwen3-4B-Instruct-2507`, `gemma-3-4b-it`) never finished downloading — the
  link collapsed to ~10–25 KB/s with bursts — so their accuracy **and** their drivability through
  the render path (chat template via `/apply-template`) are unexercised. No download is running now;
  the retry script is `/tmp/jev-ceiling/fetch-4b.sh` (start with `hub`, then
  `bash /tmp/jev-ceiling/run-candidate.sh <slug> 8100`).
- `ddg-click-target-aapl`'s ground-truth label is debatable: the hand label is `e1` (investing.com,
  `in_viewport=false`), while hosted Jev and the 4B both pick `e15` (Yahoo Finance AAPL quote page,
  in viewport). Every model is therefore scored down by up to one item on that question.

`Qwen3-0.6B` (11/20 on the same set, slower than the 0.8B) is not shipped.
