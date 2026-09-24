#!/usr/bin/env bash
# Range-fetch throughput probe for a HuggingFace artifact URL.
#
# Times a bounded ranged GET (default 5 MiB) N times and prints one JSON object
# per run, so callers get raw numbers and can aggregate themselves.
#
# usage: throughput.sh <label> <url> [range_bytes] [samples]
#   range_bytes  bytes to request from offset 0 (default 5242880 = 5 MiB)
#   samples      number of runs (default 3)
#
# Per sample we print:
#   http_code        206 = server honored Range; 200 = Range ignored (full file!)
#   size_download    bytes actually transferred (body, no headers)
#   t_connect        TCP connect (incl. DNS) seconds
#   t_tls            TLS handshake seconds (0 for plain http)
#   t_ttfb           time to first body byte (offset into total)
#   t_total          total wall time
#   mb_s_total       size / t_total, MB (10^6)
#   mb_s_steady      size / (t_total - t_ttfb), MB (10^6) -- excludes connect+TLS+TTFB
set -uo pipefail

label=${1:?label}
url=${2:?url}
bytes=${3:-5242880}
samples=${4:-3}
end=$((bytes - 1))

printf '{"label":"%s","url":"%s","requested_bytes":%d,"samples":[' "$label" "$url" "$bytes"
sep=""
for i in $(seq 1 "$samples"); do
  out=$(curl -sSL -r "0-$end" -o /dev/null --max-time 90 \
        -w '%{http_code} %{size_download} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{speed_download} %{remote_ip}' \
        "$url" 2>/dev/null) || out=""
  printf '%s%s' "$sep" "$(awk -v o="$out" -v n="$i" 'BEGIN{
      if (o == "") { printf "{\"run\":%d,\"error\":\"curl-failed\"}", n; exit }
      split(o, a, " ");
      code=a[1]; size=a[2]+0; tc=a[3]+0; tls=a[4]+0; ttfb=a[5]+0; tot=a[6]+0; srv=a[7]+0; ip=a[8];
      steady = (tot > ttfb) ? size / (tot - ttfb) : 0;
      printf "{\"run\":%d,\"http_code\":%s,\"size_download\":%d,\"t_connect_s\":%.4f,\"t_tls_s\":%.4f,\"t_ttfb_s\":%.4f,\"t_total_s\":%.4f,\"mb_s_total\":%.3f,\"mb_s_steady\":%.3f,\"curl_reported_b_s\":%.0f,\"remote_ip\":\"%s\"}",
             n, code, size, tc, (tls>0 ? tls-tc : 0), ttfb, tot, size/1000000/tot, steady/1000000, srv, ip;
    }')"
  sep=","
done
printf ']}\n'
