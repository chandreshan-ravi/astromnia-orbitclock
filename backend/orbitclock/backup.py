"""Backups, so saved data survives mistakes, redeploys and a wiped server.

Two layers, both automatic after every change to the stored data:

1. Snapshots: a zip of all data files in <data>/backups/, newest 100 kept. The coordinator can download any of them
   or restore one in Settings (restoring first snapshots the current state, so a restore can itself be undone).
2. Off-site copy (optional): when BACKUP_GITHUB_TOKEN and BACKUP_GITHUB_REPO are set, the data files are pushed to
   a branch of a GitHub repository (default branch "data-backup", folder "live-data/") about 20 s after the last
   change. When the server starts with an empty data folder (for example a host without a persistent disk), it
   restores from that branch before falling back to the seed data.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from . import store

DATA_FILES = ["readings.csv", "deleted_readings.csv", "settings.json", "calibration.csv", "calibration_name.txt",
              "feedback.csv"]
KEEP = 100
GH_TOKEN = os.environ.get("BACKUP_GITHUB_TOKEN", "").strip()
GH_REPO = os.environ.get("BACKUP_GITHUB_REPO", "").strip()
GH_BRANCH = os.environ.get("BACKUP_GITHUB_BRANCH", "data-backup").strip() or "data-backup"
GH_DIR = "live-data"
_lock = threading.Lock()
_timers: dict[str, threading.Timer] = {}
offsite = dict(enabled=bool(GH_TOKEN and GH_REPO), repo=GH_REPO, branch=GH_BRANCH, last_ok=None, last_error=None)

try:
    import certifi
    _SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # pragma: no cover
    _SSL = ssl.create_default_context()


def _data() -> Path:
    d = Path(store.DATA_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _backups() -> Path:
    b = _data() / "backups"
    b.mkdir(exist_ok=True)
    return b


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _count(name: str) -> int:
    f = _data() / name
    try:
        return len(pd.read_csv(f)) if f.exists() and f.stat().st_size else 0
    except Exception:
        return 0


# ----------------------------------------------------------------------------- snapshots
def current_zip(reason: str = "download") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n in DATA_FILES:
            f = _data() / n
            if f.exists():
                z.write(f, n)
        z.writestr("manifest.json", json.dumps(dict(created=_now(), reason=reason, readings=_count("readings.csv"),
                                                    deleted=_count("deleted_readings.csv"), app="Astromnia OrbitClock")))
    return buf.getvalue()


def _content_hash() -> str:
    h = hashlib.sha256()
    for n in DATA_FILES:
        f = _data() / n
        h.update(n.encode() + (f.read_bytes() if f.exists() else b"\0missing"))
    return h.hexdigest()


def snapshot(reason: str) -> str | None:
    """Zip the data files into backups/. Skips if nothing changed since the newest snapshot."""
    with _lock:
        digest = _content_hash()
        marker = _backups() / ".last_hash"
        if marker.exists() and marker.read_text() == digest:
            return None
        name = f"{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}_{''.join(c for c in reason if c.isalnum() or c in '-_')[:40]}.zip"
        (_backups() / name).write_bytes(current_zip(reason))
        marker.write_text(digest)
        for old in sorted(_backups().glob("*.zip"))[:-KEEP]:
            old.unlink(missing_ok=True)
        return name


def list_snapshots() -> list[dict]:
    out = []
    for f in sorted(_backups().glob("*.zip"), reverse=True):
        try:
            with zipfile.ZipFile(f) as z:
                m = json.loads(z.read("manifest.json"))
        except Exception:
            m = {}
        out.append(dict(name=f.name, size=f.stat().st_size, created=m.get("created"), reason=m.get("reason"),
                        readings=m.get("readings"), deleted=m.get("deleted")))
    return out


def snapshot_bytes(name: str) -> bytes | None:
    f = _backups() / Path(name).name
    return f.read_bytes() if f.suffix == ".zip" and f.exists() else None


def restore_zip(data: bytes) -> dict:
    """Replace the data files with the ones in a backup zip. The current state is snapshotted first."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = set(z.namelist())
        if not names & {"readings.csv", "settings.json"}:
            raise ValueError("This file is not an OrbitClock backup (no readings.csv or settings.json inside).")
        files = {n: z.read(n) for n in DATA_FILES if n in names}
    snapshot("before-restore")
    with _lock:
        for n in DATA_FILES:
            f = _data() / n
            if n in files:
                tmp = f.with_suffix(f.suffix + ".tmp")
                tmp.write_bytes(files[n])
                os.replace(tmp, f)
            elif n != "feedback.csv":
                f.unlink(missing_ok=True)
    store.notify("restored")
    return dict(readings=_count("readings.csv"), deleted=_count("deleted_readings.csv"))


# ----------------------------------------------------------------------------- off-site copy on GitHub
def _gh(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(f"https://api.github.com/repos/{GH_REPO}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {GH_TOKEN}", "Accept": "application/vnd.github+json",
                                          "User-Agent": "orbitclock-backup", "X-GitHub-Api-Version": "2022-11-28"})
    try:
        with urllib.request.urlopen(req, timeout=20, context=_SSL) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def _ensure_branch() -> None:
    code, _ = _gh("GET", f"/branches/{GH_BRANCH}")
    if code == 200:
        return
    code, repo = _gh("GET", "")
    if code != 200:
        raise RuntimeError(f"cannot read repository {GH_REPO} (HTTP {code})")
    code, ref = _gh("GET", f"/git/ref/heads/{repo['default_branch']}")
    code, _ = _gh("POST", "/git/refs", dict(ref=f"refs/heads/{GH_BRANCH}", sha=ref["object"]["sha"]))
    if code not in (200, 201, 422):
        raise RuntimeError(f"cannot create branch {GH_BRANCH} (HTTP {code})")


def push_offsite() -> None:
    if not offsite["enabled"]:
        return
    try:
        _ensure_branch()
        for n in DATA_FILES:
            f = _data() / n
            path = f"/contents/{GH_DIR}/{n}"
            code, cur = _gh("GET", f"{path}?ref={GH_BRANCH}")
            sha = cur.get("sha") if code == 200 and isinstance(cur, dict) else None
            if f.exists():
                content = base64.b64encode(f.read_bytes()).decode()
                if sha and isinstance(cur, dict) and cur.get("content", "").replace("\n", "") == content:
                    continue
                body = dict(message=f"Backup {n} ({_now()})", content=content, branch=GH_BRANCH, **({"sha": sha} if sha else {}))
                code, res = _gh("PUT", path, body)
                if code not in (200, 201):
                    raise RuntimeError(f"upload of {n} failed (HTTP {code}: {(res or {}).get('message')})")
            elif sha:
                _gh("DELETE", path, dict(message=f"Backup: {n} removed ({_now()})", sha=sha, branch=GH_BRANCH))
        offsite.update(last_ok=_now(), last_error=None)
    except Exception as e:  # noqa: BLE001
        offsite["last_error"] = f"{_now()}: {e}"


def restore_offsite() -> bool:
    """Download the data files from the backup branch. Used at start-up when the data folder is empty."""
    if not offsite["enabled"]:
        return False
    try:
        got = 0
        for n in DATA_FILES:
            code, cur = _gh("GET", f"/contents/{GH_DIR}/{n}?ref={GH_BRANCH}")
            if code == 200 and isinstance(cur, dict) and cur.get("content") is not None:
                (_data() / n).write_bytes(base64.b64decode(cur["content"]))
                got += 1
        if got:
            offsite["last_ok"] = _now()
        return got > 0
    except Exception as e:  # noqa: BLE001
        offsite["last_error"] = f"{_now()}: restore failed: {e}"
        return False


# ----------------------------------------------------------------------------- wiring
def _later(key: str, delay: float, fn) -> None:
    with _lock:
        if key in _timers:
            _timers[key].cancel()
        t = threading.Timer(delay, fn)
        t.daemon = True
        _timers[key] = t
        t.start()


def changed(reason: str) -> None:
    _later("snapshot", 1.5, lambda: snapshot(reason))
    if offsite["enabled"]:
        _later("offsite", 20.0, push_offsite)


def install() -> None:
    store.on_change(changed)
    snapshot("startup")
    if offsite["enabled"]:
        _later("offsite", 5.0, push_offsite)


def status() -> dict:
    return dict(snapshots=list_snapshots(), offsite=dict(offsite), readings=_count("readings.csv"),
                deleted=_count("deleted_readings.csv"), time=time.time())
