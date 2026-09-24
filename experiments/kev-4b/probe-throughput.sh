#!/usr/bin/env bash
# Sequential bounded-window throughput probe for the Kev-4B fetch decision.
#
# One JSON object per window. Windows are 64 MiB unless the artifact is smaller.
# Probes run strictly SEQUENTIALLY so each number is that source's own rate on an
# otherwise idle link (parallel probes share the pipe and inflate/complicate the
# reading). First ~20 s of a transfer is ramp, so windows are >= 64 MiB.
#
# usage: bash experiments/kev-4b/probe-throughput.sh
set -u
SPAN=$((64*1024*1024))
UA='kev-probe/1'
OUT=${OUT:-/tmp/kev-4b-probe}

mkdir -p "$OUT"

probe() { # name url start [span]
  local name=$1 url=$2 start=$3 span=${4:-$SPAN}
  local end=$((start+span-1)) code size speed ttotal err mibs mbs note
  local raw
  raw=$(curl -sS -L --max-time 180 --connect-timeout 15 -H "User-Agent: $UA" \
        -r "${start}-${end}" -o /dev/null \
        -w '%{http_code} %{size_download} %{speed_download} %{time_total}' "$url" 2>"$OUT/$name.err")
  read -r code size speed ttotal <<<"$raw"
  size=${size:-0}
  err=$(tr -d '\n\r' <"$OUT/$name.err" | cut -c1-120)
  mibs=$(awk -v s="$speed" 'BEGIN{printf "%.3f", s/1048576}')
  mbs=$(awk -v s="$speed" 'BEGIN{printf "%.3f", s/1000000}')
  if [ "$size" -lt "$span" ]; then note="SHORT (window incomplete: $size/$span)"; else note="full window"; fi
  printf '{"probe":"%s","start":%s,"span":%s,"http":%s,"bytes":%s,"MiBps":%s,"MBps":%s,"secs":%s,"verdict":"%s"%s}\n' \
    "$name" "$start" "$span" "${code:-0}" "$size" "$mibs" "$mbs" "${ttotal:-0}" "$note" \
    "$([ -n "$err" ] && printf ',"curl":"%s"' "$err")"
}

HF=https://huggingface.co
ADAPTER=$HF/jaredpalmer/kev-4b/resolve/main/adapter_model.safetensors
BASE_S1=$HF/Qwen/Qwen3.5-4B-Base/resolve/main/model.safetensors-00001-of-00002.safetensors
BASE_S2=$HF/Qwen/Qwen3.5-4B-Base/resolve/main/model.safetensors-00002-of-00002.safetensors
MIRROR=https://hf-mirror.com
GHASSET=https://github.com/jaredpalmer/kev/releases/download/kev-family/kev-4b.tar.gz

echo "# adapter (129,924,032 B) — hf direct"
probe hf_adapter_head   "$ADAPTER" 0
probe hf_adapter_tail   "$ADAPTER" $((129924032 - SPAN))
echo "# base shard1 (5,329,398,712 B) — hf direct"
probe hf_base_s1_head   "$BASE_S1" 0
probe hf_base_s1_deep   "$BASE_S1" 3221225472
echo "# base shard2 (3,990,429,344 B) — hf direct"
probe hf_base_s2_head   "$BASE_S2" 0
echo "# adapter — hf-mirror.com"
probe mirror_adapter    "$MIRROR/jaredpalmer/kev-4b/resolve/main/adapter_model.safetensors" 0
echo "# adapter — GitHub release asset kev-4b.tar.gz (129,125,088 B)"
probe gh_asset_head     "$GHASSET" 0
echo "# SHA256SUMS.txt (768 B)"
curl -sS -L --max-time 60 -H "User-Agent: $UA" \
  https://github.com/jaredpalmer/kev/releases/download/kev-family/SHA256SUMS.txt -o "$OUT/SHA256SUMS.txt" \
  -w '{"probe":"gh_sha256sums","http":%{http_code},"bytes":%{size_download}}\n'
echo "--- SHA256SUMS.txt ---"
cat "$OUT/SHA256SUMS.txt" 2>/dev/null || echo "(missing)"
echo "# done"
