"""OrbitClock data API for the ASTROMNIA front end (orbitclock-next).

Runs the same engine as the Streamlit app and returns JSON:
  GET /api/options                     sensors, cortisol assays, your sensor's saliva LOQ, saved-records summary
  GET /api/mission?source=sim|records  crew, sessions, body-clock estimate and melatonin plan per session
        &sensor=<label>&cortisol=<label>&interval=0.5|1&seed=7
  GET /api/sensitivity?n=400           how DLMO accuracy depends on the sensor LOQ
  plus Setup / Measure / Records routes from orbitclock/lab_api.py

Run:  .venv/bin/python api.py      (port 8510)
"""
from __future__ import annotations

import math
from datetime import date
from functools import lru_cache

import numpy as np
import pandas as pd
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Route

from orbitclock import store
from orbitclock.lab_api import routes as lab_routes, setup_state
from orbitclock.countermeasure import ALERT_H, WATCH_H, crew_plans, plan_for
from orbitclock.engine import DLMO_THRESHOLD, analyse, fmt_clock
from orbitclock.orbit import orbit_payload
from orbitclock.records_bridge import records_to_samples
from orbitclock.schema import SchemaError, load_samples, load_sleep_log
from orbitclock.sensitivity import REFERENCE_SENSORS, required_loq, run_sensitivity
from orbitclock.simulator import CORTISOL_ASSAYS, DEFAULT_CREW, MELATONIN_ASSAYS, SCENARIO_TEXT, simulate_mission

PORT = 8510
YOUR_SENSOR = "your_sensor"
SCENARIO_ROLE = {"nominal": "Nominal clock", "circadian_drift": "Circadian drift", "stress": "High workload"}


# ----------------------------------------------------------------------------- helpers
def clean(x):
    """JSON-safe: NaN/inf -> None, numpy -> python."""
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple, np.ndarray)):
        return [clean(v) for v in x]
    if isinstance(x, (np.bool_, bool)):
        return bool(x)
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        return None if not math.isfinite(float(x)) else round(float(x), 4)
    if isinstance(x, pd.Timestamp):
        return x.isoformat()
    return x


def num(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) or pd.isna(v) else float(v)


def your_loq_pg() -> float | None:
    """Saliva LOQ (pg/mL) of the sensor calibrated in Setup, or None if Setup is incomplete."""
    return setup_state().loq_saliva_pg


def sensor_options() -> dict:
    opts = {k: v for k, v in MELATONIN_ASSAYS.items()}
    loq = your_loq_pg()
    if loq is not None:
        opts[f"Your sensor (saliva LOQ {loq:,.3g} pg/mL)"] = (YOUR_SENSOR, round(loq, 3))
    return opts


# ----------------------------------------------------------------------------- analysis
@lru_cache(maxsize=32)
def _simulated(method: str, loq: float, cort_label: str, interval: float, seed: int):
    samples, sleep, _ = simulate_mission(mel_assay=(method, loq), cort_assay=CORTISOL_ASSAYS[cort_label],
                                         mel_interval_h=interval, seed=seed)
    return analyse(load_samples(samples), load_sleep_log(sleep))


def _records():
    readings = store.load_readings()
    launch_s = store.load_settings().get("launch_date")
    if readings.empty:
        return None, "No readings saved yet. Measure and save readings in the OrbitClock app (2 · Measure)."
    if not launch_s:
        return None, "Set the mission launch date in the OrbitClock app (1 · Setup)."
    samples, skipped = records_to_samples(readings, date.fromisoformat(launch_s))
    if samples.empty:
        return None, "None of the saved readings can be used yet."
    try:
        m, base, details = analyse(load_samples(samples), load_sleep_log(None))
    except SchemaError as exc:
        return None, str(exc)
    return (m, base, details, skipped, bool((readings["data_origin"] == "simulated").any()), launch_s), None


def _series(det: dict) -> dict | None:
    if "mel_t" not in det:
        return None
    res = det["dlmo"]
    return dict(t=det["mel_t"], v=det["mel_v"], censored=det["mel_cens"].astype(bool), loq=float(np.max(det["mel_loq"])),
                lux=det.get("mel_lux"), threshold=res.get("threshold_used", DLMO_THRESHOLD) if res["status"] == "ok"
                else DLMO_THRESHOLD, dlmo_h=res["dlmo_h"], ci_low=res["ci_low"], ci_high=res["ci_high"])


def _plan_dict(p) -> dict:
    return dict(action=p.action, headline=p.headline, dose_mg=p.dose_mg, take_at=fmt_clock(p.take_at_h) if p.dose_mg else None,
                take_at_h=p.take_at_h, window=[fmt_clock(w) for w in p.window], priority=p.priority,
                dose_text=p.dose_text, reasons=p.reasons, light=p.light)


def mission_payload(m: pd.DataFrame, base: pd.DataFrame, details: dict, scenarios: dict) -> dict:
    sessions = (m.drop_duplicates("mission_day").sort_values("mission_day")[["mission_day", "day_label", "mission_phase"]])
    crew = []
    for aid in sorted(m["astronaut_id"].unique()):
        b = base[base["astronaut_id"] == aid]
        crew.append(dict(id=aid, role=SCENARIO_ROLE.get(scenarios.get(aid), "Crew member"),
                         scenario=SCENARIO_TEXT.get(scenarios.get(aid), ""),
                         baseline_dlmo=fmt_clock(b.iloc[0]["base_dlmo_clock_h"]) if len(b) and pd.notna(b.iloc[0]["base_dlmo_clock_h"]) else None,
                         baseline_dlmo_h=num(b.iloc[0]["base_dlmo_clock_h"]) if len(b) else None))
    rows = []
    for r in m.sort_values(["astronaut_id", "mission_day"]).to_dict("records"):
        p = plan_for(r)
        i = r.get("interp") or {}
        rows.append(dict(
            crew=r["astronaut_id"], day=int(r["mission_day"]), label=r["day_label"], phase=r["mission_phase"],
            level=r.get("level"), headline=r.get("headline"), dlmo_status=r.get("dlmo_status"),
            dlmo=fmt_clock(r["dlmo_clock_h"]) if pd.notna(r.get("dlmo_clock_h")) else None, dlmo_h=num(r.get("dlmo_clock_h")),
            offset_h=num(r.get("clock_offset_h")), confidence=r.get("dlmo_conf"), light_breach=bool(r.get("light_breach")),
            n_mel=num(r.get("n_mel")), n_censored=num(r.get("n_mel_censored")),
            sleep_onset_h=num(r.get("sleep_onset_h")), wake_h=num(r.get("wake_h")),
            evening_cort=num(r.get("evening_cort")), z_evening_cort=num(r.get("z_evening_cort")),
            findings=i.get("findings", []), timing=i.get("timing", []),
            plan=_plan_dict(p), series=_series(details[(r["astronaut_id"], int(r["mission_day"]))])))
    return dict(sessions=[dict(day=int(s.mission_day), label=s.day_label, phase=s.mission_phase)
                          for s in sessions.itertuples()],
                crew=crew, rows=rows, watch_h=WATCH_H, alert_h=ALERT_H, threshold=DLMO_THRESHOLD)


# ----------------------------------------------------------------------------- routes
async def options(request):
    opts = sensor_options()
    readings = store.load_readings()
    return JSONResponse(clean(dict(
        sensors=[dict(label=k, method=v[0], loq=v[1], yours=v[0] == YOUR_SENSOR) for k, v in opts.items()],
        default_sensor=list(MELATONIN_ASSAYS)[0], cortisol=list(CORTISOL_ASSAYS), your_loq=your_loq_pg(),
        records=dict(count=int(len(readings)), crew=sorted(readings["crew_id"].astype(str).unique()) if len(readings) else [],
                     launch=store.load_settings().get("launch_date")))))


async def mission(request):
    q = request.query_params
    if q.get("source", "sim") == "records":
        out, err = _records()
        if err:
            return JSONResponse(dict(source="records", error=err))
        m, base, details, skipped, has_sim, launch = out
        payload = mission_payload(m, base, details, {})
        payload.update(source="records", skipped=skipped, simulated_files=has_sim, launch=launch,
                       sensor="Your sensor, as recorded")
        return JSONResponse(clean(payload))
    opts = sensor_options()
    label = q.get("sensor") if q.get("sensor") in opts else list(opts)[0]
    cort = q.get("cortisol") if q.get("cortisol") in CORTISOL_ASSAYS else list(CORTISOL_ASSAYS)[0]
    interval = 1.0 if q.get("interval") in ("1", "1.0", "60") else 0.5
    seed = int(q.get("seed", 7))
    m, base, details = _simulated(*opts[label], cort, interval, seed)
    payload = mission_payload(m, base, details, {p.astronaut_id: p.scenario for p in DEFAULT_CREW})
    payload.update(source="sim", sensor=label, sensor_loq=opts[label][1], cortisol=cort, interval_h=interval, seed=seed)
    return JSONResponse(clean(payload))


@lru_cache(maxsize=4)
def _sensitivity(n: int):
    return run_sensitivity(n_nights=n)


async def sensitivity(request):
    n = int(request.query_params.get("n", 400))
    n = n if n in (200, 400, 800) else 400
    d = _sensitivity(n)
    loq = your_loq_pg()
    refs = REFERENCE_SENSORS + ([("Your sensor (saliva LOQ)", loq)] if loq is not None else [])
    return JSONResponse(clean(dict(
        rows=d.to_dict("records"), required_30=required_loq(d, 0.5), required_60=required_loq(d, 1.0),
        references=[dict(label=a, loq=b) for a, b in refs], your_loq=loq, n=n)))


async def orbit(request):
    """Live ISS light-dark cycle: position, sunlit/eclipse, sunrises in the last 24 h, next transition."""
    from starlette.concurrency import run_in_threadpool
    return JSONResponse(await run_in_threadpool(orbit_payload))


app = Starlette(routes=[Route("/api/options", options), Route("/api/mission", mission),
                        Route("/api/sensitivity", sensitivity), Route("/api/orbit", orbit), *lab_routes],
                middleware=[Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "DELETE"])])

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
