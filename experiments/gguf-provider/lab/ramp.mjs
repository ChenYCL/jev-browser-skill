#!/usr/bin/env node
// Sampled transfer-rate ramp probe.
//
// Fetches a bounded byte range and records the instantaneous rate over each
// sampling interval, so a uniformly slow link can be told apart from a fast one
// that merely starts slow (TCP slow start / CDN burst throttling). A single
// short window cannot distinguish the two; this can.
//
// usage: node ramp.mjs <label> <url> [rangeBytes] [intervalMs] [maxSeconds]
//
// stdout: one JSON object -- { label, url, requested_bytes, http_code,
//   size_download, t_total_s, samples:[{t_s, cumulative_mb, interval_mb_s}],
//   mb_s_overall, mb_s_first10, mb_s_last10 }
import { spawn } from 'node:child_process'
import { statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [label, url] = process.argv.slice(2)
const bytes = Number(process.argv[4] ?? 20971520) // 20 MiB
const intervalMs = Number(process.argv[5] ?? 1000)
const maxSeconds = Number(process.argv[6] ?? 150)
if (!label || !url) {
  console.error('usage: ramp.mjs <label> <url> [rangeBytes] [intervalMs] [maxSeconds]')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'jev-ramp-'))
const out = join(dir, 'range.bin')
const t0 = Date.now()

const curl = spawn('curl', [
  '-sSL', '-r', `0-${bytes - 1}`, '-o', out, '--max-time', String(maxSeconds),
  '-w', '%{http_code} %{size_download}', url,
])
let tail = ''
curl.stdout.on('data', (d) => { tail += d })
curl.stderr.resume()

const sizeOf = () => { try { return statSync(out).size } catch { return 0 } }
const samples = []
let prevBytes = 0
let prevT = 0
const timer = setInterval(() => {
  const t = (Date.now() - t0) / 1000
  const cur = sizeOf()
  samples.push({
    t_s: Number(t.toFixed(2)),
    cumulative_mb: Number((cur / 1e6).toFixed(2)),
    interval_mb_s: Number(((cur - prevBytes) / 1e6 / (t - prevT)).toFixed(3)),
  })
  prevBytes = cur
  prevT = t
}, intervalMs)

const windowRate = (a, b) => {
  const inWindow = samples.filter((s) => s.t_s >= a && s.t_s <= b)
  if (inWindow.length < 2) return null
  const first = inWindow[0]
  const last = inWindow[inWindow.length - 1]
  const dt = last.t_s - first.t_s
  return dt > 0 ? Number(((last.cumulative_mb - first.cumulative_mb) / dt).toFixed(3)) : null
}

curl.on('close', () => {
  clearInterval(timer)
  const tTotal = (Date.now() - t0) / 1000
  const [httpCode, sizeDown] = tail.trim().split(/\s+/)
  const size = Number(sizeDown ?? sizeOf())
  console.log(JSON.stringify({
    label,
    url,
    requested_bytes: bytes,
    http_code: Number(httpCode ?? 0),
    size_download: size,
    t_total_s: Number(tTotal.toFixed(3)),
    samples,
    mb_s_overall: Number((size / 1e6 / tTotal).toFixed(3)),
    mb_s_first10: windowRate(0, 10),
    mb_s_last10: windowRate(Math.max(0, tTotal - 10), tTotal),
  }))
  rmSync(dir, { recursive: true, force: true })
})
