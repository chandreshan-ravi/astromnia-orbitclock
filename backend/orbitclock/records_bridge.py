"""Turn saved Records readings into the engine's sample format, so real measurements get the
same body-clock analysis as the simulated mission.

Each saved reading becomes one melatonin sample, valued in undiluted saliva (pg/mL) with the
LOQ in saliva that applied when it was measured. Readings taken after midnight and before noon
belong to the previous evening's series.
"""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

from .analysis import ABOVE_RANGE, to_pg_per_ml

PHASE_MAP = {"Pre-flight": "preflight", "In-flight": "inflight", "Post-flight": "postflight"}


def records_to_samples(readings: pd.DataFrame, launch: date) -> tuple[pd.DataFrame, int]:
    """Returns (samples in the engine format, number of readings skipped)."""
    if readings.empty:
        return pd.DataFrame(), 0
    r = readings.copy()
    r["sampled_at"] = pd.to_datetime(r["sampled_at"], errors="coerce")
    keep = r["sampled_at"].notna() & r["mission_phase"].isin(PHASE_MAP) & (r["status"] != ABOVE_RANGE)
    skipped = int((~keep).sum())
    r = r[keep]
    if r.empty:
        return pd.DataFrame(), skipped
    evening = (r["sampled_at"] - pd.Timedelta(hours=12)).dt.normalize()
    r["mission_day"] = (evening - pd.Timestamp(launch)).dt.days.astype(int)
    loq = [to_pg_per_ml(float(a) * float(f), u) if pd.notna(a) and pd.notna(f) else np.nan
           for a, f, u in zip(r["loq_tube"], r["dilution_factor"], r["conc_unit"])]
    samples = pd.DataFrame(dict(
        astronaut_id=r["crew_id"].astype(str), timestamp=r["sampled_at"], mission_day=r["mission_day"],
        mission_phase=r["mission_phase"].map(PHASE_MAP), analyte="melatonin",
        value=pd.to_numeric(r["saliva_pg_ml"], errors="coerce"), unit="pg/mL", loq=loq, method="aptasensor_dpv",
        day_label=[f"L{d}" if d < 0 else f"Day {d}" for d in r["mission_day"]],
    ))
    bad_loq = samples["loq"].isna()
    return samples[~bad_loq].reset_index(drop=True), skipped + int(bad_loq.sum())
