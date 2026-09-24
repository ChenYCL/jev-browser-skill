#!/usr/bin/env python3
"""Resumable, verified fetcher that materialises a HuggingFace model repo into the
documented HF cache layout, using curl as the transfer engine.

Why not `hf download`: on this link the hf_hub/xet client stalled (5-40 kB/s retry
loops) while plain ranged HTTP GETs against the same CDN hold ~1.2-1.9 MB/s. curl
also beats the node engine 2-3x. So: curl transfers the bytes, this script owns the
resume + verification, and it writes exactly the names hf_hub itself uses
(blobs/<lfs sha256> for LFS files, blobs/<git blob oid> for the rest) plus
trees/<commit>.json, refs/main and snapshots/<commit>/<file> symlinks -- so the
unmodified `kev.serve --run <repo>` resolution path accepts the cache.

usage:
  fetch.py jaredpalmer/kev-4b [jaredpalmer/kev-4b@<rev>] [--host https://huggingface.co]
                              [--abort-mbps 0.3] [--log FILE] [--list]
"""
import argparse, hashlib, json, os, subprocess, sys, threading, time, urllib.request
from urllib.parse import quote
from fnmatch import fnmatch
from pathlib import Path

CACHE = Path.home() / ".cache/huggingface/hub"
UA = "kev-4b-fetch/1"


def api(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def repo_dir(repo):
    return CACHE / ("models--" + repo.replace("/", "--"))


def git_blob_oid(path):
    h = hashlib.sha1()
    size = os.path.getsize(path)
    h.update(b"blob %d\0" % size)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify(path, entry):
    """Return (ok, how, want, got). LFS files carry sha256; small files are git blobs."""
    if not path.exists():
        return False, "missing", None, None
    size = os.path.getsize(path)
    if size != entry["size"]:
        return False, "size", entry["size"], size
    if entry.get("lfs_sha256"):
        got = sha256(path)
        return got == entry["lfs_sha256"], "sha256", entry["lfs_sha256"], got
    got = git_blob_oid(path)
    return got == entry["blob_id"], "git-blob-sha1", entry["blob_id"], got


def build_tree(repo, rev, host):
    """File list from the Hub tree API, reshaped into hf_hub's trees/<rev>.json format."""
    url = f"{host}/api/models/{repo}/tree/{rev}?recursive=true&expand=true"
    entries = api(url)
    files = {}
    for e in entries:
        if e.get("type") != "file":
            continue
        rec = {"size": e["size"], "blob_id": e["oid"] if "oid" in e else e["blobId"]}
        if e.get("lfs"):
            lfs = e["lfs"]
            rec["lfs_sha256"] = lfs.get("oid") or lfs.get("sha256")   # the tree API names it `oid`
            rec["lfs_size"] = lfs.get("size", e["size"])
        if e.get("xetHash"):
            rec["xet_hash"] = e["xetHash"]
        files[e["path"]] = rec
    return files


def resolve_url(source, host, repo, commit, name):
    """Bytes come from whichever mirror measured fastest; names + hashes always come from
    the Hub tree, so the cache layout and the verification stay source-independent."""
    if source == "modelscope":
        return f"https://modelscope.cn/api/v1/models/{repo}/repo?Revision=master&FilePath={quote(name)}"
    return f"{host}/{repo}/resolve/{commit}/{name}"


class Monitor(threading.Thread):
    """Rolling average of bytes actually on disk; aborts the transfer under --abort-mbps.

    Counts already-present bytes plus the live size of every `.incomplete` part this run is
    writing, so a fresh download is measured while it happens rather than after it lands.
    """

    def __init__(self, log, abort_mbps, grace=240.0, window=600.0, period=20.0):
        super().__init__(daemon=True)
        self.log, self.abort_mbps, self.grace, self.window, self.period = log, abort_mbps, grace, window, period
        self.samples = []           # (t, total_bytes)
        self.done_bytes = 0
        self.parts = {}             # Path -> None, live downloads
        self.stop_flag = threading.Event()
        self.aborted = False

    def bump(self, n):
        """Record bytes that are already verified and on disk."""
        self.done_bytes += n

    def watch(self, part):
        self.parts[part] = None

    def unwatch(self, part, size):
        self.parts.pop(part, None)
        self.done_bytes += size

    def total(self):
        t = self.done_bytes
        for p in list(self.parts):
            try:
                t += p.stat().st_size
            except OSError:
                pass
        return t

    def run(self):
        started = time.time()
        while not self.stop_flag.wait(self.period):
            now = time.time()
            total = self.total()
            self.samples.append((now, total))
            self.samples = [s for s in self.samples if now - s[0] <= self.window]
            if now - started < self.grace or len(self.samples) < 2:
                continue
            t0, b0 = self.samples[0]
            dt = now - t0
            mbps = (total - b0) / dt / 1e6 if dt > 0 else 0.0
            line = (f"[monitor] t+{now - started:6.0f}s total={total/1e6:9.1f} MB "
                    f"rolling {dt/60:.1f} min = {mbps:.3f} MB/s")
            print(line, flush=True)
            self.log.write(line + "\n"); self.log.flush()
            if mbps < self.abort_mbps:
                self.aborted = True
                msg = f"[monitor] ABORT: rolling average {mbps:.3f} MB/s < {self.abort_mbps} MB/s"
                print(msg, flush=True); self.log.write(msg + "\n"); self.log.flush()
                return


def fetch_file(url, target, monitor, log):
    part = target.with_name(target.name + ".incomplete")
    args = ["curl", "-sS", "-L", "-C", "-", "-o", str(part), "--connect-timeout", "20",
            "--retry", "6", "--retry-delay", "3", "--retry-all-errors",
            "-H", f"User-Agent: {UA}", "-w", "%{http_code} %{size_download}"]
    log.write(f"[curl] {' '.join(args)} {url}\n"); log.flush()
    monitor.watch(part)
    p = subprocess.Popen(args + [url], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    # curl prints progress only at the end, so watch the file size instead of stdout
    while p.poll() is None:
        if monitor.aborted:
            p.terminate()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
            return False, "aborted by monitor"
        time.sleep(1.0)
    out, err = p.communicate()
    code, _, rest = out.strip().partition(" ")
    log.write(f"[curl] exit={p.returncode} http={code} bytes={rest.strip()} err={err.strip()[:200]}\n"); log.flush()
    if p.returncode != 0:
        return False, f"curl exit {p.returncode}: {err.strip()[:200]}"
    if not part.exists():
        monitor.unwatch(part, 0)
        return False, f"curl reported success but {part.name} is absent"
    os.replace(part, target)
    monitor.unwatch(part, target.stat().st_size)
    return True, code


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("repo", help="owner/name[@revision]")
    ap.add_argument("--host", default="https://huggingface.co")
    ap.add_argument("--source", choices=["hf", "modelscope"], default="hf",
                    help="where the bytes come from (metadata + naming always come from the Hub tree)")
    ap.add_argument("--abort-mbps", type=float, default=0.3)
    ap.add_argument("--only", default=None, help="fnmatch pattern; fetch only matching files (for parallel shard pulls)")
    ap.add_argument("--skip", default=None, help="fnmatch pattern of files to ignore")
    ap.add_argument("--log", default=None)
    ap.add_argument("--list", action="store_true", help="print the resolved file list and exit")
    a = ap.parse_args()

    repo, _, rev = a.repo.partition("@")
    info = api(f"{a.host}/api/models/{repo}")
    commit = rev or info["sha"]
    d = repo_dir(repo)
    logpath = Path(a.log) if a.log else Path(f"/tmp/kev-4b-fetch-{repo.replace('/', '--')}.log")
    log = open(logpath, "a")

    all_files = build_tree(repo, commit, a.host)
    files = all_files
    if a.only:
        files = {n: r for n, r in files.items() if fnmatch(n, a.only)}
    if a.skip:
        files = {n: r for n, r in files.items() if not fnmatch(n, a.skip)}
    trees = d / "trees"; trees.mkdir(parents=True, exist_ok=True)
    (trees / f"{commit}.json").write_text(json.dumps({"format_version": 1, "files": all_files}, indent=1))
    (d / "refs").mkdir(exist_ok=True)
    (d / "refs" / "main").write_text(commit)
    (d / "blobs").mkdir(exist_ok=True)

    total_bytes = sum(f["size"] for f in files.values())
    print(f"repo={repo} commit={commit} files={len(files)} total={total_bytes/1e6:.1f} MB -> {d}")

    if a.list:
        for name, rec in files.items():
            blob = rec.get("lfs_sha256") or rec["blob_id"]
            print(f"  {name:<40} {rec['size']:>13,}  blob={blob}")
        return 0

    monitor = Monitor(log, a.abort_mbps)
    monitor.start()

    # ---- pass 1: what is already good ------------------------------------------
    plan = []
    for name, rec in sorted(files.items()):
        blob = rec.get("lfs_sha256") or rec["blob_id"]
        target = d / "blobs" / blob
        ok, how, want, got = verify(target, rec) if target.exists() else (False, "missing", None, None)
        if ok:
            print(f"  have   {name}")
            monitor.bump(rec["size"])
        else:
            print(f"  need   {name} ({rec['size']:,} B, {how})")
            plan.append((name, rec, blob, target))

    # ---- pass 2: transfer ------------------------------------------------------
    t0 = time.time()
    for name, rec, blob, target in plan:
        url = resolve_url(a.source, a.host, repo, commit, name)
        print(f"  get    {name} ({rec['size']/1e6:.1f} MB)  <- {a.source}", flush=True)
        t_file = time.time()
        ok, note = fetch_file(url, target, monitor, log)
        if not ok:
            print(f"  FAIL   {name}: {note}")
            return 2
        ok, how, want, got = verify(target, rec)
        if not ok:
            print(f"  FAIL   {name}: verification {how} want={want} got={got}")
            log.write(f"[verify] FAIL {name} {how} want={want} got={got}\n"); log.flush()
            return 3
        dt = max(time.time() - t_file, 1e-9)
        print(f"  rate   {name} {rec['size']/1e6/dt:.3f} MB/s")
        for stale in target.parent.glob(blob + "*"):     # any older partial naming from hf_hub
            if stale != target and stale.name.endswith(".incomplete"):
                stale.unlink()
        print(f"  ok     {name}  ({how} verified)")
        log.write(f"[verify] ok {name} {how}={want}\n"); log.flush()

    monitor.stop_flag.set()
    elapsed = time.time() - t0
    # ---- pass 3: snapshots + full verification table ---------------------------
    snap = d / "snapshots" / commit
    snap.mkdir(parents=True, exist_ok=True)
    rows = []
    for name, rec in sorted(files.items()):        # this pass's files; a full run covers the repo
        blob = rec.get("lfs_sha256") or rec["blob_id"]
        target = d / "blobs" / blob
        ok, how, want, got = verify(target, rec)
        link = snap / name
        if link.is_symlink() or link.exists():
            link.unlink()
        os.symlink(os.path.relpath(target, snap), link)
        rows.append({"file": name, "bytes": rec["size"], "ok": ok, "check": how, "expected": want, "actual": got})
        if not ok:
            print(f"  BAD    {name} {how} {want} != {got}")

    absent = [n for n, r in all_files.items()
              if not (d / "blobs" / (r.get("lfs_sha256") or r["blob_id"])).exists()]
    if absent:
        print(f"  note: {len(absent)} repo file(s) not yet in the cache: {', '.join(absent[:4])}")

    planned_bytes = sum(p[1]["size"] for p in plan)
    summary = {"repo": repo, "commit": commit, "cache_dir": str(d), "snapshot": str(snap),
               "files_in_repo": len(all_files), "repo_bytes": total_bytes,
               "fetched_files": len(plan), "fetched_bytes": planned_bytes,
               "seconds": round(elapsed, 1),
               "MBps": round(planned_bytes / 1e6 / max(elapsed, 1e-9), 3),
               "verified_this_pass": all(r["ok"] for r in rows),
               "absent_from_cache": absent, "rows": rows}
    out = Path(f"/tmp/kev-4b-fetch-{repo.replace('/', '--')}-summary.json")
    out.write_text(json.dumps(summary, indent=1))
    print(f"\nverified_this_pass={summary['verified_this_pass']} snapshot={snap} summary={out}")
    return 0 if summary["verified_this_pass"] else 4


if __name__ == "__main__":
    sys.exit(main())
