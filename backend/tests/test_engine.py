import numpy as np
import pandas as pd
import pytest

from orbitclock.engine import analyse, circ_diff, cortisol_metrics, estimate_dlmo
from orbitclock.schema import SchemaError, load_samples, load_sleep_log
from orbitclock.sensitivity import required_loq, run_sensitivity
from orbitclock.simulator import melatonin_curve, simulate_mission


def clean_night(interval=0.5, peak=20.0, base=0.8, dlmo=21.0):
    t = np.arange(17.0, 24.0 + 1e-9, interval)
    return t, melatonin_curve(t - dlmo, peak, base)


def test_fixed_threshold_recovers_onset_on_clean_data():
    for interval in (0.5, 1.0):
        t, v = clean_night(interval)
        r = estimate_dlmo(t, v, np.zeros_like(t, bool), 1.35, n_boot=0)
        assert r["status"] == "ok" and r["method"] == "fixed_3pg"
        assert abs(r["dlmo_h"] - 21.0) < 0.25


def test_readings_below_loq_still_bracket_the_onset():
    t, v = clean_night()
    below = v < 1.35
    r = estimate_dlmo(t, np.where(below, np.nan, v), below, 1.35, n_boot=50)
    assert r["status"] == "ok" and r["n_censored"] > 0
    assert abs(r["dlmo_h"] - 21.0) < 0.25
    assert r["ci_low"] <= r["dlmo_h"] <= r["ci_high"]


def test_insensitive_sensor_is_flagged_and_biased_late():
    t, v = clean_night()
    below = v < 10.0
    r = estimate_dlmo(t, np.where(below, np.nan, v), below, 10.0, n_boot=0)
    assert r["method"] == "loq_crossing"
    assert r["dlmo_h"] > 21.5
    assert any("LATER" in n for n in r["notes"])


def test_plain_electrode_cannot_see_anything():
    t, v = clean_night()
    r = estimate_dlmo(t, np.full_like(v, np.nan), np.ones_like(t, bool), 250_000.0, n_boot=0)
    assert r["status"] == "all_below_loq"


def test_onset_outside_window():
    t, v = clean_night(dlmo=27.0)
    assert estimate_dlmo(t, v, np.zeros_like(t, bool), 1.35, n_boot=0)["status"] == "not_reached"
    t, v = clean_night(dlmo=15.0)
    assert estimate_dlmo(t, v, np.zeros_like(t, bool), 1.35, n_boot=0)["status"] == "already_above"


def test_low_producer_falls_back():
    t = np.arange(17.0, 24.01, 0.5)
    v = 0.6 + 1.6 / (1 + np.exp(-(t - 21.5) / 0.4))  # never reaches 3 pg/mL
    r = estimate_dlmo(t, v, np.zeros_like(t, bool), 0.3, n_boot=0)
    assert r["status"] == "ok" and r["method"] == "variable_3k"


def test_cortisol_metrics():
    m = cortisol_metrics([0, 0.5, 0.75, 6, 15.5], [12, 20, 19, 5, 2], [False] * 5, 0.3)
    assert m["car_delta"] == pytest.approx(8.0)
    assert m["evening_cort"] == pytest.approx(2.0)
    assert m["slope"] == pytest.approx((2 - 12) / 15.5)
    assert m["car_auci"] > 0


def test_circ_diff_wraps_midnight():
    assert circ_diff(0.5, 23.5) == pytest.approx(1.0)
    assert circ_diff(23.5, 0.5) == pytest.approx(-1.0)


def test_end_to_end_scenarios():
    samples, sleep, truth = simulate_mission(seed=7)
    m, base, _ = analyse(load_samples(samples), load_sleep_log(sleep), n_boot=100)
    m = m.merge(truth, on=["astronaut_id", "mission_day"])
    err = np.abs(circ_diff(m["dlmo_clock_h"], m["true_dlmo_clock_h"]))
    clean = m[~m["light_breach"]]
    assert np.abs(circ_diff(clean["dlmo_clock_h"], clean["true_dlmo_clock_h"])).max() < 0.5
    infl = m[m["mission_phase"] == "inflight"]
    # drift scenario: clock alert raised, and explained as a timing effect rather than stress
    b = infl[infl["astronaut_id"] == "CM-B"]
    assert (b["level"] == "alert").any()
    assert all(i["flags"]["clock"] for i in b[b["level"] == "alert"]["interp"])
    # stress scenario: cortisol flagged while the clock stays aligned
    c = infl[infl["astronaut_id"] == "CM-C"]
    flagged = c[c["level"].isin(["watch", "alert"])]
    assert len(flagged) >= 2
    assert all(i["flags"]["hpa"] and not i["flags"]["clock"] for i in flagged["interp"])
    # nominal: nothing above 'watch', and the lighting breach is caught
    a = infl[infl["astronaut_id"] == "CM-A"]
    assert not (a["level"] == "alert").any()
    assert a[a["light_breach"]]["interp"].iloc[0]["flags"]["artefact"]
    assert (m[m["mission_phase"] == "preflight"]["level"] == "baseline").all()


def test_csv_round_trip(tmp_path):
    samples, sleep, _ = simulate_mission(seed=3)
    samples.to_csv(tmp_path / "s.csv", index=False)
    sleep.to_csv(tmp_path / "l.csv", index=False)
    m1, _, _ = analyse(load_samples(samples), load_sleep_log(sleep), n_boot=0)
    m2, _, _ = analyse(load_samples(pd.read_csv(tmp_path / "s.csv")), load_sleep_log(pd.read_csv(tmp_path / "l.csv")), n_boot=0)
    assert np.allclose(m1["dlmo_clock_h"], m2["dlmo_clock_h"], equal_nan=True)
    assert list(m1["level"]) == list(m2["level"])


def test_schema_rejects_bad_input():
    samples, _, _ = simulate_mission(seed=3)
    with pytest.raises(SchemaError):
        load_samples(samples.drop(columns=["loq"]))
    bad = samples.copy()
    bad.loc[bad["analyte"] == "cortisol", "unit"] = "ug/dL"
    with pytest.raises(SchemaError):
        load_samples(bad)


def test_sensor_requirement():
    df = run_sensitivity(n_nights=150, seed=1)
    assert 2.0 <= required_loq(df, 0.5, 90.0) <= 4.0
    assert df[df["loq"] >= 40]["within_30min_pct"].max() == 0
