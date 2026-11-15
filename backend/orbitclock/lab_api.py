"""Setup, Measure and Records for the ASTROMNIA front end: the same steps as the Streamlit
app's first three tabs, using the same analysis code and the same data/ folder.

  GET    /api/setup                      calibration in use, detection limits, settings
  POST   /api/setup/calibration          multipart `file`: store a calibration CSV
  POST   /api/setup/calibration/example  store the bundled simulated calibration
  DELETE /api/setup/calibration          remove the calibration
  POST   /api/setup/settings             JSON: buffer_ul, saliva_ul, ref_low, ref_high, launch_date, cal_unit
  POST   /api/measure                    multipart: file, current_unit, window_lo, window_hi, direction
                                         (+ save=1, crew_id, mission_phase, sampled_at, notes to save the reading)
  GET    /api/records                    saved readings
  DELETE /api/records/{id}               delete one reading
  GET    /api/records.csv[?ids=1,2]      download all (or the selected) readings
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from . import store
from .analysis import (ABOVE_RANGE, BELOW_LOQ, CONC_UNITS, CURRENT_UNITS, INSUFFICIENT, NOT_DETECTED, InputError,
                       current_factor, detection_limits, dilution_factor, find_peak, parse_calibration, parse_sample,
                       quantify, range_flag, read_csv, to_pg_per_ml)

EXAMPLE_CAL = Path(__file__).resolve().parents[1] / "sample_data" / "simulated_melatonin_calibration.csv"
PHASES = ["Pre-flight", "In-flight", "Post-flight"]
SETTING_KEYS = ("buffer_ul", "saliva_ul", "ref_low", "ref_high", "launch_date", "cal_unit")


def clean(x):
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple, np.ndarray)):
        return [clean(v) for v in x]
    if isinstance(x, (np.bool_, bool)):
        return bool(x)
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, (float, np.floating)):
        return None if not math.isfinite(float(x)) else float(x)
    if isinstance(x, pd.Timestamp):
        return None if pd.isna(x) else x.isoformat(timespec="minutes")
    if x is pd.NaT:
        return None
    return x


@dataclass
class SetupState:
    settings: dict
    cal_name: str | None = None
    cal: object = None
    unit: str | None = None
    unit_from_file: bool = False
    limits: object = None
    factor: float | None = None
    error: str | None = None

    @property
    def ready(self) -> bool:
        return self.limits is not None and bool(self.unit) and self.factor is not None

    @property
    def loq_saliva_pg(self) -> float | None:
        return to_pg_per_ml(self.limits.loq * self.factor, self.unit) if self.ready else None


def setup_state() -> SetupState:
    s = store.load_settings()
    st = SetupState(settings=s, factor=dilution_factor(s.get("buffer_ul"), s.get("saliva_ul")))
    cal_bytes, st.cal_name = store.load_calibration()
    if cal_bytes is None:
        return st
    try:
        st.cal = parse_calibration(read_csv(cal_bytes))
    except InputError as exc:
        st.error = str(exc)
        return st
    st.unit_from_file = bool(st.cal.unit)
    st.unit = st.cal.unit or (s.get("cal_unit") if s.get("cal_unit") in CONC_UNITS else None)
    st.limits = detection_limits(st.cal)
    if st.limits is None:
        st.error = INSUFFICIENT
    return st


def _role(request) -> str:
    return getattr(request.state, "role", "admin")      # no sign-in (local use) -> full rights


def _tester(request) -> str:
    return getattr(request.state, "tester", "Local user")


def _pg(value, unit):
    return to_pg_per_ml(value, unit) if unit and value is not None and math.isfinite(value) else None


# ----------------------------------------------------------------------------- setup
async def get_setup(request):
    st = setup_state()
    out = dict(settings={k: st.settings.get(k) for k in SETTING_KEYS}, conc_units=CONC_UNITS, current_units=CURRENT_UNITS,
               phases=PHASES, calibration=None, factor=st.factor, ready=st.ready, error=st.error,
               loq_saliva_pg=st.loq_saliva_pg, can_edit=_role(request) == "admin")
    if st.cal is not None:
        c, L, u = st.cal, st.limits, st.unit
        out["calibration"] = dict(
            name=st.cal_name, unit=u, unit_from_file=st.unit_from_file, response_unit=c.response_unit,
            n_rows=c.n_rows, n_valid=c.n_valid, n_levels=c.n_levels, simulated=c.simulated,
            points=[dict(x=float(x), y=float(y)) for x, y in zip(c.concentration, c.response)])
        if L is not None:
            f = st.factor
            out["limits"] = dict(
                lod=L.lod, loq=L.loq, sigma=L.sigma, slope=L.slope, intercept=L.intercept, r2=L.r2, c_min=L.c_min,
                c_max=L.c_max, lod_pg=_pg(L.lod, u), loq_pg=_pg(L.loq, u),
                lod_saliva=L.lod * f if f else None, loq_saliva=L.loq * f if f else None,
                lod_saliva_pg=_pg(L.lod * f, u) if f else None, loq_saliva_pg=_pg(L.loq * f, u) if f else None)
    return JSONResponse(clean(out))


async def post_calibration(request):
    form = await request.form()
    up = form.get("file")
    if up is None:
        return JSONResponse(dict(error="No file received."), status_code=400)
    data = await up.read()
    try:
        parse_calibration(read_csv(data))
    except InputError as exc:
        return JSONResponse(dict(error=str(exc)), status_code=400)
    store.save_calibration(data, up.filename or "calibration.csv")
    return await get_setup(request)


async def post_example(request):
    store.save_calibration(EXAMPLE_CAL.read_bytes(), EXAMPLE_CAL.name)
    return await get_setup(request)


async def delete_calibration(request):
    store.clear_calibration()
    return await get_setup(request)


async def post_settings(request):
    body = await request.json()
    s = store.load_settings()
    for k in SETTING_KEYS:
        if k in body:
            v = body[k]
            if k in ("buffer_ul", "saliva_ul", "ref_low", "ref_high"):
                v = None if v in (None, "") else float(v)
            elif k == "launch_date":
                v = None if not v else datetime.fromisoformat(str(v)).date().isoformat()
            s[k] = v
    store.save_settings(s)
    return await get_setup(request)


# ----------------------------------------------------------------------------- measure
async def post_measure(request):
    form = await request.form()
    up = form.get("file")
    if up is None:
        return JSONResponse(dict(error="Upload a DPV scan CSV."), status_code=400)
    st = setup_state()
    if not st.ready:
        return JSONResponse(dict(error="Finish Setup first: a valid calibration, its concentration units, and the "
                                       "buffer and saliva volumes."), status_code=400)
    data = await up.read()
    try:
        sample = parse_sample(read_csv(data))
    except InputError as exc:
        return JSONResponse(dict(error=str(exc)), status_code=400)
    current_unit = sample.current_unit or (form.get("current_unit") or None)
    lo, hi = float(sample.potential_V.min()), float(sample.potential_V.max())
    base = dict(file=up.filename, current_unit=current_unit, unit_from_file=bool(sample.current_unit),
                range=[lo, hi], n_rows=sample.n_rows, n_valid=sample.n_valid)
    if not current_unit:
        return JSONResponse(clean(dict(base, need_unit=True)))
    try:
        wlo = float(form.get("window_lo", lo))
        whi = float(form.get("window_hi", hi))
    except ValueError:
        wlo, whi = lo, hi
    direction = form.get("direction", "auto")
    direction = direction if direction in ("auto", "up", "down") else "auto"
    peak = find_peak(sample.potential_V, sample.current, (wlo, whi), direction)
    step = max(1, len(peak.e) // 400)
    out = dict(base, window=[wlo, whi], direction=direction,
               scan=dict(e=peak.e[::step], raw=peak.raw[::step], smooth=peak.smooth[::step]),
               peak=dict(found=peak.found, potential=peak.potential, height=peak.height, direction=peak.direction,
                         baseline_e=list(peak.baseline_e), baseline_i=list(peak.baseline_i),
                         baseline_at_peak=peak.baseline_at_peak, peak_current=peak.peak_current, at_edge=peak.at_edge))
    if not peak.found:
        out["message"] = "No peak stands out from the noise in this window. No concentration is reported."
        return JSONResponse(clean(out))

    cal, L, unit, f = st.cal, st.limits, st.unit, st.factor
    cal_unit = cal.response_unit or current_unit
    try:
        height = peak.height * current_factor(current_unit, cal_unit)
    except (InputError, ValueError, KeyError) as exc:
        out["message"] = str(exc)
        return JSONResponse(clean(out))
    res = quantify(height, peak.direction, cal, L, f)
    pg = to_pg_per_ml(res.saliva, unit)
    ref_low, ref_high = st.settings.get("ref_low"), st.settings.get("ref_high")
    flag = range_flag(pg, ref_low, ref_high) if (res.reportable and pg is not None) else None
    msg = {NOT_DETECTED: "The signal cannot be told apart from a blank. No concentration is reported.",
           BELOW_LOQ: "Melatonin is detected but too low to measure reliably. No concentration is reported.",
           ABOVE_RANGE: "The signal is above the highest calibration standard. Dilute the sample further and repeat."
           }.get(res.status, f"{flag} ({ref_low:g}–{ref_high:g} pg/mL). For flight-surgeon review." if flag else "")
    out["result"] = dict(
        status=res.status, reportable=res.reportable, height=height, cal_unit=cal_unit, unit=unit, factor=f,
        saliva=res.saliva if res.reportable else None, saliva_pg=pg if res.reportable else None,
        tube=res.tube if res.reportable else None, ci_saliva=res.ci_tube * f if res.reportable else None,
        loq_saliva_pg=st.loq_saliva_pg, max_saliva_pg=_pg(L.c_max * f, unit), reference_flag=flag,
        unit_assumed=cal.response_unit is None)
    out["message"] = msg

    if form.get("save") == "1":
        crew_id = str(form.get("crew_id", "")).strip()
        phase = form.get("mission_phase")
        try:
            sampled_at = datetime.fromisoformat(str(form.get("sampled_at"))).isoformat(timespec="minutes")
        except ValueError:
            return JSONResponse(dict(error="Enter a valid sample date and time."), status_code=400)
        if not crew_id or phase not in PHASES:
            return JSONResponse(dict(error="Enter a crew member ID and a mission phase."), status_code=400)
        simulated = cal.simulated or "simul" in (up.filename or "").lower()
        out["saved_id"] = store.add_reading(dict(
            crew_id=crew_id, mission_phase=phase, sampled_at=sampled_at, status=res.status,
            saliva_pg_ml=round(pg, 4) if (res.reportable and pg is not None) else None,
            saliva_conc=res.saliva if res.reportable else None, tube_conc=res.tube if res.reportable else None,
            conc_unit=unit, ci95_tube=res.ci_tube if res.reportable else None, reference_flag=flag,
            peak_potential_V=round(peak.potential, 4), peak_current=height, current_unit=cal_unit, dilution_factor=f,
            lod_tube=L.lod, loq_tube=L.loq, calibration_file=st.cal_name, sample_file=up.filename,
            data_origin="simulated" if simulated else "measured", notes=str(form.get("notes", "")),
            entered_by=_tester(request)))
    return JSONResponse(clean(out))


# ----------------------------------------------------------------------------- records
async def get_records(request):
    df = store.load_readings()
    st = setup_state()
    rows = []
    for r in df.sort_values("sampled_at").to_dict("records"):
        rows.append({k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in r.items()})
    return JSONResponse(clean(dict(rows=rows, loq_saliva_pg=st.loq_saliva_pg, ref_low=st.settings.get("ref_low"),
                                   ref_high=st.settings.get("ref_high"), tester=_tester(request),
                                   can_delete_all=_role(request) == "admin")))


async def delete_record(request):
    rid = int(request.path_params["rid"])
    if _role(request) != "admin":
        df = store.load_readings()
        row = df[df["reading_id"] == rid]
        if row.empty or str(row.iloc[0]["entered_by"]) != _tester(request):
            return JSONResponse(dict(error="You can delete only readings you entered."), status_code=403)
    store.delete_reading(rid)
    return await get_records(request)


async def records_csv(request):
    """All readings, or only those listed in ?ids=1,2,3 (the ticked rows in History)."""
    df = store.load_readings()
    ids = [int(x) for x in request.query_params.get("ids", "").split(",") if x.strip().isdigit()]
    name = "orbitclock_readings.csv"
    if ids:
        df = df[df["reading_id"].astype(int).isin(ids)]
        name = f"orbitclock_readings_selected_{len(df)}.csv"
    return Response(df.to_csv(index=False), media_type="text/csv",
                    headers={"Content-Disposition": f"attachment; filename={name}"})


routes = [
    Route("/api/setup", get_setup),
    Route("/api/setup/calibration", post_calibration, methods=["POST"]),
    Route("/api/setup/calibration", delete_calibration, methods=["DELETE"]),
    Route("/api/setup/calibration/example", post_example, methods=["POST"]),
    Route("/api/setup/settings", post_settings, methods=["POST"]),
    Route("/api/measure", post_measure, methods=["POST"]),
    Route("/api/records", get_records),
    Route("/api/records.csv", records_csv),
    Route("/api/records/{rid:int}", delete_record, methods=["DELETE"]),
]
