#!/usr/bin/env bash
# Replay the 15 goals of docs/local-backend-run-smoke.md §9 against whatever /v1/systemone backend
# TYPESAFE_BASE_URL points at, and dump every step's goal_done reading so the loopback termination bar
# can be re-measured on that backend.
#
#   TYPESAFE_BASE_URL=http://127.0.0.1:8008 node skills/jev-browser/bin/jev-kev.mjs   # or any backend
#   node --input-type=module -e "const {createSite}=await import('./tests/fixtures/server.mjs');const s=createSite();await new Promise(r=>s.server.listen(3111,'127.0.0.1',r));"
#   bash experiments/kev-4b/threshold-replay.sh [out-dir]
#
# Then: node experiments/kev-4b/threshold-replay.mjs <out-dir>
#
# Same method as §9: one real run per goal, chrome headless, default 20 s per-request timeout, the
# journal's per-step goal_done is the reading, and the page each step saw is the ground truth.
set -u
OUT="${1:-/tmp/kev-threshold}"
MODE="${2:-all}"                       # all | fixture  (fixture = skip the three live-site runs)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$ROOT/skills/jev-browser/bin/jev-browser.mjs"
mkdir -p "$OUT/journal" "$OUT/shots" "$OUT/runs"
: > "$OUT/runs.tsv"

export TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-local}"
export JEV_BROWSER_BACKEND=chrome
export JEV_BROWSER_HEADLESS=1

# name | max-steps | max-ms | url | goal | extra args (inputs/secrets)
RUNS=(
"R1|5|90000|https://example.com|the page's main heading says Example Domain|"
"R2|5|90000|http://127.0.0.1:3111/products|add the Red Gadget to the cart|"
"p1|5|90000|http://127.0.0.1:3111/products/red-gadget|the Red Gadget product page is open and shows its price|"
"p2|5|90000|http://127.0.0.1:3111/products|the product catalogue page is open|"
"R5|5|90000|http://127.0.0.1:3111/consent|click Accept to dismiss the cookie banner|"
"R4|6|90000|http://127.0.0.1:3111/|open the Docs page and click the button that shows the password|"
"g3|5|90000|http://127.0.0.1:3111/docs|click the button that shows the password and confirm it is visible|"
"g1|5|90000|http://127.0.0.1:3111/products/red-gadget|add the Red Gadget to the cart|"
"p3|5|90000|http://127.0.0.1:3111/pricing|start a free trial of the Team plan|"
"p4|6|90000|http://127.0.0.1:3111/login|sign in with the provided email and password|-i email=user@example.com -s password=hunter2"
"g4|5|90000|http://127.0.0.1:3111/contact|fill in the contact form and send it|-i name=Ada Lovelace -i email=ada@example.com -i subject=Billing question -i message=Please help me with a billing problem"
"R3|6|120000|https://duckduckgo.com|search for python on DuckDuckGo and open the python.org result|"
"R6|5|90000|https://duckduckgo.com/?q=python+org|open python.org from the search results|"
"R7|6|120000|https://en.wikipedia.org/wiki/Special:Search|open the Wikipedia article about Alan Turing|"
"R8|8|180000|https://en.wikipedia.org/wiki/Main_Page|search Wikipedia for the article about the Eiffel Tower and open it|"
)

for row in "${RUNS[@]}"; do
  IFS="|" read -r name steps ms url goal extra <<< "$row"
  if [ "$MODE" = "fixture" ] && [ "${url#http://127.0.0.1:3111}" = "$url" ]; then
    echo "skip $name (live site, --mode fixture)" | tee -a "$OUT/runs.tsv"
    continue
  fi
  journal="$OUT/journal/$name"
  mkdir -p "$journal"
  export JEV_BROWSER_JOURNAL_DIR="$journal"
  start=$(date +%s)
  # shellcheck disable=SC2086
  node "$CLI" run --goal "$goal" --url "$url" --backend chrome --headless \
    --max-steps "$steps" --max-ms "$ms" --step-screenshots "$OUT/shots/$name" --json -q $extra \
    > "$OUT/runs/$name.json" 2> "$OUT/runs/$name.err"
  code=$?
  end=$(date +%s)
  status=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$OUT/runs/$name.json','utf8')||'{}').status??'?')}catch{console.log('no-json')}")
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$code" "$status" "$((end - start))" "$url" >> "$OUT/runs.tsv"
  echo "$name exit=$code status=$status $((end - start))s" >&2
done

echo "done: $OUT/runs.tsv" >&2
