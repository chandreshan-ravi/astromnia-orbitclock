"""Synthetic mission generator.

Produces time-stamped salivary melatonin and cortisol readings for a small crew
across pre-flight, in-flight and post-flight phases, plus a sleep log and the
ground-truth circadian phase used to validate the engine.

Everything here is SYNTHETIC. Parameter choices are documented in README.md
("Simulator parameters") with the literature each one is anchored to.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.optimize import brentq

LAUNCH = pd.Timestamp("2027-03-01 00:00:00")  # arbitrary simulated launch date
DLMO_THRESHOLD = 3.0        # pg/mL, fixed salivary DLMO threshold
N_PREFLIGHT_DAYS = 14
N_POSTFLIGHT_DAYS = 10

# Assay presets: analyte -> label -> (method id, LOQ). LOQ units: pg/mL (melatonin), nmol/L (cortisol)
MELATONIN_ASSAYS = {
    "Lab ELISA (LOQ 1.35 pg/mL)": ("elisa", 1.35),
    "Hypothetical on-board point-of-care (LOQ 5 pg/mL)": ("poc_hypothetical", 5.0),
    "Best reported modified electrode (~40 pg/mL)": ("modified_electrode", 40.0),
    "Plain screen-printed carbon electrode, DPV (~250,000 pg/mL)": ("spce_dpv", 250_000.0),
}
CORTISOL_ASSAYS = {
    "Lab ELISA (LOQ 0.3 nmol/L)": ("elisa", 0.3),
    "On-board chemiluminescence strip, IN SITU class (LOQ 1.1 nmol/L)": ("cl_lfia", 1.1),
}


@dataclass(frozen=True)
class CrewProfile:
    astronaut_id: str
    scenario: str               # "nominal" | "circadian_drift" | "stress"
    dlmo_clock_h: float = 21.0  # pre-flight DLMO, clock hours
    mel_peak: float = 20.0      # night-time rise above daytime level, pg/mL
    mel_base: float = 0.8       # daytime level, pg/mL
    bedtime_h: float = 23.0
    sleep_h: float = 8.0
    cort_amp: float = 12.0      # circadian cortisol amplitude, nmol/L
    cort_floor: float = 1.5     # evening nadir, nmol/L
    car_amp: float = 7.0        # cortisol awakening response bump, nmol/L


DEFAULT_CREW = (
    CrewProfile("CM-A", "nominal", dlmo_clock_h=21.5, mel_peak=22.0),
    CrewProfile("CM-B", "circadian_drift", dlmo_clock_h=20.75, mel_peak=16.0),
    CrewProfile("CM-C", "stress", dlmo_clock_h=21.0, mel_peak=26.0, car_amp=8.0),
)

SCENARIO_TEXT = {
    "nominal": "Clock stays aligned. One in-flight session has a lighting protocol breach.",
    "circadian_drift": "Clock drifts later from FD5 (weak light cues), countermeasure from FD19.",
    "stress": "Clock aligned. High workload FD10-FD27 flattens the cortisol rhythm.",
}


def _sig(x):
    return 1.0 / (1.0 + np.exp(-x))


def melatonin_curve(phi, peak, base, k_on=0.6, k_off=0.8, phi_off=10.0):
    """Noise-free salivary melatonin (pg/mL) at circadian phase `phi` (hours after nominal DLMO).

    Built so that an un-suppressed curve crosses 3 pg/mL at phi = 0.
    """
    phi = (np.asarray(phi, dtype=float) + 8.0) % 24.0 - 8.0
    frac = np.clip((DLMO_THRESHOLD - base) / peak, 1e-6, 1 - 1e-6)
    phi_on = -k_on * np.log(frac / (1 - frac))
    return base + peak * _sig((phi - phi_on) / k_on) * _sig((phi_off - phi) / k_off)


def cortisol_curve(phi, tau_wake, phi_wake, amp, floor, car_amp,
                   kappa=1.6, phi_pk=10.5, kappa_car=2.5, tau_p=0.6):
    """Noise-free salivary cortisol (nmol/L).

    Two parts: a circadian component locked to the body clock (`phi`, hours after
    DLMO) and an awakening bump locked to wake time (`tau_wake`, hours since wake)
    whose size depends on the circadian phase at which waking happens (`phi_wake`).
    """
    phi = np.asarray(phi, dtype=float)
    tau = np.asarray(tau_wake, dtype=float)
    circ = floor + amp * np.exp(kappa * (np.cos(2 * np.pi * (phi - phi_pk) / 24.0) - 1.0))
    gate = np.exp(kappa_car * (np.cos(2 * np.pi * (phi_wake - (phi_pk - 0.5)) / 24.0) - 1.0))
    bump = np.where((tau >= 0) & (tau < 4),
                    car_amp * gate * (np.clip(tau, 0, None) / tau_p) * np.exp(1 - np.clip(tau, 0, None) / tau_p),
                    0.0)
    return circ + bump


def clock_shift(scenario: str, day: int, n_flight: int) -> float:
    """Hours the body clock sits LATER than its pre-flight position on mission day `day`."""
    shift = 0.0
    if scenario == "circadian_drift" and 0 <= day < n_flight:
        if day <= 18:
            shift = float(np.clip(0.25 * (day - 4), 0.0, 2.5))
        else:
            shift = max(0.0, 2.5 - 0.4 * (day - 18))
    if day >= n_flight:  # assumed schedule change on return, decays over a few days
        shift += 1.0 * np.exp(-(day - n_flight) / 3.0)
    return shift


def stress_level(scenario: str, day: int) -> float:
    """0..1 workload/stress load for the 'stress' scenario."""
    if scenario != "stress":
        return 0.0
    return float(np.interp(day, [9, 13, 23, 27], [0.0, 1.0, 1.0, 0.0], left=0.0, right=0.0))


def day_label(day: int, n_flight: int) -> str:
    if day < 0:
        return f"L{day}"
    if day < n_flight:
        return f"FD{day + 1}"
    return f"R+{day - n_flight}"


def mission_phase(day: int, n_flight: int) -> str:
    return "preflight" if day < 0 else ("inflight" if day < n_flight else "postflight")


def session_days(n_flight: int = 30) -> list[int]:
    pre = [-13, -10, -7, -4]
    infl = list(range(2, n_flight, 5))
    post = [n_flight + 1, n_flight + 4, n_flight + 8]
    return pre + infl + post


def _observe(true, cv, sd_add, loq, rng):
    obs = np.clip(true * (1 + rng.normal(0, cv, size=true.shape)) + rng.normal(0, sd_add, size=true.shape), 0, None)
    below = obs < loq
    return np.where(below, np.nan, obs), below


def simulate_mission(crew=DEFAULT_CREW, n_flight: int = 30, mel_interval_h: float = 0.5,
                     mel_assay=("elisa", 1.35), cort_assay=("elisa", 0.3),
                     mel_cv: float = 0.12, cort_cv: float = 0.08, seed: int = 7):
    """Return (samples, sleep_log, truth) DataFrames for one synthetic mission."""
    rng = np.random.default_rng(seed)
    rows, sleep_rows, truth_rows = [], [], []
    all_days = range(-N_PREFLIGHT_DAYS, n_flight + N_POSTFLIGHT_DAYS)
    sessions = set(session_days(n_flight))

    for p in crew:
        wake_h = (p.bedtime_h + p.sleep_h) % 24.0
        jitter = {d: rng.normal(0, 0.12) for d in all_days}
        for d in all_days:
            midnight = LAUNCH + pd.Timedelta(days=d)
            sleep_rows.append(dict(
                astronaut_id=p.astronaut_id, mission_day=d,
                wake_time=midnight + pd.Timedelta(hours=wake_h),
                sleep_onset=midnight + pd.Timedelta(hours=p.bedtime_h),
            ))
            if d not in sessions:
                continue
            shift = clock_shift(p.scenario, d, n_flight) + jitter[d]
            s = stress_level(p.scenario, d)
            dlmo_nominal = p.dlmo_clock_h + shift
            peak = p.mel_peak * (1 - 0.25 * s)
            floor = p.cort_floor * (1 + 1.8 * s)
            amp = p.cort_amp * (1 - 0.25 * s)
            common = dict(astronaut_id=p.astronaut_id, mission_day=d,
                          mission_phase=mission_phase(d, n_flight), day_label=day_label(d, n_flight))

            # --- melatonin: evening dim-light series, 6 h before to 1 h after bedtime
            t = np.arange(p.bedtime_h - 6.0, p.bedtime_h + 1.0 + 1e-9, mel_interval_h)
            true = melatonin_curve(t - dlmo_nominal, peak, p.mel_base)
            lux = rng.uniform(3, 12, size=t.shape)
            if p.scenario == "nominal" and d == 12:  # FD13: lights left on during sampling
                breach = (t >= 21.0) & (t <= 23.5)
                lux[breach] = rng.uniform(150, 220, size=breach.sum())
                true = np.where(breach, p.mel_base + (true - p.mel_base) * 0.25, true)
            obs, below = _observe(true, mel_cv, 0.15, mel_assay[1], rng)
            for ti, vi, bi, li in zip(t, obs, below, lux):
                rows.append(dict(common, timestamp=midnight + pd.Timedelta(hours=float(ti)),
                                 analyte="melatonin", value=vi, unit="pg/mL", below_loq=bool(bi),
                                 loq=mel_assay[1], method=mel_assay[0], light_lux=round(float(li), 1)))

            # --- cortisol: wake, +30, +45 min, mid-day, pre-bed
            tc = np.array([wake_h, wake_h + 0.5, wake_h + 0.75, wake_h + 6.0, p.bedtime_h - 0.5])
            true_c = cortisol_curve((tc - dlmo_nominal) % 24.0, tc - wake_h, (wake_h - dlmo_nominal) % 24.0,
                                    amp, floor, p.car_amp)
            obs_c, below_c = _observe(true_c, cort_cv, 0.15, cort_assay[1], rng)
            for ti, vi, bi in zip(tc, obs_c, below_c):
                rows.append(dict(common, timestamp=midnight + pd.Timedelta(hours=float(ti)),
                                 analyte="cortisol", value=vi, unit="nmol/L", below_loq=bool(bi),
                                 loq=cort_assay[1], method=cort_assay[0], light_lux=np.nan))

            # --- ground truth: where the noise-free, un-suppressed curve crosses 3 pg/mL
            f = lambda x: float(melatonin_curve(x, peak, p.mel_base)) - DLMO_THRESHOLD
            phi_star = brentq(f, -4.0, 6.0)
            truth_rows.append(dict(astronaut_id=p.astronaut_id, mission_day=d,
                                   true_dlmo_clock_h=(dlmo_nominal + phi_star) % 24.0,
                                   true_clock_shift_h=shift, stress_level=s))

    samples = pd.DataFrame(rows).sort_values(["astronaut_id", "timestamp", "analyte"]).reset_index(drop=True)
    return samples, pd.DataFrame(sleep_rows), pd.DataFrame(truth_rows)
