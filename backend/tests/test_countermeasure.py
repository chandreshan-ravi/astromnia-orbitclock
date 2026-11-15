from datetime import date

import numpy as np
import pandas as pd
import pytest

from orbitclock.countermeasure import AVOID, GIVE, NONE, RESAMPLE, crew_plans, plan_for
from orbitclock.engine import analyse
from orbitclock.records_bridge import records_to_samples
from orbitclock.schema import load_samples, load_sleep_log
from orbitclock.simulator import melatonin_curve, simulate_mission


def row(**kw):
    base = dict(astronaut_id="CM-X", day_label="FD10", mission_day=9, mission_phase="inflight", dlmo_status="ok",
                dlmo_clock_h=22.5, clock_offset_h=0.0, dlmo_conf="high", light_breach=False, n_mel=15, n_mel_censored=2)
    base.update(kw)
    return base


def test_late_clock_gets_low_dose_four_hours_before_dlmo():
    p = plan_for(row(clock_offset_h=2.2, dlmo_clock_h=22.75))
    assert p.action == GIVE and p.dose_mg == 0.5 and p.take_at_h == pytest.approx(18.75)
    assert p.window == (17.75, 19.75) and p.priority == "high"


def test_other_cases_give_no_dose():
    assert plan_for(row(clock_offset_h=0.4)).action == NONE
    assert plan_for(row(clock_offset_h=-1.5)).action == AVOID
    assert plan_for(row(light_breach=True, clock_offset_h=2.0)).action == RESAMPLE
    assert plan_for(row(dlmo_status="loq_above_threshold", n_mel_censored=15, clock_offset_h=np.nan)).action == RESAMPLE
    assert plan_for(row(clock_offset_h=np.nan)).action == RESAMPLE
    assert plan_for(row(mission_phase="preflight", clock_offset_h=3.0)).dose_mg == 0
    for p in (plan_for(row(clock_offset_h=0.4)), plan_for(row(clock_offset_h=-1.5))):
        assert p.dose_mg == 0


def test_simulated_drift_crew_member_is_dosed_during_drift_only():
    s, sl, _ = simulate_mission()
    m, _, _ = analyse(load_samples(s), load_sleep_log(sl), n_boot=50)
    by_id = {p.astronaut_id: p for p in crew_plans(m, as_of_day=17)}      # FD18, drift at its peak
    assert by_id["CM-B"].action == GIVE
    assert by_id["CM-C"].action != GIVE
    assert all(p.action != GIVE for p in crew_plans(m, as_of_day=-4))     # pre-flight


def test_records_feed_the_engine():
    launch = date(2027, 3, 1)
    t = np.arange(16.0, 24.01, 0.5)
    rows = []
    for day, phase in ((-10, "Pre-flight"), (-5, "Pre-flight"), (10, "In-flight")):
        shift = 2.0 if day == 10 else 0.0
        for ti, vi in zip(t, melatonin_curve(t - 21.0 - shift, 20.0, 0.8)):
            rows.append(dict(reading_id=len(rows) + 1, crew_id="CM-A", mission_phase=phase,
                             sampled_at=pd.Timestamp(launch) + pd.Timedelta(days=day, hours=float(ti)),
                             status="Quantified" if vi >= 1.0 else "Detected, below LOQ",
                             saliva_pg_ml=vi if vi >= 1.0 else None, conc_unit="pg/mL", loq_tube=0.2,
                             dilution_factor=5.0, data_origin="simulated"))
    samples, skipped = records_to_samples(pd.DataFrame(rows), launch)
    assert skipped == 0 and set(samples["mission_day"]) == {-10, -5, 10}
    m, _, _ = analyse(load_samples(samples), load_sleep_log(None), n_boot=50)
    plan = crew_plans(m)[0]
    assert plan.action == GIVE and plan.offset_h == pytest.approx(2.0, abs=0.3)
