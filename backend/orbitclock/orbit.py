"""Live orbital light-dark cycle of the International Space Station.

The ISS orbit is propagated with SGP4 from the latest public two-line element set (TLE) published by
CelesTrak (refreshed every 6 h; a bundled TLE is used when offline). Sun direction uses the low-precision
solar position from the Astronomical Almanac, and the station is in eclipse when it is inside Earth's
cylindrical shadow. Accuracy is about a minute for sunrise/sunset times, which is enough to show why the
crew's body clock cannot rely on the window light: NASA's Human Research Program notes 16 sunrises and
sunsets a day aboard the station.
"""
from __future__ import annotations

import ssl
import time
import urllib.request
from pathlib import Path

import numpy as np
from sgp4.api import Satrec

try:
    import certifi
    _SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # pragma: no cover
    _SSL = ssl.create_default_context()

TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE"
BUNDLED = Path(__file__).with_name("iss_tle.txt")
EARTH_R_KM = 6378.137
REFRESH_S = 6 * 3600
_cache: dict = {}


def _parse(text: str) -> tuple[str, str]:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    l1 = next(ln for ln in lines if ln.startswith("1 "))
    l2 = next(ln for ln in lines if ln.startswith("2 "))
    return l1, l2


def get_tle() -> tuple[str, str, str]:
    """(line1, line2, source). Live from CelesTrak when reachable, else the last good or bundled TLE."""
    now = time.time()
    if _cache.get("t", 0) > now - REFRESH_S:
        return _cache["l1"], _cache["l2"], _cache["src"]
    try:
        req = urllib.request.Request(TLE_URL, headers={"User-Agent": "orbitclock/1.0"})
        with urllib.request.urlopen(req, timeout=8, context=_SSL) as r:
            l1, l2 = _parse(r.read().decode("ascii", "replace"))
        Satrec.twoline2rv(l1, l2)  # validate
        _cache.update(t=now, l1=l1, l2=l2, src="CelesTrak (live TLE)")
    except Exception:
        if "l1" not in _cache:
            l1, l2 = _parse(BUNDLED.read_text())
            _cache.update(l1=l1, l2=l2, src="bundled TLE (offline)")
        _cache["t"] = now - REFRESH_S + 600  # retry in 10 min
    return _cache["l1"], _cache["l2"], _cache["src"]


def _jd(unix: np.ndarray) -> np.ndarray:
    return unix / 86400.0 + 2440587.5


def _sun_unit(jd: np.ndarray) -> np.ndarray:
    n = jd - 2451545.0
    L = np.radians((280.460 + 0.9856474 * n) % 360)
    g = np.radians((357.528 + 0.9856003 * n) % 360)
    lam = L + np.radians(1.915) * np.sin(g) + np.radians(0.020) * np.sin(2 * g)
    eps = np.radians(23.439 - 0.0000004 * n)
    return np.stack([np.cos(lam), np.cos(eps) * np.sin(lam), np.sin(eps) * np.sin(lam)], axis=-1)


def propagate(unix: np.ndarray):
    """Position (km, TEME), sunlit flag, latitude, longitude and altitude at each unix time."""
    l1, l2, _ = get_tle()
    sat = Satrec.twoline2rv(l1, l2)
    jd = _jd(unix)
    whole = np.floor(jd - 0.5) + 0.5
    err, r, _v = sat.sgp4_array(whole, jd - whole)
    r = np.asarray(r)
    s = _sun_unit(jd)
    along = np.einsum("ij,ij->i", r, s)
    perp = np.linalg.norm(r - along[:, None] * s, axis=1)
    sunlit = ~((along < 0) & (perp < EARTH_R_KM))
    gmst = np.radians((280.46061837 + 360.98564736629 * (jd - 2451545.0)) % 360)
    lon = (np.degrees(np.arctan2(r[:, 1], r[:, 0]) - gmst) + 540) % 360 - 180
    lat = np.degrees(np.arctan2(r[:, 2], np.hypot(r[:, 0], r[:, 1])))
    alt = np.linalg.norm(r, axis=1) - EARTH_R_KM
    return sunlit & (np.asarray(err) == 0), lat, lon, alt


def orbit_payload(now: float | None = None, step_s: int = 20) -> dict:
    now = time.time() if now is None else now
    t = np.arange(now - 24 * 3600, now + 12 * 3600 + step_s, step_s, dtype=float)
    sunlit, lat, lon, alt = propagate(t)
    change = np.nonzero(np.diff(sunlit.astype(int)))[0] + 1
    events = [dict(t=float(t[i]), kind="sunrise" if sunlit[i] else "sunset") for i in change]
    i_now = int(np.searchsorted(t, now))
    past = [e for e in events if now - 24 * 3600 <= e["t"] <= now]
    sunrises_24h = sum(e["kind"] == "sunrise" for e in past)
    nxt = next((e for e in events if e["t"] > now), None)
    # segments for the 24 h light strip (now - 12 h .. now + 12 h)
    lo, hi = now - 12 * 3600, now + 12 * 3600
    cuts = [lo] + [e["t"] for e in events if lo < e["t"] < hi] + [hi]
    segs = []
    for a, b in zip(cuts[:-1], cuts[1:]):
        k = int(np.searchsorted(t, (a + b) / 2))
        segs.append(dict(start=a, end=b, sunlit=bool(sunlit[min(k, len(t) - 1)])))
    # ground track: one orbit back and one forward, every 60 s
    l1, l2, src = get_tle()
    period_min = 1440.0 / float(l2[52:63])
    span = int(period_min * 60 / step_s)
    sel = range(max(0, i_now - span), min(len(t), i_now + span), max(1, 60 // step_s))
    track = [dict(t=float(t[i]), lat=round(float(lat[i]), 3), lon=round(float(lon[i]), 3), sunlit=bool(sunlit[i])) for i in sel]
    sat = Satrec.twoline2rv(l1, l2)
    n = _jd(np.array([now]))[0] - 2451545.0
    sun = _sun_unit(np.array([_jd(np.array([now]))[0]]))[0]
    gmst = np.radians((280.46061837 + 360.98564736629 * n) % 360)
    return dict(
        now=now, source=src, tle_epoch=float((sat.jdsatepoch + sat.jdsatepochF - 2440587.5) * 86400),
        sunlit=bool(sunlit[i_now]), lat=float(lat[i_now]), lon=float(lon[i_now]), alt_km=float(alt[i_now]),
        period_min=period_min, sunrises_24h=sunrises_24h, sunsets_24h=sum(e["kind"] == "sunset" for e in past),
        next_event=nxt, events=[e for e in events if lo <= e["t"] <= hi], segments=segs, track=track,
        subsolar=dict(lat=float(np.degrees(np.arcsin(sun[2]))),
                      lon=float((np.degrees(np.arctan2(sun[1], sun[0]) - gmst) + 540) % 360 - 180)),
    )
