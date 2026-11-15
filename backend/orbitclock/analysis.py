"""Calibration fit and detection limits.

Reduced from the team's SPCE-DPV Sample Analyzer (spce_dpv/analysis.py): the linear
fit still uses scipy.stats.linregress with a free intercept, and the unit tables are
the same. Everything not needed for LOD and LOQ has been removed.

    LOD = 3.3 * sigma / |slope|        LOQ = 10 * sigma / |slope|

sigma is the residual standard deviation of the calibration regression,
sqrt(sum(residual^2) / (n - 2)). Limits come from the calibration data only.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.signal import find_peaks, savgol_filter
from scipy.stats import linregress
from scipy.stats import t as student_t

INSUFFICIENT = "Insufficient calibration data."
MIN_POINTS = 3     # residual SD needs n - 2 >= 1
MIN_LEVELS = 3     # two levels always fit a line exactly, so they cannot test linearity

CONC_UNITS = ["pM", "nM", "µM", "mM", "M", "pg/mL", "ng/mL", "µg/mL", "mg/mL"]
CURRENT_UNITS = ["A", "mA", "µA", "nA", "A/cm²", "mA/cm²", "µA/cm²", "nA/cm²"]
POTENTIAL_SCALE = {"V": 1.0, "mV": 1e-3}


class InputError(ValueError):
    pass


def read_csv(data: bytes) -> pd.DataFrame:
    try:
        df = pd.read_csv(io.BytesIO(data), sep=None, engine="python")
    except Exception as exc:
        raise InputError(f"The file could not be read as CSV ({exc}).") from exc
    df.columns = [str(c).strip() for c in df.columns]
    return df


def _norm(text: str) -> str:
    return str(text).replace("μ", "µ").replace("²", "2")


def _find(columns, pattern, exclude=()):
    for c in columns:
        if c not in exclude and re.search(pattern, _norm(c), flags=re.I):
            return c
    return None


def _unit_in(header: str, units) -> str | None:
    """Unit written in a column header, e.g. concentration_nM, i(A/cm²), 'current (uA)'."""
    h = _norm(header)
    for u in sorted(units, key=len, reverse=True):
        token = _norm(u).replace("µ", "[µu]")
        token = re.escape(token).replace(r"\[µu\]", "[µu]")
        if re.search(rf"(?:^|[_\s(\[/]){token}(?:$|[_\s)\]])", h):
            return u
    return None


# ----------------------------------------------------------------------------- calibration
@dataclass(frozen=True)
class CalibrationData:
    concentration: np.ndarray
    response: np.ndarray
    unit: str | None          # concentration unit from the header, or None if not stated
    n_rows: int               # rows in the file
    n_valid: int              # rows used
    n_levels: int             # distinct concentrations among rows used
    simulated: bool
    response_unit: str | None = None   # peak-current unit from the header, or None if not stated


def parse_calibration(df: pd.DataFrame) -> CalibrationData:
    cols = list(df.columns)
    conc_col = _find(cols, r"conc|standard|level")
    resp_col = _find(cols, r"peak|current|response|signal|^i[_\s(]|^ip\b", exclude=(conc_col,))
    if conc_col is None or resp_col is None:
        numeric = [c for c in cols if pd.to_numeric(df[c], errors="coerce").notna().mean() > 0.9]
        if len(cols) == 2 and len(numeric) == 2:
            conc_col, resp_col = cols
        else:
            raise InputError("Could not find a concentration column and a peak-current column. "
                             "Name them, for example, concentration_nM and peak_current_uA.")
    work = pd.DataFrame({"c": pd.to_numeric(df[conc_col], errors="coerce"),
                         "y": pd.to_numeric(df[resp_col], errors="coerce")})
    if "exclude" in [c.lower() for c in cols]:      # honour the analyzer's manual-exclusion column
        flag = df[[c for c in cols if c.lower() == "exclude"][0]].astype(str).str.strip().str.lower()
        work = work[~flag.isin(("true", "1", "yes"))]
    work = work.replace([np.inf, -np.inf], np.nan).dropna()
    work = work[work["c"] >= 0]
    origin = _find(cols, r"origin")
    simulated = bool(origin is not None and df[origin].astype(str).str.contains("simul|synth", case=False).any())
    return CalibrationData(work["c"].to_numpy(float), work["y"].to_numpy(float), _unit_in(conc_col, CONC_UNITS),
                           int(len(df)), int(len(work)), int(work["c"].nunique()), simulated, _unit_in(resp_col, CURRENT_UNITS))


@dataclass(frozen=True)
class Limits:
    lod: float
    loq: float
    sigma: float
    slope: float
    intercept: float
    n: int
    r2: float = float("nan")
    c_min: float = float("nan")
    c_max: float = float("nan")
    x_mean: float = float("nan")
    sxx: float = float("nan")
    y_mean: float = float("nan")


def detection_limits(cal: CalibrationData) -> Limits | None:
    """LOD and LOQ from the calibration regression, or None when the data are insufficient."""
    if cal.n_valid < MIN_POINTS or cal.n_levels < MIN_LEVELS:
        return None
    fit = linregress(cal.concentration, cal.response)           # x = concentration, y = peak current
    residuals = cal.response - (fit.intercept + fit.slope * cal.concentration)
    sigma = float(np.sqrt(np.sum(residuals ** 2) / (cal.n_valid - 2)))
    scale = float(np.max(np.abs(cal.response)))
    span = abs(fit.slope) * float(np.ptp(cal.concentration))
    # a flat line gives no sensitivity; an exact fit gives no scatter to estimate sigma from
    if not np.isfinite(fit.slope) or not np.isfinite(sigma) or span <= 1e-9 * scale or sigma <= 1e-9 * scale:
        return None
    return Limits(3.3 * sigma / abs(fit.slope), 10.0 * sigma / abs(fit.slope), sigma,
                  float(fit.slope), float(fit.intercept), cal.n_valid, float(fit.rvalue ** 2),
                  float(cal.concentration.min()), float(cal.concentration.max()), float(cal.concentration.mean()),
                  float(np.sum((cal.concentration - cal.concentration.mean()) ** 2)), float(cal.response.mean()))


# ----------------------------------------------------------------------------- DPV sample
@dataclass(frozen=True)
class SampleTrace:
    potential_V: np.ndarray
    current: np.ndarray
    current_unit: str | None   # from the header, or None if not stated
    n_rows: int
    n_valid: int


def parse_sample(df: pd.DataFrame) -> SampleTrace:
    cols = list(df.columns)
    pot_col = _find(cols, r"potential|volt|^e$|^e[_\s(]")
    cur_col = _find(cols, r"current|^i$|^i[_\s(]|^j[_\s(]", exclude=(pot_col,))
    if pot_col is None or cur_col is None:
        raise InputError("Could not find a potential column and a current column. "
                         "Name them, for example, potential_V and current_uA.")
    scale = POTENTIAL_SCALE["mV"] if _unit_in(pot_col, ["mV"]) else POTENTIAL_SCALE["V"]
    work = pd.DataFrame({"e": pd.to_numeric(df[pot_col], errors="coerce") * scale,
                         "i": pd.to_numeric(df[cur_col], errors="coerce")}).replace([np.inf, -np.inf], np.nan).dropna()
    if len(work) < 3:
        raise InputError("The sample file has fewer than three numeric potential/current rows.")
    return SampleTrace(work["e"].to_numpy(float), work["i"].to_numpy(float), _unit_in(cur_col, CURRENT_UNITS),
                       int(len(df)), int(len(work)))


def fmt(value: float) -> str:
    """Three significant figures, no scientific notation for ordinary magnitudes."""
    if value == 0 or not np.isfinite(value):
        return str(value)
    if 1e-3 <= abs(value) < 1e6:
        decimals = max(0, 2 - int(np.floor(np.log10(abs(value)))))
        return f"{value:,.{decimals}f}"
    return f"{value:.2e}"


# ----------------------------------------------------------------------------- buffered saliva
MELATONIN_G_PER_MOL = 232.28
_TO_MOLAR = {"pM": 1e-12, "nM": 1e-9, "µM": 1e-6, "mM": 1e-3, "M": 1.0}
_TO_G_PER_ML = {"pg/mL": 1e-12, "ng/mL": 1e-9, "µg/mL": 1e-6, "mg/mL": 1e-3}


def dilution_factor(buffer_volume: float | None, saliva_volume: float | None) -> float | None:
    """Saliva is mixed into a fixed volume of buffer: factor = (buffer + saliva) / saliva."""
    if buffer_volume is None or saliva_volume is None or buffer_volume < 0 or saliva_volume <= 0:
        return None
    return (buffer_volume + saliva_volume) / saliva_volume


def to_pg_per_ml(value: float, unit: str) -> float | None:
    """Melatonin concentration in pg/mL, for comparison with reported saliva levels."""
    if unit in _TO_MOLAR:
        return value * _TO_MOLAR[unit] * MELATONIN_G_PER_MOL * 1e12 / 1e3   # mol/L -> g/L -> pg/mL
    if unit in _TO_G_PER_ML:
        return value * _TO_G_PER_ML[unit] * 1e12
    return None


def to_pm(value: float, unit: str) -> float | None:
    """Melatonin concentration in pmol/L."""
    pg = to_pg_per_ml(value, unit)
    return None if pg is None else pg / MELATONIN_G_PER_MOL * 1e3


# ----------------------------------------------------------------------------- current units
_CURRENT_TO_A = {"A": 1.0, "mA": 1e-3, "µA": 1e-6, "nA": 1e-9}


def current_factor(from_unit: str, to_unit: str) -> float:
    """Multiplier that converts a current from one unit to another. Density and plain current do not mix."""
    f_density, t_density = from_unit.endswith("/cm²"), to_unit.endswith("/cm²")
    if f_density != t_density:
        raise InputError(f"The sample current is in {from_unit} but the calibration is in {to_unit}. "
                         "Current and current density cannot be compared; use the same quantity for both.")
    return _CURRENT_TO_A[from_unit.replace("/cm²", "")] / _CURRENT_TO_A[to_unit.replace("/cm²", "")]


# ----------------------------------------------------------------------------- peak
def _lower_hull(x, y):
    hull = []
    for p in zip(x, y):
        while len(hull) >= 2:
            (x1, y1), (x2, y2) = hull[-2], hull[-1]
            if (x2 - x1) * (p[1] - y1) - (y2 - y1) * (p[0] - x1) <= 0:
                hull.pop()
            else:
                break
        hull.append(p)
    return np.array(hull)


@dataclass(frozen=True)
class Peak:
    found: bool
    e: np.ndarray
    raw: np.ndarray
    smooth: np.ndarray
    potential: float = float("nan")
    height: float = float("nan")        # magnitude above the baseline, always positive
    direction: int = 1                  # +1 peak points up, -1 peak points down
    baseline_at_peak: float = float("nan")
    peak_current: float = float("nan")
    baseline_e: tuple = ()
    baseline_i: tuple = ()
    at_edge: bool = False
    n_candidates: int = 0


def find_peak(potential, current, window: tuple[float, float] | None = None, direction: str = "auto") -> Peak:
    """Main DPV peak and its height above a rubber-band baseline.

    The baseline is the convex hull under the curve within 0.3 V either side of the peak,
    so the height is a baseline-corrected peak current, matching the calibration's response.
    """
    e = np.asarray(potential, float)
    i = np.asarray(current, float)
    order = np.argsort(e, kind="stable")
    e, i = e[order], i[order]
    if window is not None:
        keep = (e >= min(window)) & (e <= max(window))
        e, i = e[keep], i[keep]
    n = len(e)
    if n < 7:
        return Peak(False, e, i, i)
    win = min(11, n if n % 2 else n - 1)
    smooth = savgol_filter(i, win, 3) if win >= 5 else i.copy()
    noise = float(np.std(i - smooth)) if win >= 5 else 0.0
    floor = max(5 * noise, 0.02 * float(np.ptp(smooth)), 1e-15)
    best = None
    for sign in ((1, -1) if direction == "auto" else ((1,) if direction == "up" else (-1,))):
        idx, props = find_peaks(sign * smooth, prominence=floor)
        if len(idx):
            k = int(np.argmax(props["prominences"]))
            if best is None or props["prominences"][k] > best[2]:
                best = (sign, int(idx[k]), float(props["prominences"][k]), len(idx))
    if best is None:
        return Peak(False, e, i, smooth)
    sign, k, _, n_cand = best
    lo = int(np.searchsorted(e, e[k] - 0.3, side="left"))
    hi = int(np.searchsorted(e, e[k] + 0.3, side="right")) - 1
    y = sign * smooth
    hull = _lower_hull(e[lo:hi + 1], y[lo:hi + 1])
    base = float(np.interp(e[k], hull[:, 0], hull[:, 1]))
    j = int(np.searchsorted(hull[:, 0], e[k], side="right")) - 1
    j = min(max(j, 0), len(hull) - 2) if len(hull) > 1 else 0
    seg = hull[j:j + 2]
    return Peak(True, e, i, smooth, float(e[k]), float(y[k] - base), sign, sign * base, float(smooth[k]),
                tuple(seg[:, 0]), tuple(sign * seg[:, 1]), k <= 1 or k >= n - 2, n_cand)


# ----------------------------------------------------------------------------- concentration
NOT_DETECTED = "Not detected (below LOD)"
BELOW_LOQ = "Detected, below LOQ"
QUANTIFIED = "Quantified"
ABOVE_RANGE = "Above calibration range"


@dataclass(frozen=True)
class Result:
    response: float            # peak current in the calibration's current unit, signed like the calibration
    tube: float                # concentration in the buffered sample
    saliva: float              # concentration in undiluted saliva
    ci_tube: float             # 95% half-width for the buffered-sample concentration
    status: str
    reportable: bool           # True only when the value may be reported as a concentration


def quantify(peak_height: float, peak_direction: int, cal: CalibrationData, limits: Limits, factor: float) -> Result:
    """Concentration from the calibration line, with the LOQ rule from the project proposal:
    a reading below the LOQ is not reported as a concentration."""
    # the calibration may list downward peaks as negative numbers; follow its convention
    signed = -peak_height if (peak_direction < 0 and np.median(cal.response) < 0) else peak_height
    tube = (signed - limits.intercept) / limits.slope
    se = (limits.sigma / abs(limits.slope)) * np.sqrt(1 + 1 / limits.n + (signed - limits.y_mean) ** 2
                                                       / (limits.slope ** 2 * limits.sxx))
    ci = float(student_t.ppf(0.975, limits.n - 2) * se)
    if tube < limits.lod:
        status = NOT_DETECTED
    elif tube < limits.loq:
        status = BELOW_LOQ
    elif tube > limits.c_max:
        status = ABOVE_RANGE
    else:
        status = QUANTIFIED
    return Result(float(signed), float(tube), float(tube * factor), ci, status, status == QUANTIFIED)


def range_flag(saliva_pg_ml: float, low: float | None, high: float | None) -> str | None:
    if low is None or high is None or high <= low:
        return None
    return "Below reference range" if saliva_pg_ml < low else ("Above reference range" if saliva_pg_ml > high else "Within reference range")
