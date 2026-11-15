// Types and fetch helpers for the OrbitClock data API (orbitclock5/api.py, proxied at /api).

export type Plan = {
  action: string;
  headline: string;
  dose_mg: number;
  take_at: string | null;
  take_at_h: number | null;
  window: string[];
  priority: string;
  dose_text: string;
  reasons: string[];
  light: string[];
};

export type Series = {
  t: number[];
  v: (number | null)[];
  censored: boolean[];
  loq: number;
  lux: (number | null)[] | null;
  threshold: number;
  dlmo_h: number | null;
  ci_low: number | null;
  ci_high: number | null;
};

export type Row = {
  crew: string;
  day: number;
  label: string;
  phase: string;
  level: string;
  headline: string;
  dlmo_status: string;
  dlmo: string | null;
  dlmo_h: number | null;
  offset_h: number | null;
  confidence: string;
  light_breach: boolean;
  n_mel: number | null;
  n_censored: number | null;
  sleep_onset_h: number | null;
  wake_h: number | null;
  findings: string[];
  timing: string[];
  plan: Plan;
  series: Series | null;
};

export type Crew = { id: string; role: string; scenario: string; baseline_dlmo: string | null; baseline_dlmo_h: number | null };
export type Session = { day: number; label: string; phase: string };

export type Mission = {
  source: "sim" | "records";
  error?: string;
  sessions: Session[];
  crew: Crew[];
  rows: Row[];
  watch_h: number;
  alert_h: number;
  threshold: number;
  sensor?: string;
  sensor_loq?: number;
  interval_h?: number;
  seed?: number;
  skipped?: number;
  simulated_files?: boolean;
  launch?: string;
};

export type Options = {
  sensors: { label: string; method: string; loq: number; yours: boolean }[];
  default_sensor: string;
  cortisol: string[];
  your_loq: number | null;
  records: { count: number; crew: string[]; launch: string | null };
};

export type Sensitivity = {
  rows: { loq: number; interval_h: number; within_30min_pct: number; within_60min_pct: number; estimated_pct: number; mae_min: number | null }[];
  required_30: number | null;
  required_60: number | null;
  references: { label: string; loq: number }[];
  your_loq: number | null;
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (res.status === 401) window.dispatchEvent(new Event("oc-unauthorized"));
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchOptions = () => get<Options>("/api/options");
export const fetchSensitivity = () => get<Sensitivity>("/api/sensitivity");
export const fetchMission = (p: { source: string; sensor: string; cortisol: string; interval: number; seed: number }) =>
  get<Mission>(`/api/mission?${new URLSearchParams({
    source: p.source, sensor: p.sensor, cortisol: p.cortisol, interval: String(p.interval), seed: String(p.seed)
  })}`);

export function fmtClock(h: number | null | undefined): string {
  if (h === null || h === undefined || Number.isNaN(h)) return "—";
  const m = Math.round((((h % 24) + 24) % 24) * 60) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function fmtOffset(h: number | null | undefined): string {
  return h === null || h === undefined ? "—" : `${h >= 0 ? "+" : "−"}${Math.abs(h).toFixed(1)} h`;
}

export const STATUS: Record<string, { label: string; cls: string }> = {
  alert: { label: "ALERT", cls: "alert" },
  watch: { label: "WATCH", cls: "watch" },
  ok: { label: "STABLE", cls: "stable" },
  unknown: { label: "NO READING", cls: "unknown" },
  baseline: { label: "BASELINE", cls: "baseline" },
};

export const CREW_COLOURS = ["#65e6d0", "#f2bd72", "#b49aff", "#72bfff", "#ff8fa3", "#c6e66a"];
