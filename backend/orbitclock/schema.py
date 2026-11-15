"""Input format: validation and loading of sample and sleep-log tables.

This is the plug-in point for any sensor. Whatever produces a reading (lab ELISA,
dried-saliva card analysed after return, an on-board strip reader, a future
electrode) only has to write rows in this format, including its own LOQ.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

SAMPLE_COLUMNS = {
    "astronaut_id": "Crew member identifier (use a code, not a name)",
    "timestamp": "Sample time, ISO 8601, mission clock",
    "mission_day": "Days since launch. Launch day = 0, negative = pre-flight. A sample taken after midnight belongs to the waking day it closes",
    "mission_phase": "preflight | inflight | postflight",
    "analyte": "melatonin | cortisol",
    "value": "Concentration. Leave empty when below the LOQ",
    "unit": "pg/mL for melatonin, nmol/L for cortisol",
    "loq": "Limit of quantification of the method that produced this reading, same unit",
    "method": "Free text: elisa, dried_saliva, cl_lfia, spce_dpv ...",
}
OPTIONAL_SAMPLE_COLUMNS = {
    "below_loq": "true/false. Derived from value and loq when missing",
    "day_label": "Display label such as L-7, FD13, R+1",
    "light_lux": "Light at eye level during a melatonin sample. Used for the dim-light check",
}
SLEEP_COLUMNS = {
    "astronaut_id": "Crew member identifier",
    "mission_day": "Days since launch",
    "wake_time": "Wake time on that day, ISO 8601",
    "sleep_onset": "Sleep onset at the end of that day, ISO 8601",
}
UNITS = {"melatonin": "pg/mL", "cortisol": "nmol/L"}
PHASES = ("preflight", "inflight", "postflight")


class SchemaError(ValueError):
    pass


def load_samples(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [c.strip().lower() for c in df.columns]
    missing = [c for c in SAMPLE_COLUMNS if c not in df.columns]
    if missing:
        raise SchemaError(f"Samples table is missing columns: {', '.join(missing)}")
    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    if df["timestamp"].isna().any():
        raise SchemaError("Some timestamps could not be read. Use ISO 8601, e.g. 2027-03-03 21:30:00")
    df["analyte"] = df["analyte"].astype(str).str.strip().str.lower()
    bad = sorted(set(df["analyte"]) - set(UNITS))
    if bad:
        raise SchemaError(f"Unknown analyte(s): {bad}. Allowed: melatonin, cortisol")
    df["mission_phase"] = df["mission_phase"].astype(str).str.strip().str.lower()
    bad = sorted(set(df["mission_phase"]) - set(PHASES))
    if bad:
        raise SchemaError(f"Unknown mission_phase value(s): {bad}. Allowed: {', '.join(PHASES)}")
    for analyte, unit in UNITS.items():
        got = set(df.loc[df["analyte"] == analyte, "unit"].astype(str).str.strip())
        if got - {unit}:
            raise SchemaError(f"{analyte} must be in {unit}; found {sorted(got)}. Convert before loading")
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df["loq"] = pd.to_numeric(df["loq"], errors="coerce")
    if df["loq"].isna().any():
        raise SchemaError("Every row needs a numeric loq. A reading cannot be interpreted without it")
    df["mission_day"] = pd.to_numeric(df["mission_day"], errors="raise").astype(int)
    derived = df["value"].isna() | (df["value"] < df["loq"])
    if "below_loq" in df.columns:
        flag = df["below_loq"].astype(str).str.strip().str.lower().isin(("true", "1", "yes"))
        df["below_loq"] = flag | derived
    else:
        df["below_loq"] = derived
    df.loc[df["below_loq"], "value"] = np.nan
    if "day_label" not in df.columns:
        df["day_label"] = df["mission_day"].map(lambda d: f"Day {d:+d}")
    if "light_lux" not in df.columns:
        df["light_lux"] = np.nan
    df["light_lux"] = pd.to_numeric(df["light_lux"], errors="coerce")
    df["astronaut_id"] = df["astronaut_id"].astype(str)
    return df.sort_values(["astronaut_id", "timestamp"]).reset_index(drop=True)


def load_sleep_log(df: pd.DataFrame | None) -> pd.DataFrame:
    if df is None or len(df) == 0:
        return pd.DataFrame(columns=list(SLEEP_COLUMNS))
    df = df.copy()
    df.columns = [c.strip().lower() for c in df.columns]
    missing = [c for c in SLEEP_COLUMNS if c not in df.columns]
    if missing:
        raise SchemaError(f"Sleep log is missing columns: {', '.join(missing)}")
    for c in ("wake_time", "sleep_onset"):
        df[c] = pd.to_datetime(df[c], errors="coerce")
    df["mission_day"] = pd.to_numeric(df["mission_day"], errors="raise").astype(int)
    df["astronaut_id"] = df["astronaut_id"].astype(str)
    return df
