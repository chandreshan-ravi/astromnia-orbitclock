"""Storage: the calibration in use, the setup values, every saved reading and the recycle bin.

Everything is kept as plain files in the data folder (ORBITCLOCK_DATA_DIR on a host). Every write is atomic and
notifies the listeners registered with on_change(), which take a backup snapshot (see backup.py).
Deleting a reading moves it to deleted_readings.csv, from where it can be restored.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
COLUMNS = ["reading_id", "crew_id", "mission_phase", "sampled_at", "status", "saliva_pg_ml", "saliva_conc", "tube_conc",
           "conc_unit", "ci95_tube", "reference_flag", "peak_potential_V", "peak_current", "current_unit",
           "dilution_factor", "lod_tube", "loq_tube", "calibration_file", "sample_file", "data_origin", "notes", "entered_by"]
DELETED_COLUMNS = COLUMNS + ["deleted_at", "deleted_by"]
_listeners: list = []


def on_change(fn) -> None:
    """Register fn(reason) to run after every change to the stored data."""
    _listeners.append(fn)


def notify(reason: str) -> None:
    for fn in list(_listeners):
        try:
            fn(reason)
        except Exception:  # a failing backup must never break saving
            pass


def _atomic(path: Path, data: bytes) -> None:
    """Write via a temporary file and rename, so a crash never leaves a half-written file."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _dir(data_dir: Path | None) -> Path:
    d = Path(data_dir) if data_dir else DATA_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_settings(data_dir=None) -> dict:
    f = _dir(data_dir) / "settings.json"
    try:
        return json.loads(f.read_text()) if f.exists() else {}
    except json.JSONDecodeError:
        return {}


def save_settings(settings: dict, data_dir=None) -> None:
    _atomic(_dir(data_dir) / "settings.json", json.dumps(settings, indent=2).encode())
    notify("settings")


def save_calibration(data: bytes, name: str, data_dir=None) -> None:
    d = _dir(data_dir)
    _atomic(d / "calibration.csv", data)
    _atomic(d / "calibration_name.txt", name.encode())
    notify("calibration")


def load_calibration(data_dir=None) -> tuple[bytes | None, str | None]:
    d = _dir(data_dir)
    f = d / "calibration.csv"
    if not f.exists():
        return None, None
    name = (d / "calibration_name.txt").read_text() if (d / "calibration_name.txt").exists() else "calibration.csv"
    return f.read_bytes(), name


def clear_calibration(data_dir=None) -> None:
    for n in ("calibration.csv", "calibration_name.txt"):
        (_dir(data_dir) / n).unlink(missing_ok=True)
    notify("calibration-removed")


def _load(name: str, cols: list, data_dir) -> pd.DataFrame:
    f = _dir(data_dir) / name
    if not f.exists() or f.stat().st_size == 0:
        return pd.DataFrame(columns=cols)
    df = pd.read_csv(f)
    for c in cols:
        if c not in df.columns:
            df[c] = None
    df["sampled_at"] = pd.to_datetime(df["sampled_at"], errors="coerce", format="ISO8601")
    return df[cols]


def load_readings(data_dir=None) -> pd.DataFrame:
    return _load("readings.csv", COLUMNS, data_dir)


def load_deleted(data_dir=None) -> pd.DataFrame:
    return _load("deleted_readings.csv", DELETED_COLUMNS, data_dir)


def _write(df: pd.DataFrame, data_dir, name: str = "readings.csv") -> None:
    out = df.copy()
    out["sampled_at"] = pd.to_datetime(out["sampled_at"], errors="coerce", format="ISO8601").dt.strftime("%Y-%m-%dT%H:%M")
    _atomic(_dir(data_dir) / name, out.to_csv(index=False).encode())


def _next_id(data_dir) -> int:
    ids = pd.concat([load_readings(data_dir)["reading_id"], load_deleted(data_dir)["reading_id"]]).dropna()
    return int(ids.max()) + 1 if len(ids) else 1   # ids of deleted readings are never reused, so restoring is safe


def add_reading(reading: dict, data_dir=None) -> int:
    df = load_readings(data_dir)
    reading = dict(reading, reading_id=_next_id(data_dir))
    row = pd.DataFrame([{c: reading.get(c) for c in COLUMNS}])
    out = row if df.empty else pd.concat([df, row], ignore_index=True)
    _write(out, data_dir)
    notify("reading-saved")
    return reading["reading_id"]


def delete_reading(reading_id: int, data_dir=None, deleted_by: str | None = None) -> bool:
    """Move a reading to the recycle bin (deleted_readings.csv). Returns False if it does not exist."""
    df = load_readings(data_dir)
    row = df[df["reading_id"] == reading_id]
    if row.empty:
        return False
    row = row.assign(deleted_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), deleted_by=deleted_by)
    bin_ = load_deleted(data_dir)
    _write(row if bin_.empty else pd.concat([bin_, row], ignore_index=True), data_dir, "deleted_readings.csv")
    _write(df[df["reading_id"] != reading_id], data_dir)
    notify("reading-deleted")
    return True


def restore_reading(reading_id: int, data_dir=None) -> bool:
    bin_ = load_deleted(data_dir)
    row = bin_[bin_["reading_id"] == reading_id]
    if row.empty:
        return False
    df = load_readings(data_dir)
    back = row[COLUMNS]
    _write(back if df.empty else pd.concat([df, back], ignore_index=True), data_dir)
    _write(bin_[bin_["reading_id"] != reading_id], data_dir, "deleted_readings.csv")
    notify("reading-restored")
    return True


def purge_reading(reading_id: int, data_dir=None) -> bool:
    """Remove a reading from the recycle bin for good (it stays in earlier backup snapshots)."""
    bin_ = load_deleted(data_dir)
    if bin_[bin_["reading_id"] == reading_id].empty:
        return False
    _write(bin_[bin_["reading_id"] != reading_id], data_dir, "deleted_readings.csv")
    notify("reading-purged")
    return True
