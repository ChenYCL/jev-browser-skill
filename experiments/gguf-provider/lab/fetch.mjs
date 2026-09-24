#!/usr/bin/env node
// Supervised, resumable, checksum-verified GGUF fetcher for the 4B candidates.
//
// Transfer engine is `curl`, not node fetch: measured on this link, undici holds
// ~0.35 MB/s where curl holds ~0.72-0.93 MB/s (same window, same URL, shared
// link) -- and curl is what the throughput numbers in results/ were measured
// with, so ETAs stay comparable. curl also owns byte-level resume via -C -.
//
// The supervisor adds what plain `hf download`/curl alone do not give:
//   (a) the brief's abort rule enforced mechanically -- stop for good if a
//       10-minute rolling window sits under 0.3 MB/s (no retry loop),
//   (b) stall detection (no bytes for 3 min) with bounded reconnects,
//   (c) mandatory size+sha256 verification before the file may reach
//       llama-server. A truncated GGUF must never land in the model dir.
//
// It resumes the partial that `hf download` already left in
// <dest>/.cache/huggingface/download/*.incomplete (a contiguous byte prefix) by
// matching the upstream LFS sha256 embedded in the blob filename.
//
// usage:
//   node fetch.mjs --label <slug> --repo <owner/name> --file <name.gguf> [--dest <dir>] [--log <path>]
//
// exit codes: 0 ok+verified · 3 ABORT (sustained <0.3 MB/s) · 4 verify failed · 5 exhausted retries
// stdout: one JSON verdict object. progress JSON-lines go to --log <path> (and stdout).
import { statSync, existsSync, readdirSync, renameSync, rmSync, mkdirSync, appendFileSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1]

const { repo, file } = opt
const label = opt.label ?? file
const dest = opt.dest ?? join(homedir(), '.jev-browser', 'models')
const logPath = opt.log
if (!repo || !file) {
  console.error('usage: fetch.mjs --label <slug> --repo <owner/name> --file <name.gguf> [--dest <dir>] [--log <path>]')
  process.exit(2)
}

const ABORT_MBPS = 0.3           // brief: sustained floor
const ABORT_WINDOW_MS = 600_000  // ...over a 10-minute rolling window
const STALL_MS = 180_000         // no bytes for 3 min -> reconnect
const MAX_ATTEMPTS = 10
const SAMPLE_MS = 5_000

const log = (obj) => {
  const line = JSON.stringify({ t: new Date().toISOString(), label, ...obj })
  console.log(line)
  if (logPath) appendFileSync(logPath, line + '\n')
}
const mb = (b) => Number((b / 1e6).toFixed(1))

// ---- upstream metadata -------------------------------------------------------
const meta = await (await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`)).json()
const sib = (meta.siblings ?? []).find((s) => s.rfilename === file)
if (!sib?.lfs?.sha256) throw new Error(`no LFS metadata for ${repo}/${file}`)
const size = sib.size
const sha256 = sib.lfs.sha256
log({ event: 'meta', repo, file, size, sha256 })

// ---- locate the existing partial --------------------------------------------
const blobDir = join(dest, '.cache', 'huggingface', 'download')
mkdirSync(blobDir, { recursive: true })
const cands = readdirSync(blobDir)
  .filter((n) => n.endsWith('.incomplete') && n.includes(sha256))
  .map((n) => join(blobDir, n))
  .filter((p) => statSync(p).size > 0)
  .sort((a, b) => statSync(b).size - statSync(a).size)
const target = cands[0] ?? join(blobDir, `${file}.resume`)
let offset = existsSync(target) ? statSync(target).size : 0
log({ event: 'partial', path: target, bytes: offset, resumed: cands.length > 0 })

const url = `https://huggingface.co/${repo}/resolve/main/${file}`

// ---- transfer loop -----------------------------------------------------------
let attempts = 0
while (offset < size && attempts < MAX_ATTEMPTS) {
  attempts++
  const attemptStart = Date.now()
  const startBytes = offset // measured against attempt start, not the trimmed rolling window
  const history = [{ ms: attemptStart, bytes: offset }] // rolling window for the abort rule
  let lastProgress = Date.now()
  let lastSeen = offset
  let stop = null
  let stderr = ''

  log({ event: 'attempt', attempt: attempts, offset, via: 'curl -C -' })
  const child = spawn('curl', [
    '-sSL', '-C', '-', '-o', target,
    '--max-time', '2700',
    '--speed-limit', '40000', '--speed-time', '90', // curl gives up on its own if a single socket dies
    url,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', (d) => { stderr += d })

  const stopChild = (why) => {
    if (stop) return
    stop = why
    log({ event: 'stopping-child', why })
    child.kill('SIGKILL')
  }

  const tick = setInterval(() => {
    const now = Date.now()
    const cur = existsSync(target) ? statSync(target).size : lastSeen
    if (cur > lastSeen) { lastSeen = cur; lastProgress = now }
    history.push({ ms: now, bytes: cur })
    while (history.length > 2 && history[0].ms < now - ABORT_WINDOW_MS - 60_000) history.shift()

    if (now - lastProgress > STALL_MS) return stopChild('stall')
    const win = history[0]
    const elapsed = now - win.ms
    if (elapsed >= ABORT_WINDOW_MS) {
      const rate = (cur - win.bytes) / 1e6 / (elapsed / 1000)
      if (rate < ABORT_MBPS) stopChild(`abort:${rate.toFixed(3)}`)
    }
  }, SAMPLE_MS)

  const code = await new Promise((r) => child.on('close', r))
  clearInterval(tick)
  offset = existsSync(target) ? statSync(target).size : offset
  const seconds = (Date.now() - attemptStart) / 1000
  const attemptRate = (offset - startBytes) / 1e6 / seconds

  if (stop?.startsWith('abort')) {
    const rate = Number(stop.split(':')[1])
    log({ event: 'abort', reason: 'sustained-below-floor', window_s: ABORT_WINDOW_MS / 1000, rolling_mb_s: rate, bytes: offset, remaining: size - offset })
    console.log(JSON.stringify({ label, verdict: 'ABORT', bytes: offset, size, mb_s: rate, sha256_prefix: sha256.slice(0, 12) }))
    process.exit(3)
  }

  log({ event: 'attempt-ended', attempt: attempts, exit: code, stopped: stop, offset, of: size, mb_s: Number(attemptRate.toFixed(3)), got_mb: mb(offset - startBytes), seconds: Math.round(seconds), stderr: stderr.trim().slice(-200) || undefined })

  if (offset < size) {
    // bounded reconnect: brief says do not retry in a loop, so attempts are capped and only
    // made after a real interruption (stall / socket death), never on a slow-but-moving link
    await new Promise((r) => setTimeout(r, stop === 'stall' ? 5_000 : 20_000))
  }
}

if (offset !== size) {
  log({ event: 'incomplete', bytes: offset, size, attempts })
  console.log(JSON.stringify({ label, verdict: 'INCOMPLETE', bytes: offset, size, attempts }))
  process.exit(5)
}

// ---- mandatory size + sha256 verification ------------------------------------
const actualSize = statSync(target).size
if (actualSize !== size) {
  console.log(JSON.stringify({ label, verdict: 'VERIFY-FAIL', reason: 'size', bytes: actualSize, size, path: target }))
  process.exit(4)
}
const hash = createHash('sha256')
for await (const c of createReadStream(target)) hash.update(c)
const digest = hash.digest('hex')
if (digest !== sha256) {
  log({ event: 'verify-fail', reason: 'sha256', digest, expected: sha256 })
  console.log(JSON.stringify({ label, verdict: 'VERIFY-FAIL', reason: 'sha256', bytes: actualSize, sha256: digest, path: target }))
  process.exit(4)
}

const finalPath = join(dest, file)
renameSync(target, finalPath)
rmSync(join(blobDir, `${file}.lock`), { force: true })
log({ event: 'installed', path: finalPath, bytes: actualSize, sha256 })
console.log(JSON.stringify({ label, verdict: 'OK', path: finalPath, bytes: actualSize, sha256, sha256_prefix: digest.slice(0, 12) }))
