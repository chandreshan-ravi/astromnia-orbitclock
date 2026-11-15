"""Body-clock engine.

1. estimate_dlmo      - dim light melatonin onset from one evening of saliva readings,
                        with explicit handling of readings below the LOQ and an
                        uncertainty interval.
2. cortisol_metrics   - awakening response, wake-to-bed slope, evening level.
3. compute_metrics    - one row per crew member per sampling day.
4. add_deviations     - compare each row with that crew member's own pre-flight baseline.
5. interpret          - read cortisol against clock timing and produce findings.

The tool never suggests a dose. It reports timing windows for flight-surgeon review.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

DLMO_THRESHOLD = 3.0          # pg/mL, fixed salivary threshold
ASSAY_CV = {"melatonin": 0.12, "cortisol": 0.08}
DIM_LIGHT_LUX = 30.0          # melatonin samples above this are flagged
CBTMIN_AFTER_DLMO_H = 7.0     # rule of thumb: core temperature minimum ~7 h after DLMO

# Alert thresholds (ASSUMED operating points - tune with a flight surgeon)
WATCH_H, ALERT_H = 1.0, 2.0   # clock offset relative to personal baseline, hours
Z_CAR_BLUNTED = -1.5
Z_HPA = 2.0
# Minimum within-person SDs. With 3-4 baseline days the sample SD is unstable, so it is floored.
SD_FLOOR = {"car_delta": 2.0, "slope": 0.12, "evening_cort": 0.6}

METHOD_TEXT = {
    "fixed_3pg": "fixed 3 pg/mL threshold",
    "variable_3k": "personal threshold (mean + 2 SD of first three samples)",
    "loq_crossing": "first rise above the sensor LOQ",
}


# ----------------------------------------------------------------------------- helpers
def circ_diff(a, b):
    """Signed difference a - b between two clock times, in (-12, 12] hours."""
    return (np.asarray(a, dtype=float) - np.asarray(b, dtype=float) + 12.0) % 24.0 - 12.0


def circ_mean(x):
    x = np.asarray(x, dtype=float)
    x = x[~np.isnan(x)]
    if len(x) == 0:
        return np.nan
    return (x[0] + np.mean(circ_diff(x, x[0]))) % 24.0


def fmt_clock(h) -> str:
    if h is None or (isinstance(h, float) and np.isnan(h)):
        return "n/a"
    m = int(round((float(h) % 24.0) * 60)) % (24 * 60)
    return f"{m // 60:02d}:{m % 60:02d}"


def fmt_dur(h) -> str:
    if h is None or np.isnan(h):
        return "n/a"
    sign = "+" if h >= 0 else "−"
    m = int(round(abs(h) * 60))
    return f"{sign}{m // 60} h {m % 60:02d} min"


# ----------------------------------------------------------------------------- DLMO
def _first_sustained_crossing(t, v, thr):
    """First upward crossing of `thr` that is still above `thr` at the next sample."""
    n = len(t)
    if n < 3:
        return "insufficient", np.nan, -1
    if v[0] >= thr and v[1] >= thr:
        return "already_above", np.nan, 0
    for i in range(1, n):
        if v[i - 1] < thr <= v[i]:
            if i + 1 < n and v[i + 1] < thr:
                continue
            frac = (thr - v[i - 1]) / (v[i] - v[i - 1])
            return "ok", t[i - 1] + frac * (t[i] - t[i - 1]), i
    return "not_reached", np.nan, -1


def estimate_dlmo(t, value, below_loq, loq, *, threshold=DLMO_THRESHOLD,
                  cv=ASSAY_CV["melatonin"], n_boot=300, seed=0) -> dict:
    """Estimate DLMO from one evening.

    t          hours on any continuous axis (e.g. hours since midnight; may exceed 24)
    value      pg/mL, NaN where below LOQ
    below_loq  bool per sample
    loq        scalar or per-sample LOQ, pg/mL

    Method choice:
      * LOQ <= 3 pg/mL: fixed 3 pg/mL threshold, linear interpolation. Readings below
        the LOQ are known to be below the threshold, so they still bracket the onset.
      * Fixed threshold never reached (low producer): personal "3k" threshold if the
        first three samples are quantified, else first sustained rise above the LOQ.
      * LOQ > 3 pg/mL: the threshold is invisible to the sensor. Fall back to the first
        sustained rise above the LOQ and flag the estimate as biased late.
    """
    t = np.asarray(t, dtype=float)
    order = np.argsort(t)
    t = t[order]
    v = np.asarray(value, dtype=float)[order]
    cens = np.asarray(below_loq, dtype=bool)[order] | np.isnan(v)
    loq_arr = np.broadcast_to(np.asarray(loq, dtype=float), np.asarray(value).shape)[order] \
        if np.ndim(loq) else np.full(len(t), float(loq))
    loq_eff = float(np.max(loq_arr)) if len(loq_arr) else np.nan
    sub = np.where(cens, loq_arr / 2.0, v)

    res = dict(status="insufficient", method=None, threshold_used=np.nan, dlmo_h=np.nan,
               ci_low=np.nan, ci_high=np.nan, boot_success=np.nan, bracket=(np.nan, np.nan),
               n_samples=int(len(t)), n_censored=int(cens.sum()), loq=loq_eff,
               interval_h=float(np.median(np.diff(t))) if len(t) > 1 else np.nan,
               window_start_h=float(t[0]) if len(t) else np.nan,
               window_end_h=float(t[-1]) if len(t) else np.nan, notes=[])
    if len(t) < 3:
        res["notes"].append("Fewer than three samples.")
        return res
    if cens.all():
        res["status"] = "all_below_loq"
        res["notes"].append("Every reading is below the sensor LOQ. No onset can be estimated.")
        return res

    if loq_eff <= threshold:
        method, thr = "fixed_3pg", threshold
        status, est, i = _first_sustained_crossing(t, sub, thr)
        if status == "not_reached":
            if not cens[:3].any():
                # guard: with only three points the SD can be near zero, so require a 25% rise at least
                thr_k = float(max(np.mean(v[:3]) + 2 * np.std(v[:3], ddof=1), 1.25 * np.mean(v[:3])))
                alt = ("variable_3k", thr_k)
            else:
                alt = ("loq_crossing", loq_eff)
            if alt[1] < threshold:
                s2, e2, i2 = _first_sustained_crossing(t, sub, alt[1])
                if s2 == "ok":
                    method, thr, status, est, i = alt[0], alt[1], s2, e2, i2
                    res["notes"].append("Melatonin never reached 3 pg/mL (low producer or suppressed). "
                                        f"Onset taken from the {METHOD_TEXT[method]}.")
    else:
        method, thr = "loq_crossing", loq_eff
        status, est, i = _first_sustained_crossing(t, sub, thr)
        res["notes"].append(f"Sensor LOQ ({loq_eff:g} pg/mL) is above the 3 pg/mL onset threshold. "
                            "The estimate marks when melatonin first exceeds the LOQ, which is LATER than true onset.")

    res.update(status=status, method=method, threshold_used=float(thr))
    if status != "ok":
        if status == "not_reached":
            res["notes"].append("No onset inside the sampling window.")
        elif status == "already_above":
            res["notes"].append("Melatonin was already above threshold at the first sample.")
        return res

    res.update(dlmo_h=float(est), bracket=(float(t[i - 1]), float(t[i])))
    if cens[i - 1]:
        res["notes"].append("The sample just before onset was below the LOQ, so interpolation is coarse.")
    if n_boot > 0:
        rng = np.random.default_rng(seed)
        ests = []
        for _ in range(n_boot):
            vb = np.where(cens, sub, sub * (1 + rng.normal(0, cv, len(sub))))
            s, e, _i = _first_sustained_crossing(t, vb, thr)
            if s == "ok":
                ests.append(e)
        res["boot_success"] = len(ests) / n_boot
        if len(ests) >= 20:
            res["ci_low"], res["ci_high"] = (float(x) for x in np.percentile(ests, [2.5, 97.5]))
    return res


def grade_confidence(res: dict, light_breach: bool = False) -> str:
    if res["status"] != "ok":
        return "none"
    score = 3
    if res["method"] != "fixed_3pg":
        score -= 1
    if res["loq"] > DLMO_THRESHOLD:
        score -= 1
    width = res["ci_high"] - res["ci_low"]
    if not np.isnan(width):
        score -= 2 if width > 2.0 else (1 if width > 1.0 else 0)
    if not np.isnan(res["boot_success"]) and res["boot_success"] < 0.9:
        score -= 1
    if light_breach:
        score -= 1
    return "high" if score >= 3 else ("moderate" if score == 2 else "low")


# ----------------------------------------------------------------------------- cortisol
def cortisol_metrics(tau_wake, value, below_loq, loq) -> dict:
    """Cortisol summary for one waking day. `tau_wake` = hours since wake for each sample."""
    tau = np.asarray(tau_wake, dtype=float)
    order = np.argsort(tau)
    tau = tau[order]
    cens = np.asarray(below_loq, dtype=bool)[order]
    loq_arr = np.full(len(tau), float(loq)) if np.ndim(loq) == 0 else np.asarray(loq, dtype=float)[order]
    v = np.where(cens, loq_arr / np.sqrt(2), np.asarray(value, dtype=float)[order])
    out = dict(wake_cort=np.nan, car_delta=np.nan, car_auci=np.nan, evening_cort=np.nan,
               slope=np.nan, n_cort=int(len(tau)), n_cort_censored=int(cens.sum()))
    wake_idx = np.where(np.abs(tau) <= 0.25)[0]
    if len(wake_idx):
        w = wake_idx[np.argmin(np.abs(tau[wake_idx]))]
        out["wake_cort"] = float(v[w])
        post = (tau >= 0.33) & (tau <= 1.0)
        if post.any():
            out["car_delta"] = float(np.max(v[post]) - v[w])
            seg = (tau >= tau[w]) & (tau <= 1.0)
            if seg.sum() >= 3:
                out["car_auci"] = float(np.trapezoid(v[seg] - v[w], tau[seg]))
        eve = np.where(tau >= 10.0)[0]
        if len(eve):
            e = eve[-1]
            out["evening_cort"] = float(v[e])
            out["slope"] = float((v[e] - v[w]) / (tau[e] - tau[w]))
    else:
        eve = np.where(tau >= 10.0)[0]
        if len(eve):
            out["evening_cort"] = float(v[eve[-1]])
    return out


# ----------------------------------------------------------------------------- per-session table
def _hours(ts, anchor):
    return (ts - anchor) / pd.Timedelta(hours=1)


def compute_metrics(samples: pd.DataFrame, sleep_log: pd.DataFrame, n_boot: int = 300):
    """One row per crew member per sampling day. Returns (metrics, details).

    `details[(astronaut_id, mission_day)]` keeps the raw series and DLMO result for plotting.
    """
    sleep_idx = {(r.astronaut_id, r.mission_day): r for r in sleep_log.itertuples()} if len(sleep_log) else {}
    rows, details = [], {}
    for (aid, day), g in samples.groupby(["astronaut_id", "mission_day"], sort=True):
        anchor = g["timestamp"].min().normalize()
        slp = sleep_idx.get((aid, day))
        row = dict(astronaut_id=aid, mission_day=int(day), mission_phase=g["mission_phase"].iloc[0],
                   day_label=g["day_label"].iloc[0], anchor=anchor)
        det = dict(anchor=anchor)

        mel = g[g["analyte"] == "melatonin"].sort_values("timestamp")
        if len(mel):
            t = _hours(mel["timestamp"], anchor).to_numpy()
            res = estimate_dlmo(t, mel["value"].to_numpy(), mel["below_loq"].to_numpy(),
                                mel["loq"].to_numpy(), n_boot=n_boot, seed=abs(hash((aid, int(day)))) % (2**32))
            breach = bool((mel["light_lux"] > DIM_LIGHT_LUX).any())
            if breach:
                res["notes"].append(f"Light above {DIM_LIGHT_LUX:g} lux during sampling. Melatonin may be "
                                    "suppressed, which pushes the estimate later. Repeat under dim light.")
            row.update(dlmo_status=res["status"], dlmo_method=res["method"], dlmo_h=res["dlmo_h"],
                       dlmo_clock_h=res["dlmo_h"] % 24.0 if not np.isnan(res["dlmo_h"]) else np.nan,
                       dlmo_ci_low=res["ci_low"], dlmo_ci_high=res["ci_high"],
                       dlmo_conf=grade_confidence(res, breach), light_breach=breach,
                       window_start_h=res["window_start_h"], window_end_h=res["window_end_h"],
                       n_mel=res["n_samples"], n_mel_censored=res["n_censored"], mel_loq=res["loq"],
                       dlmo_notes=" ".join(res["notes"]))
            det.update(mel_t=t, mel_v=mel["value"].to_numpy(), mel_cens=mel["below_loq"].to_numpy(),
                       mel_loq=mel["loq"].to_numpy(), mel_lux=mel["light_lux"].to_numpy(), dlmo=res)
        else:
            row.update(dlmo_status="no_samples", dlmo_conf="none", light_breach=False)

        if slp is not None and pd.notna(slp.sleep_onset):
            row["sleep_onset_h"] = float(_hours(slp.sleep_onset, anchor))
            if not np.isnan(row.get("dlmo_h", np.nan)):
                row["phase_angle_h"] = row["sleep_onset_h"] - row["dlmo_h"]

        cort = g[g["analyte"] == "cortisol"].sort_values("timestamp")
        if len(cort):
            wake_ts = slp.wake_time if (slp is not None and pd.notna(slp.wake_time)) else cort["timestamp"].iloc[0]
            tau = _hours(cort["timestamp"], wake_ts).to_numpy()
            row.update(cortisol_metrics(tau, cort["value"].to_numpy(), cort["below_loq"].to_numpy(),
                                        cort["loq"].to_numpy()))
            row["wake_h"] = float(_hours(wake_ts, anchor))
            det.update(cort_tau=tau, cort_t=_hours(cort["timestamp"], anchor).to_numpy(),
                       cort_v=cort["value"].to_numpy(), cort_cens=cort["below_loq"].to_numpy(),
                       cort_loq=cort["loq"].to_numpy())
        rows.append(row)
        details[(aid, int(day))] = det

    metrics = pd.DataFrame(rows)
    for c in ("dlmo_h", "dlmo_clock_h", "dlmo_ci_low", "dlmo_ci_high", "phase_angle_h", "sleep_onset_h",
              "wake_cort", "car_delta", "car_auci", "evening_cort", "slope", "window_end_h", "window_start_h"):
        if c not in metrics.columns:
            metrics[c] = np.nan
    return metrics, details


# ----------------------------------------------------------------------------- baseline
def baselines(metrics: pd.DataFrame) -> pd.DataFrame:
    """Personal pre-flight baseline per crew member."""
    out = []
    for aid, g in metrics.groupby("astronaut_id"):
        pre = g[(g["mission_phase"] == "preflight")]
        ok = pre[pre["dlmo_status"] == "ok"]
        b = dict(astronaut_id=aid, n_baseline=int(len(pre)), n_baseline_dlmo=int(len(ok)),
                 base_dlmo_clock_h=circ_mean(ok["dlmo_clock_h"]) if len(ok) >= 2 else np.nan,
                 base_phase_angle_h=ok["phase_angle_h"].mean() if ok["phase_angle_h"].notna().sum() >= 2 else np.nan)
        for m, floor in SD_FLOOR.items():
            x = pre[m].dropna()
            b[f"base_{m}"] = x.mean() if len(x) >= 2 else np.nan
            b[f"sd_{m}"] = max(x.std(ddof=1), floor) if len(x) >= 2 else np.nan
        out.append(b)
    return pd.DataFrame(out)


def add_deviations(metrics: pd.DataFrame, base: pd.DataFrame) -> pd.DataFrame:
    m = metrics.merge(base, on="astronaut_id", how="left")
    m["dlmo_drift_h"] = circ_diff(m["dlmo_clock_h"], m["base_dlmo_clock_h"])
    m["phase_angle_dev_h"] = m["phase_angle_h"] - m["base_phase_angle_h"]
    # Positive = body clock runs LATE relative to the sleep schedule, compared with this person's baseline
    m["clock_offset_h"] = np.where(m["phase_angle_dev_h"].notna(), -m["phase_angle_dev_h"], m["dlmo_drift_h"])
    late_bound = circ_diff(m["window_end_h"] % 24.0, m["base_dlmo_clock_h"])
    early_bound = circ_diff(m["window_start_h"] % 24.0, m["base_dlmo_clock_h"])
    m["offset_bound_h"] = np.where(m["dlmo_status"] == "not_reached", late_bound,
                                   np.where(m["dlmo_status"] == "already_above", early_bound, np.nan))
    for k in SD_FLOOR:
        m[f"z_{k}"] = (m[k] - m[f"base_{k}"]) / m[f"sd_{k}"]
    return m


# ----------------------------------------------------------------------------- interpretation
def _timing_windows(dlmo_clock_h: float, late: bool) -> list[str]:
    cbt = dlmo_clock_h + CBTMIN_AFTER_DLMO_H
    out = [f"Estimated body-temperature minimum: about {fmt_clock(cbt)} (DLMO + 7 h rule of thumb)."]
    if late:
        out += [
            f"To move the clock earlier: bright light in the ~3 h after the temperature minimum "
            f"({fmt_clock(cbt)}–{fmt_clock(cbt + 3)}).",
            f"Keep light dim from about {fmt_clock(dlmo_clock_h - 2)} until {fmt_clock(cbt)}; light in that span pushes the clock later.",
            f"Candidate melatonin timing window for flight-surgeon review: {fmt_clock(dlmo_clock_h - 5)}–"
            f"{fmt_clock(dlmo_clock_h - 3)} (3–5 h before estimated DLMO). No dose is suggested by this tool.",
        ]
    else:
        out += [
            f"To move the clock later: bright light in the ~3 h before the temperature minimum "
            f"({fmt_clock(cbt - 3)}–{fmt_clock(cbt)}), or as late in the evening as the schedule allows.",
            f"Avoid bright light in the ~3 h after the temperature minimum ({fmt_clock(cbt)}–{fmt_clock(cbt + 3)}).",
            "Evening melatonin would move the clock further the wrong way. Refer to the flight surgeon.",
        ]
    return out


def interpret(row) -> dict:
    """Findings for one crew member on one sampling day.

    Returns dict(level, headline, findings, timing, confidence, flags).
    level: baseline | ok | watch | alert | unknown
    """
    g = lambda k: row.get(k, np.nan) if isinstance(row, dict) else getattr(row, k, np.nan)
    num = lambda k: (float(g(k)) if g(k) is not None and not pd.isna(g(k)) else np.nan)
    findings, timing = [], []
    flags = dict(clock=False, clock_severity=0, car=False, hpa=False, slope_flat=False, evening_high=False, artefact=False)
    status, conf = g("dlmo_status"), g("dlmo_conf")

    if g("mission_phase") == "preflight":
        txt = (f"DLMO {fmt_clock(num('dlmo_clock_h'))}" if status == "ok" else "No DLMO estimate")
        return dict(level="baseline", headline=f"Baseline session. {txt}.", findings=[g("dlmo_notes")] if g("dlmo_notes") else [],
                    timing=[], confidence=conf, flags=flags)
    has_clock_base = not pd.isna(g("base_dlmo_clock_h"))
    if not has_clock_base and pd.isna(g("base_car_delta")):
        return dict(level="unknown", headline="No personal baseline available",
                    findings=["At least two pre-flight sessions are needed before later values can be interpreted."],
                    timing=[], confidence=conf, flags=flags)

    # --- clock
    off = num("clock_offset_h")
    if status == "ok" and not has_clock_base:
        findings.append(f"DLMO {fmt_clock(num('dlmo_clock_h'))}, but there is no pre-flight clock baseline to compare it with.")
    elif status == "ok":
        sev = 2 if abs(off) >= ALERT_H else (1 if abs(off) >= WATCH_H else 0)
        direction = "later" if off > 0 else "earlier"
        ci = ""
        if not np.isnan(num("dlmo_ci_low")):
            ci = f" (95% interval {fmt_clock(num('dlmo_ci_low'))}–{fmt_clock(num('dlmo_ci_high'))})"
        findings.append(f"DLMO {fmt_clock(num('dlmo_clock_h'))}{ci}; baseline {fmt_clock(num('base_dlmo_clock_h'))}. "
                        f"Clock is {fmt_dur(abs(off))[1:].strip()} {direction} than baseline relative to the sleep schedule.")
        if not np.isnan(num("phase_angle_h")):
            findings.append(f"DLMO-to-sleep interval {num('phase_angle_h'):.1f} h (baseline {num('base_phase_angle_h'):.1f} h).")
        if sev:
            flags.update(clock=True, clock_severity=sev)
            timing = _timing_windows(num("dlmo_clock_h"), late=off > 0)
    elif status in ("not_reached", "already_above") and not has_clock_base:
        findings.append("Melatonin onset fell outside the sampling window and there is no pre-flight clock baseline.")
    elif status == "not_reached":
        bound = num("offset_bound_h")
        findings.append(f"No melatonin onset by the last sample at {fmt_clock(num('window_end_h'))}. "
                        f"DLMO is at least {max(bound, 0):.1f} h later than baseline, or melatonin is suppressed.")
        if bound >= WATCH_H:
            flags.update(clock=True, clock_severity=2 if bound >= ALERT_H else 1)
        findings.append("Extend the sampling window later on the next session.")
    elif status == "already_above":
        findings.append(f"Melatonin already above threshold at the first sample ({fmt_clock(num('window_start_h'))}). "
                        "DLMO is earlier than the sampling window. Start sampling earlier next session.")
        if abs(num("offset_bound_h")) >= WATCH_H:
            flags.update(clock=True, clock_severity=1)
    elif status == "all_below_loq":
        findings.append("All melatonin readings are below the sensor LOQ. Clock timing cannot be estimated with this sensor.")
    else:
        findings.append("Not enough melatonin samples for a DLMO estimate.")
    if g("dlmo_notes") and status != "all_below_loq":
        findings.append(g("dlmo_notes"))
    # --- cortisol
    zc, zs, ze = num("z_car_delta"), num("z_slope"), num("z_evening_cort")
    flags["car"] = bool(not np.isnan(zc) and zc <= Z_CAR_BLUNTED)
    flags["slope_flat"] = bool(not np.isnan(zs) and zs >= Z_HPA)
    flags["evening_high"] = bool(not np.isnan(ze) and ze >= Z_HPA)
    flags["hpa"] = flags["slope_flat"] or flags["evening_high"]
    if not np.isnan(num("car_delta")):
        findings.append(f"Cortisol awakening rise {num('car_delta'):.1f} nmol/L (baseline {num('base_car_delta'):.1f}, z = {zc:+.1f}); "
                        f"evening cortisol {num('evening_cort'):.1f} nmol/L (baseline {num('base_evening_cort'):.1f}, z = {ze:+.1f}); "
                        f"wake-to-bed slope {num('slope'):.2f} nmol/L per h (z = {zs:+.1f}).")
    n_cc = g("n_cort_censored")
    if not pd.isna(n_cc) and int(n_cc) > 0:
        findings.append(f"{int(n_cc)} cortisol reading(s) below the LOQ were set to LOQ/√2.")

    # --- fusion: read cortisol against clock timing
    clock_known = status == "ok" and has_clock_base
    morning_only = (flags["car"] or flags["slope_flat"]) and not flags["evening_high"]
    if flags["clock"] and flags["evening_high"]:
        kind = "both"
        fusion = ("Shifted clock and raised evening cortisol. A clock shift alone does not usually raise the evening "
                  "level, so stress load is plausible on top of misalignment. Address clock timing, then re-test cortisol.")
    elif flags["clock"] and morning_only:
        kind = "clock_explains"
        fusion = ("Lower morning cortisol together with a shifted clock, with a normal evening level. This is the pattern "
                  "expected from waking at the wrong body-clock time. Correct clock timing first; do not read it as a "
                  "stress signal on its own.")
    elif flags["clock"]:
        kind = "clock"
        fusion = "Clock has shifted; cortisol rhythm is within this crew member's baseline range."
    elif flags["hpa"] and clock_known:
        kind = "hpa"
        fusion = ("Cortisol rhythm is flattened or raised while clock timing is at baseline, so clock timing does not "
                  "explain it. Consistent with workload, stress or sleep loss. Refer for behavioural-health review.")
    elif flags["hpa"]:
        kind = "hpa_unknown_clock"
        fusion = ("Cortisol rhythm is flattened or raised, but clock timing is unknown for this session, so "
                  "misalignment cannot be ruled out as the cause.")
    elif flags["car"]:
        kind = "car_only"
        fusion = ("Awakening rise is low on this day with nothing else changed. A single-day awakening response is "
                  "noisy and very sensitive to sample timing, so this alone does not raise the status. Repeat next session.")
    else:
        kind = "none"
        fusion = "Clock timing and cortisol rhythm are within this crew member's baseline range."
    findings.append(fusion)

    sev = flags["clock_severity"]
    if sev == 2 or kind == "both" or (kind in ("hpa", "hpa_unknown_clock") and not np.isnan(ze) and ze >= 3):
        level = "alert"
    elif sev == 1 or flags["hpa"]:
        level = "watch"
    else:
        level = "ok"
    if (status in ("all_below_loq", "insufficient", "no_samples") or not has_clock_base) and level == "ok":
        level = "unknown"

    if flags["clock"] and status == "ok":
        head = f"Body clock {abs(off):.1f} h {'late' if off > 0 else 'early'}"
        if kind == "clock_explains":
            head += "; morning cortisol low as expected"
        elif kind == "both":
            head += " + evening cortisol raised"
    elif flags["clock"]:
        head = "Body clock shifted (onset outside sampling window)"
    elif flags["hpa"]:
        head = "Cortisol rhythm flattened, clock aligned" if clock_known else "Cortisol rhythm flattened, clock unknown"
    elif level == "unknown":
        head = ("Clock timing not measurable with this sensor" if status == "all_below_loq"
                else "Clock timing could not be assessed")
    elif kind == "car_only":
        head = "Within personal baseline (low awakening rise noted)"
    else:
        head = "Within personal baseline"

    if bool(g("light_breach")):
        flags["artefact"] = True
        if level in ("ok", "watch", "alert") and not flags["hpa"]:
            level = "watch"
        head = "Data quality: lighting breach during melatonin sampling" + (f" ({head.lower()})" if flags["clock"] else "")
        findings.append("Because of the lighting breach, any clock shift seen in this session may be a measurement "
                        "artefact. Repeat under dim light before acting.")
        timing = []
    return dict(level=level, headline=head, findings=[f for f in findings if f], timing=timing,
                confidence=conf, flags=flags)


def analyse(samples: pd.DataFrame, sleep_log: pd.DataFrame, n_boot: int = 300):
    """Full pipeline. Returns (metrics_with_deviations_and_levels, baselines, details)."""
    metrics, details = compute_metrics(samples, sleep_log, n_boot=n_boot)
    base = baselines(metrics)
    m = add_deviations(metrics, base)
    interp = [interpret(r._asdict()) for r in m.itertuples(index=False)]
    m["level"] = [i["level"] for i in interp]
    m["headline"] = [i["headline"] for i in interp]
    m["interp"] = interp
    return m, base, details
