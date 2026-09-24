#!/usr/bin/env bash
# Supplemental probes for the Kev-4B base fetch decision:
#   A) ModelScope mirror of Qwen/Qwen3.5-4B-Base (does it serve, does it range, how fast)
#   B) two HF streams in parallel (does the link reward a second connection)
# Same window size and accounting as probe-throughput.sh so rows are comparable.
set -u
SPAN=$((64*1024*1024))
UA='kev-probe/1'
OUT=${OUT:-/tmp/kev-4b-probe}
mkdir -p "$OUT"

W=$((64*1024*1024))
MS=https://modelscope.cn/api/v1/models/Qwen/Qwen3.5-4B-Base/repo
S1=model.safetensors-00001-of-00002.safetensors
S2=model.safetensors-00002-of-00002.safetensors
HF=https://huggingface.co/Qwen/Qwen3.5-4B-Base/resolve/main

row() { # name http bytes speed secs
  awk -v n="$1" -v c="$2" -v b="$3" -v s="$4" -v t="$5" -v sp="$SPAN" 'BEGIN{
    printf "{\"probe\":\"%s\",\"http\":%s,\"bytes\":%s,\"MiBps\":%.3f,\"MBps\":%.3f,\"secs\":%.1f,\"verdict\":\"%s\"}\n",
      n, c, b, s/1048576, s/1000000, t, (b<sp ? "SHORT" : "full window") }'
}

echo "# A1 ModelScope shard1 head"
raw=$(curl -sS -L --max-time 200 --connect-timeout 20 -H "User-Agent: $UA" \
      -r 0-$((SPAN-1)) -o /dev/null -w '%{http_code} %{size_download} %{speed_download} %{time_total}' \
      "$MS?Revision=master&FilePath=$S1" 2>"$OUT/ms_s1.err")
read -r c b s t <<<"$raw"; row ms_base_s1_head "${c:-0}" "${b:-0}" "${s:-0}" "${t:-0}"
echo "# A2 ModelScope shard1 deep (3 GiB)"
raw=$(curl -sS -L --max-time 200 --connect-timeout 20 -H "User-Agent: $UA" \
      -r 3221225472-$((3221225472+SPAN-1)) -o /dev/null -w '%{http_code} %{size_download} %{speed_download} %{time_total}' \
      "$MS?Revision=master&FilePath=$S1" 2>"$OUT/ms_s1d.err")
read -r c b s t <<<"$raw"; row ms_base_s1_deep "${c:-0}" "${b:-0}" "${s:-0}" "${t:-0}"
echo "# A3 ModelScope shard2 head"
raw=$(curl -sS -L --max-time 200 --connect-timeout 20 -H "User-Agent: $UA" \
      -r 0-$((SPAN-1)) -o /dev/null -w '%{http_code} %{size_download} %{speed_download} %{time_total}' \
      "$MS?Revision=master&FilePath=$S2" 2>"$OUT/ms_s2.err")
read -r c b s t <<<"$raw"; row ms_base_s2_head "${c:-0}" "${b:-0}" "${s:-0}" "${t:-0}"

echo "# B two HF streams in parallel, 2 x 64 MiB (aggregate + per stream)"
( curl -sS -L --max-time 200 --connect-timeout 20 -H "User-Agent: $UA" -r 0-$((SPAN-1)) -o /dev/null \
    -w "PAIR_A %{http_code} %{size_download} %{speed_download} %{time_total}\n" "$HF/$S1" \
    >"$OUT/pair_a.txt" 2>"$OUT/pair_a.err" ) &
PA=$!
( curl -sS -L --max-time 200 --connect-timeout 20 -H "User-Agent: $UA" -r 0-$((SPAN-1)) -o /dev/null \
    -w "PAIR_B %{http_code} %{size_download} %{speed_download} %{time_total}\n" "$HF/$S2" \
    >"$OUT/pair_b.txt" 2>"$OUT/pair_b.err" ) &
PB=$!
T0=$(date +%s)
wait $PA $PB
T1=$(date +%s)
A=$(cat "$OUT/pair_a.txt" 2>/dev/null); B=$(cat "$OUT/pair_b.txt" 2>/dev/null)
read -r _ ca ba sa ta <<<"$A"; read -r _ cb bb sb tb <<<"$B"
awk -v ca="${ca:-0}" -v ba="${ba:-0}" -v sa="${sa:-0}" -v ta="${ta:-0}" -v cb="${cb:-0}" -v bb="${bb:-0}" -v sb="${sb:-0}" -v tb="${tb:-0}" -v wall="$((T1-T0))" 'BEGIN{
  printf "{\"probe\":\"pair_stream_a\",\"http\":%s,\"bytes\":%s,\"MiBps\":%.3f,\"secs\":%.1f}\n", ca, ba, sa/1048576, ta;
  printf "{\"probe\":\"pair_stream_b\",\"http\":%s,\"bytes\":%s,\"MiBps\":%.3f,\"secs\":%.1f}\n", cb, bb, sb/1048576, tb;
  printf "{\"probe\":\"pair_aggregate\",\"wall_secs\":%s,\"total_bytes\":%s,\"MiBps\":%.3f,\"MBps\":%.3f}\n",
    wall, ba+bb, (ba+bb)/1048576/wall, (ba+bb)/1000000/wall }'
echo "# done"
