"""Local storage: the calibration in use, the setup values, and every saved reading.

Everything is kept as plain files in the app's data/ folder on this computer.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
COLUMNS = ["reading_id", "crew_id", "mission_phase", "sampled_at", "status", "saliva_pg_ml", "saliva_conc", "tube_conc",
           "conc_unit", "ci95_tube", "reference_flag", "peak_potential_V", "peak_current", "current_unit",
           "dilution_factor", "lod_tube", "loq_tube", "calibration_file", "sample_file", "data_origin", "notes", "entered_by"]


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


def save_calibration(data: bytes, name: str, data_dir=None) -> None:
    d = _dir(data_dir)
    _atomic(d / "calibration.csv", data)
    _atomic(d / "calibration_name.txt", name.encode())


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


def load_readings(data_dir=None) -> pd.DataFrame:
    f = _dir(data_dir) / "readings.csv"
    if not f.exists():
        return pd.DataFrame(columns=COLUMNS)
    df = pd.read_csv(f)
    for c in COLUMNS:
        if c not in df.columns:
            df[c] = None
    df["sampled_at"] = pd.to_datetime(df["sampled_at"], errors="coerce", format="ISO8601")
    return df[COLUMNS]


def _write(df: pd.DataFrame, data_dir) -> None:
    out = df.copy()
    out["sampled_at"] = pd.to_datetime(out["sampled_at"], errors="coerce", format="ISO8601").dt.strftime("%Y-%m-%dT%H:%M")
    _atomic(_dir(data_dir) / "readings.csv", out.to_csv(index=False).encode())


def add_reading(reading: dict, data_dir=None) -> int:
    df = load_readings(data_dir)
    reading = dict(reading, reading_id=int(df["reading_id"].max()) + 1 if len(df) else 1)
    row = pd.DataFrame([{c: reading.get(c) for c in COLUMNS}])
    out = row if df.empty else pd.concat([df, row], ignore_index=True)
    _write(out, data_dir)
    return reading["reading_id"]


def delete_reading(reading_id: int, data_dir=None) -> None:
    df = load_readings(data_dir)
    _write(df[df["reading_id"] != reading_id], data_dir)
