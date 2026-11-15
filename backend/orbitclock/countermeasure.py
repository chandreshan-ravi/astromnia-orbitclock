"""Melatonin countermeasure plan per crew member, from the engine's body-clock estimate.

A saliva melatonin LEVEL does not set a dose. What shifts the body clock is WHEN melatonin is
taken relative to that person's dim-light melatonin onset (DLMO), and low doses work best for
shifting (higher doses spill over onto the wrong side of the phase-response curve).

Rules (assumed operating points, for flight-surgeon review and sign-off):
- Clock later than the personal pre-flight baseline by >= WATCH_H hours
    -> 0.5 mg melatonin once daily, 4 h before the CURRENT estimated DLMO
       (window 3-5 h before DLMO), plus morning light; re-measure DLMO after 3 days and stop
       when the offset is back under WATCH_H.
- Clock earlier than baseline by >= WATCH_H -> no melatonin (evening melatonin would move the
  clock further the wrong way); light timing only.
- Within +/- WATCH_H -> no melatonin needed.
- No usable estimate (sensor cannot read the onset, lighting breach, low confidence, no baseline)
  -> no dose; re-sample first.
Basis: low-dose (0.5 mg) melatonin phase-advance protocols, e.g. Lewy et al. 1998; Burgess et al. 2010.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .engine import ALERT_H, WATCH_H, _timing_windows, fmt_clock

DOSE_MG = 0.5
LEAD_H = 4.0                 # take melatonin this many hours before the current DLMO
WINDOW_H = (5.0, 3.0)        # acceptable window: 5 h to 3 h before DLMO
REASSESS_DAYS = 3

GIVE, NONE, AVOID, RESAMPLE, BASELINE = "Melatonin", "No melatonin needed", "Melatonin not advised", "Re-sample first", "Baseline"


@dataclass
class Plan:
    astronaut_id: str
    day_label: str
    mission_day: int
    action: str
    headline: str
    dose_mg: float = 0.0
    take_at_h: float = float("nan")
    window: tuple = ()
    priority: str = ""                    # "high" when the offset is >= ALERT_H
    dlmo_clock_h: float = float("nan")
    offset_h: float = float("nan")
    reasons: list = field(default_factory=list)
    light: list = field(default_factory=list)

    @property
    def dose_text(self) -> str:
        if self.action != GIVE:
            return "—"
        return f"{self.dose_mg:g} mg at {fmt_clock(self.take_at_h)}"


def _quarter(h: float) -> float:
    return round(h * 4) / 4 % 24.0


def plan_for(row: dict) -> Plan:
    aid, label, day = row["astronaut_id"], row["day_label"], int(row["mission_day"])
    dlmo, off = row.get("dlmo_clock_h", np.nan), row.get("clock_offset_h", np.nan)
    p = Plan(aid, label, day, NONE, "", dlmo_clock_h=dlmo, offset_h=off)
    if row["mission_phase"] == "preflight":
        p.action, p.headline = BASELINE, "Pre-flight baseline session. No countermeasure."
        return p
    if row.get("dlmo_status") != "ok":
        p.action = RESAMPLE
        n, nc = row.get("n_mel", 0) or 0, row.get("n_mel_censored", 0) or 0
        if row.get("dlmo_status") == "no_samples":
            p.headline = "No melatonin samples this evening."
        elif n and nc == n:
            p.headline = "Every melatonin reading was below the sensor's LOQ, so the body clock could not be read."
            p.reasons.append("A dose cannot be timed without a DLMO. Use a sensor with a saliva LOQ at or below about "
                             "3 pg/mL, or send the saliva for lab ELISA.")
        else:
            p.headline = "The melatonin onset was not found in the sampling window."
            p.reasons.append("Sample over a longer evening window (from about 6 h before usual sleep) and repeat.")
        return p
    if row.get("light_breach"):
        p.action, p.headline = RESAMPLE, "Lighting breach during sampling: the clock estimate is unreliable."
        p.reasons.append("Repeat the evening series under dim light before deciding on melatonin.")
        return p
    if row.get("dlmo_conf") == "low":
        p.action, p.headline = RESAMPLE, "Clock estimate has low confidence."
        p.reasons.append("Repeat the evening series before deciding on melatonin.")
        return p
    if pd.isna(off):
        p.action, p.headline = RESAMPLE, "No pre-flight baseline, so drift cannot be judged."
        p.reasons.append("Collect at least two pre-flight evening series for this crew member.")
        return p
    if off >= WATCH_H:
        p.action = GIVE
        p.dose_mg = DOSE_MG
        p.take_at_h = _quarter(dlmo - LEAD_H)
        p.window = (_quarter(dlmo - WINDOW_H[0]), _quarter(dlmo - WINDOW_H[1]))
        p.priority = "high" if off >= ALERT_H else ""
        p.headline = f"Body clock {off:+.1f} h later than baseline: advance it."
        p.reasons += [
            f"Take {DOSE_MG:g} mg melatonin once daily at {fmt_clock(p.take_at_h)} "
            f"(acceptable {fmt_clock(p.window[0])}–{fmt_clock(p.window[1])}), i.e. {LEAD_H:g} h before the current "
            f"estimated DLMO of {fmt_clock(dlmo)}.",
            f"Re-measure DLMO after {REASSESS_DAYS} days; stop when the clock is within {WATCH_H:g} h of baseline. "
            "As the clock moves earlier, move the dose earlier with it.",
            "Low dose on purpose: larger doses act for longer and can blunt the shift.",
        ]
        p.light = [t for t in _timing_windows(dlmo, late=True) if "melatonin" not in t.lower()]
        return p
    if off <= -WATCH_H:
        p.action = AVOID
        p.headline = f"Body clock {off:+.1f} h earlier than baseline."
        p.reasons.append("Evening melatonin would move the clock further earlier. Use light timing instead.")
        p.light = [t for t in _timing_windows(dlmo, late=False) if "melatonin" not in t.lower()]
        return p
    p.headline = f"Body clock within {WATCH_H:g} h of baseline ({off:+.1f} h). No melatonin needed."
    return p


def crew_plans(m: pd.DataFrame, as_of_day: int | None = None) -> list[Plan]:
    """Plan for each crew member from their latest session on or before `as_of_day`."""
    out = []
    for aid, g in m.sort_values("mission_day").groupby("astronaut_id"):
        if as_of_day is not None:
            g = g[g["mission_day"] <= as_of_day]
        if len(g):
            out.append(plan_for(g.iloc[-1].to_dict()))
    return out


def plan_table(m: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for r in m.sort_values(["astronaut_id", "mission_day"]).to_dict("records"):
        p = plan_for(r)
        rows.append(dict(crew=p.astronaut_id, session=p.day_label, mission_day=p.mission_day,
                         dlmo=fmt_clock(p.dlmo_clock_h) if pd.notna(p.dlmo_clock_h) else "—",
                         offset_h=None if pd.isna(p.offset_h) else round(float(p.offset_h), 1),
                         plan=p.action, dose=p.dose_text, note=p.headline))
    return pd.DataFrame(rows)
