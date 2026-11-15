"""How sensitive must a saliva melatonin sensor be before the clock can be read?

Monte Carlo: simulate many evenings with varied melatonin output, timing and assay
noise, censor readings at a given LOQ, run the same DLMO estimator the dashboard
uses, and compare with the known true onset.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .engine import estimate_dlmo
from .simulator import DLMO_THRESHOLD, melatonin_curve

MELATONIN_G_PER_MOL = 232.28
DEFAULT_LOQS = (0.5, 1.0, 1.35, 2.0, 3.0, 4.0, 5.0, 7.0, 10.0, 15.0, 20.0, 40.0, 100.0)

# Reference points (pg/mL). Electrode figures are published detection/quantification
# limits converted from molar units; see README for sources.
REFERENCE_SENSORS = [
    ("Lab ELISA", 1.35),
    ("Best modified electrode (LOD)", 0.17e-9 * MELATONIN_G_PER_MOL * 1e9),      # 0.17 nM  -> ~39.5 pg/mL
    ("Carbon-black printed electrode (LOD)", 0.1e-6 * MELATONIN_G_PER_MOL * 1e9),  # 0.1 uM -> ~23,000
    ("Modified SPCE, DPV (LOQ)", 1.09e-6 * MELATONIN_G_PER_MOL * 1e9),            # 1.09 uM -> ~253,000
]


def run_sensitivity(loqs=DEFAULT_LOQS, n_nights: int = 400, intervals=(0.5, 1.0),
                    cv: float = 0.12, seed: int = 11) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    nights = []
    for _ in range(n_nights):
        peak = float(np.clip(rng.lognormal(np.log(18.0), 0.45), 5.0, 60.0))
        base = float(rng.uniform(0.4, 1.2))
        start = -float(rng.uniform(2.5, 5.0))   # first sample, hours relative to true onset
        nights.append((peak, base, start))
    rows = []
    for interval in intervals:
        errs = {loq: [] for loq in loqs}
        for peak, base, start in nights:
            t = np.arange(start, start + 7.0 + 1e-9, interval)
            true = melatonin_curve(t, peak, base)
            obs = np.clip(true * (1 + rng.normal(0, cv, t.shape)) + rng.normal(0, 0.15, t.shape), 0, None)
            for loq in loqs:
                below = obs < loq
                res = estimate_dlmo(t, np.where(below, np.nan, obs), below, loq, n_boot=0)
                errs[loq].append(res["dlmo_h"] if res["status"] == "ok" else np.nan)  # truth is t = 0
        for loq in loqs:
            e = np.asarray(errs[loq])
            ok = ~np.isnan(e)
            rows.append(dict(
                loq=loq, interval_h=interval, n=len(e),
                estimated_pct=100 * ok.mean(),
                within_30min_pct=100 * np.mean(ok & (np.abs(e) <= 0.5)),
                within_60min_pct=100 * np.mean(ok & (np.abs(e) <= 1.0)),
                median_bias_min=60 * np.nanmedian(e) if ok.any() else np.nan,
                mae_min=60 * np.nanmean(np.abs(e)) if ok.any() else np.nan,
            ))
    return pd.DataFrame(rows)


def required_loq(df: pd.DataFrame, interval_h: float = 0.5, target_pct: float = 90.0) -> float:
    """Largest LOQ at which at least `target_pct` of evenings give DLMO within 30 min."""
    d = df[df["interval_h"] == interval_h].sort_values("loq")
    ok = d[d["within_30min_pct"] >= target_pct]
    return float(ok["loq"].max()) if len(ok) else float("nan")
