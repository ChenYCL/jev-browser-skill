#!/usr/bin/env bash
# Post-fetch verification for the Kev-4B workstream.
#  1. re-hash every file of both repos against the Hub tree metadata
#  2. resolve both checkpoints through kev's own call path, offline
#  3. transformers resolves the base offline (config + tokenizer)
#  4. load the whole checkpoint (MLX merge) and time it
#  5. one real decision through LocalPredictor -- bytes -> answer, no server
#
# usage: bash experiments/kev-4b/verify.sh [--skip-load]
set -u
ROOT=/Users/light/Documents/2026-project/jev-browser-skill
KEV=/Users/light/.local/share/jev-browser/kev
V=$KEV/.venv/bin/python
REV=1001bb4d826a52d1f399e183466143f4da7b741b
OUT=${OUT:-/tmp/kev-4b-verify}
mkdir -p "$OUT"

echo "=== 1a. full re-verification: jaredpalmer/kev-4b (16 files, 159.7 MB) ==="
cd "$ROOT" && python3 experiments/kev-4b/fetch.py jaredpalmer/kev-4b 2>&1 | tail -4

echo "=== 1b. full re-verification: Qwen/Qwen3.5-4B-Base (13 files, 9.34 GB) ==="
cd "$ROOT" && python3 experiments/kev-4b/fetch.py Qwen/Qwen3.5-4B-Base 2>&1 | tail -4

echo "=== 2. kev's own resolution, offline ==="
cd "$KEV" && HF_HUB_OFFLINE=1 $V -c "
from kev.checkpoint import resolve_run
print('adapter:', resolve_run('jaredpalmer/kev-4b'))
print('base   :', resolve_run('Qwen/Qwen3.5-4B-Base@$REV'))
"

echo "=== 3. transformers offline: config + tokenizer ==="
cd "$KEV" && HF_HUB_OFFLINE=1 $V -c "
from transformers import AutoConfig, AutoTokenizer
c = AutoConfig.from_pretrained('Qwen/Qwen3.5-4B-Base', revision='$REV')
t = AutoTokenizer.from_pretrained('Qwen/Qwen3.5-4B-Base', revision='$REV')
tc = c.get_text_config()
print('model_type:', c.model_type, '| layers:', tc.num_hidden_layers, '| vocab:', t.vocab_size)
" 2>&1 | tail -3

if [ "${1:-}" = "--skip-load" ]; then echo "(load skipped)"; exit 0; fi

echo "=== 4+5. load the checkpoint (MLX) and run one decision ==="
cd "$KEV" && HF_HUB_OFFLINE=1 $V - <<'PY' 2>&1 | tail -25
import json, time
from kev.predictors import LocalPredictor

t0 = time.time()
p = LocalPredictor("jaredpalmer/kev-4b", "mps")
print(f"load: {time.time()-t0:.1f}s")

record = {
    "state": "Ticket 4471. Customer writes: my invoice shows two charges for the same order and I want "
             "the second one refunded. Order shipped yesterday, tracking is active. No damage reported.",
    "questions": {
        "department": {"type": "choice", "instructions": "Which team owns this ticket?",
                       "criteria": {"shipping": "It is about delivery or tracking",
                                    "billing": "It is about charges, invoices or refunds",
                                    "returns": "It is about sending goods back"},
                       "label": "billing"},
        "urgent": {"type": "noul", "instructions": "Does this need same-day handling?", "label": False},
        "frustration": {"type": "score", "instructions": "How frustrated is the customer?",
                        "criteria": ["Calm", "Frustrated", "Very angry"], "label": 1},
    },
}
t1 = time.time()
out = p(record)
print(f"decision: {time.time()-t1:.2f}s")
print(json.dumps(out, indent=1, default=str)[:1200])
PY
