"""Orbit model: offline (bundled TLE) checks against a live ISS fix and basic orbital facts."""
import numpy as np
import pytest

from orbitclock import orbit


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    l1, l2 = orbit._parse(orbit.BUNDLED.read_text())
    monkeypatch.setattr(orbit, "_cache", dict(t=1e18, l1=l1, l2=l2, src="bundled TLE (offline)"))


def test_matches_live_fix():
    # api.wheretheiss.at at unix 1794726459: lat 25.11, lon -90.65, "eclipsed"
    sunlit, lat, lon, alt = orbit.propagate(np.array([1794726459.0]))
    assert abs(lat[0] - 25.11) < 1.0 and abs(lon[0] + 90.65) < 1.0
    assert 380 < alt[0] < 460
    assert not sunlit[0]


def test_about_16_sunrises_a_day():
    p = orbit.orbit_payload(now=1794726459.0)
    assert 90 < p["period_min"] < 95
    assert 14 <= p["sunrises_24h"] <= 16
    assert p["next_event"] and p["next_event"]["kind"] == "sunrise"
    assert abs(sum(s["end"] - s["start"] for s in p["segments"]) - 24 * 3600) < 1
