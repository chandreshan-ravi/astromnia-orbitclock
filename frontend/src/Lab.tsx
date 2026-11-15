// Settings (calibration), Results (DPV scan → melatonin level → dose), History and Trends; served by backend/orbitclock/lab_api.py.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CircleCheck, Download, Droplet, Package, Pill, Timer, TriangleAlert, Upload, Zap } from "lucide-react";
import {
  CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis, ZAxis
} from "recharts";
import { CREW_COLOURS, type Mission, type Row } from "./api";
import { NASA_RESOURCES, unauthorized } from "./Access";

const TIP = { background: "#0a1b26", border: "1px solid #28515d", borderRadius: 8, fontSize: 11 };

// ----------------------------------------------------------------------------- types + helpers
type Settings = { buffer_ul: number | null; saliva_ul: number | null; ref_low: number | null; ref_high: number | null; launch_date: string | null; cal_unit: string | null };
type Limits = {
  lod: number; loq: number; sigma: number; slope: number; intercept: number; r2: number; c_min: number; c_max: number;
  lod_pg: number | null; loq_pg: number | null; lod_saliva: number | null; loq_saliva: number | null;
  lod_saliva_pg: number | null; loq_saliva_pg: number | null;
};
export type SetupInfo = {
  settings: Settings; conc_units: string[]; current_units: string[]; phases: string[]; factor: number | null;
  ready: boolean; error: string | null; loq_saliva_pg: number | null; can_edit: boolean;
  calibration: null | {
    name: string; unit: string | null; unit_from_file: boolean; response_unit: string | null; n_rows: number;
    n_valid: number; n_levels: number; simulated: boolean; points: { x: number; y: number }[];
  };
  limits?: Limits;
};
type MeasureResult = {
  error?: string; file?: string; current_unit?: string | null; unit_from_file?: boolean; need_unit?: boolean;
  range?: [number, number]; window?: [number, number]; direction?: string; message?: string; saved_id?: number;
  scan?: { e: number[]; raw: number[]; smooth: number[] };
  peak?: { found: boolean; potential: number; height: number; direction: number; baseline_e: number[]; baseline_i: number[]; baseline_at_peak: number; peak_current: number; at_edge: boolean };
  result?: {
    status: string; reportable: boolean; height: number; cal_unit: string; unit: string; factor: number;
    saliva: number | null; saliva_pg: number | null; tube: number | null; ci_saliva: number | null;
    loq_saliva_pg: number | null; max_saliva_pg: number | null; reference_flag: string | null; unit_assumed: boolean;
  };
};
type Reading = {
  reading_id: number; crew_id: string; mission_phase: string; sampled_at: string | null; status: string;
  saliva_pg_ml: number | null; reference_flag: string | null; data_origin: string; notes: string | null; sample_file: string | null;
  entered_by: string | null;
};
type RecordsInfo = { rows: Reading[]; loq_saliva_pg: number | null; ref_low: number | null; ref_high: number | null; tester: string; can_delete_all: boolean };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (res.status === 401) unauthorized();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}
const postJSON = (path: string, data: unknown) => call<SetupInfo>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

export function fmt(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(digits - 1).replace("e", "×10^");
  return v.toLocaleString(undefined, { maximumSignificantDigits: digits });
}
const pg = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${fmt(v)} pg/mL`);
const STATUS_CLS: Record<string, string> = {
  "Quantified": "stable", "Detected, below LOQ": "watch", "Not detected (below LOD)": "unknown", "Above calibration range": "alert",
};

function Panel({ n, title, tag, children }: { n: string; title: string; tag: string; children: React.ReactNode }) {
  return (
    <section className="panel full-panel lab-panel">
      <div className="panel-title"><div><span className="panel-number">{n}</span><strong>{title}</strong></div><span>{tag}</span></div>
      {children}
    </section>
  );
}

function FilePick({ label, onFile, accept = ".csv" }: { label: string; onFile: (f: File) => void; accept?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="lab-button primary" onClick={() => ref.current?.click()}><Upload size={13} /> {label}</button>
      <input ref={ref} type="file" accept={accept} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </>
  );
}

// ----------------------------------------------------------------------------- SETUP
export function SetupPage({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = (p: Promise<SetupInfo>, changed = true) =>
    p.then((i) => { setInfo(i); setForm(i.settings); setErr(null); if (changed) onChanged(); }).catch((e) => setErr(String(e.message ?? e)));
  useEffect(() => { load(call<SetupInfo>("/api/setup"), false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!info || !form) return <div className="notice subtle">{err ?? "Loading setup…"}</div>;
  const cal = info.calibration, L = info.limits, unit = cal?.unit ?? "";
  const set = (k: keyof Settings, v: string) => { setSaved(false); setForm({ ...form, [k]: v === "" ? null : (k === "launch_date" || k === "cal_unit" ? v : Number(v)) }); };
  const factor = form.buffer_ul != null && form.saliva_ul ? (form.buffer_ul + form.saliva_ul) / form.saliva_ul : null;
  const dirty = JSON.stringify(form) !== JSON.stringify(info.settings);
  const save = () => load(postJSON("/api/setup/settings", form)).then(() => setSaved(true));
  const fit = L && cal ? [0, Math.max(...cal.points.map((p) => p.x)) * 1.05].map((x) => ({ x, y: L.slope * x + L.intercept })) : [];

  return (
    <>
      <div className={`notice ${info.ready ? "ok" : ""}`}>
        {info.ready ? <><CircleCheck size={14} /> Setup complete. Saliva LOQ of your sensor: <b>{pg(info.loq_saliva_pg)}</b>. Go to <b>Results</b> to analyse scans.</>
          : <><TriangleAlert size={14} /> Finish Setup before measuring: a valid calibration, its concentration units, and the buffer and saliva volumes.</>}
      </div>
      {err && <div className="notice error">{err}</div>}
      {!info.can_edit && <div className="notice subtle">Setup is shared by all testers and managed by the study coordinator, so it is read-only here. You can measure and save DPV scans in <b>Results</b>.</div>}

      <Panel n="S1" title="CALIBRATION" tag="KNOWN CONCENTRATIONS VS BASELINE-CORRECTED PEAK CURRENT">
        <div className="lab-body">
          <p className="lab-help">One row per measurement: melatonin concentration and its DPV peak current. Prepare the standards in the same buffer as the samples and include blanks as concentration 0.</p>
          {info.can_edit && <div className="lab-actions">
            <FilePick label={cal ? "REPLACE CALIBRATION CSV" : "UPLOAD CALIBRATION CSV"} onFile={(f) => { const d = new FormData(); d.append("file", f); load(call("/api/setup/calibration", { method: "POST", body: d })); }} />
            {!cal && <button className="lab-button" onClick={() => load(call("/api/setup/calibration/example", { method: "POST" }))}>LOAD BUNDLED EXAMPLE (SIMULATED)</button>}
            {cal && <button className="lab-button danger" onClick={() => confirm("Remove the calibration in use?") && load(call("/api/setup/calibration", { method: "DELETE" }))}>REMOVE</button>}
          </div>}
          {cal && (
            <div className="lab-meta">
              In use: <b>{cal.name}</b> · {cal.n_valid} of {cal.n_rows} rows · {cal.n_levels} concentration levels{unit ? ` · ${unit}` : ""}
              {cal.response_unit ? ` · current in ${cal.response_unit}` : ""}{cal.simulated ? " · marked as simulated data" : ""}
            </div>
          )}
          {cal && !cal.unit_from_file && info.can_edit && (
            <label className="lab-field inline">CONCENTRATION UNITS (NOT STATED IN THE FILE)
              <select value={form.cal_unit ?? ""} onChange={(e) => { set("cal_unit", e.target.value); load(postJSON("/api/setup/settings", { cal_unit: e.target.value })); }}>
                <option value="">Select the units</option>{info.conc_units.map((u) => <option key={u}>{u}</option>)}
              </select>
            </label>
          )}
          {info.error && <div className="notice error">{info.error}</div>}
          {cal && L && (
            <div className="chart-area" style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                  <CartesianGrid stroke="#1b3542" strokeDasharray="3 5" />
                  <XAxis dataKey="x" type="number" stroke="#66808b" tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(v, 2)} label={{ value: `concentration (${unit || "?"})`, position: "insideBottomRight", offset: -4, fill: "#66808b", fontSize: 9 }} />
                  <YAxis dataKey="y" type="number" stroke="#66808b" tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(v, 2)} />
                  <Tooltip contentStyle={TIP} formatter={(v) => fmt(Number(v), 4)} labelFormatter={(v) => `${fmt(Number(v), 4)} ${unit}`} />
                  <Line data={fit} dataKey="y" stroke="#8aa8b2" strokeDasharray="5 4" dot={false} isAnimationActive={false} name="Linear fit" />
                  <Scatter data={cal.points} dataKey="y" fill="#58e2cc" name="Standard" isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="lab-meta">Peak current = {fmt(L.slope, 4)} × concentration + {fmt(L.intercept, 4)} · R² = {L.r2?.toFixed(4)} · σ = {fmt(L.sigma)} · range {fmt(L.c_min)} to {fmt(L.c_max)} {unit}</div>
            </div>
          )}
        </div>
      </Panel>

      <Panel n="S2" title="SALIVA DILUTION & MISSION" tag="SHARED STUDY SETTINGS">
        <div className="lab-body">
          <fieldset className="lab-grid4 bare" disabled={!info.can_edit}>
            <label className="lab-field">BUFFER VOLUME (µL)<input type="number" min={0} step={10} value={form.buffer_ul ?? ""} placeholder="e.g. 400" onChange={(e) => set("buffer_ul", e.target.value)} /></label>
            <label className="lab-field">SALIVA VOLUME (µL)<input type="number" min={0} step={10} value={form.saliva_ul ?? ""} placeholder="e.g. 100" onChange={(e) => set("saliva_ul", e.target.value)} /></label>
            <label className="lab-field">MISSION LAUNCH DATE<input type="date" value={form.launch_date ?? ""} onChange={(e) => set("launch_date", e.target.value)} /></label>
            <div className="lab-field">DILUTION FACTOR<strong>{factor ? `× ${fmt(factor)}` : "—"}</strong></div>
            <label className="lab-field">REFERENCE RANGE LOW (pg/mL)<input type="number" min={0} value={form.ref_low ?? ""} placeholder="not set" onChange={(e) => set("ref_low", e.target.value)} /></label>
            <label className="lab-field">REFERENCE RANGE HIGH (pg/mL)<input type="number" min={0} value={form.ref_high ?? ""} placeholder="not set" onChange={(e) => set("ref_high", e.target.value)} /></label>
          </fieldset>
          <p className="lab-help">Ready-to-use kit tube pre-filled with Tris-HCl, NaCl and MgCl₂ buffer: enter the fixed buffer volume in the tube and the saliva volume added up to the red fill line. The launch date places each reading on the mission timeline (pre-flight days count back from it).</p>
          {info.can_edit && <div className="lab-actions">
            <button className="lab-button primary" disabled={!dirty} onClick={save}>SAVE SETTINGS</button>
            {saved && !dirty && <span className="lab-ok"><CircleCheck size={13} /> Saved</span>}
          </div>}
        </div>
      </Panel>

      {L && (
        <Panel n="S3" title="DETECTION LIMITS" tag="LOD = 3.3σ / |SLOPE| · LOQ = 10σ / |SLOPE|">
          <div className="lab-body">
            <div className="limit-grid">
              <div><span>LOD · BUFFERED SAMPLE</span><b>{fmt(L.lod)} {unit}</b><small>{unit !== "pg/mL" ? pg(L.lod_pg) : ""}</small></div>
              <div><span>LOQ · BUFFERED SAMPLE</span><b>{fmt(L.loq)} {unit}</b><small>{unit !== "pg/mL" ? pg(L.loq_pg) : ""}</small></div>
              <div><span>LOD · UNDILUTED SALIVA</span><b>{fmt(L.lod_saliva)} {unit}</b><small>{pg(L.lod_saliva_pg)}</small></div>
              <div className="hl"><span>LOQ · UNDILUTED SALIVA</span><b>{fmt(L.loq_saliva)} {unit}</b><small>{pg(L.loq_saliva_pg)}</small></div>
            </div>
            <p className="lab-help">σ is the residual standard deviation of the linear calibration fit. Reported saliva melatonin: about 1–2 pg/mL by day and 30–50 pg/mL at night. To read the body clock the saliva LOQ must be about 3 pg/mL or lower.</p>
          </div>
        </Panel>
      )}
    </>
  );
}

// ----------------------------------------------------------------------------- MEASURE
function nowLocal() {
  const d = new Date(); d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function MeasurePage({ crewIds, onSaved, goSetup, dataVersion }: { crewIds: string[]; onSaved: () => void; goSetup: () => void; dataVersion: number }) {
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const [crew, setCrew] = useState("");
  const [phase, setPhase] = useState("Pre-flight");
  const [when, setWhen] = useState(nowLocal());
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [currentUnit, setCurrentUnit] = useState("");
  const [win, setWin] = useState<[number, number] | null>(null);
  const [direction, setDirection] = useState("auto");
  const [res, setRes] = useState<MeasureResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const [plans, setPlans] = useState<Mission | null>(null);

  useEffect(() => { call<SetupInfo>("/api/setup").then(setSetup).catch((e) => setErr(String(e.message ?? e))); }, []);
  // Body-clock result and melatonin plan per crew member, from all saved readings (refreshed after every save).
  useEffect(() => { call<Mission>("/api/mission?source=records").then(setPlans).catch(() => setPlans(null)); }, [dataVersion]);
  const crewRow = useMemo(() => {
    const id = crew.trim();
    if (!id || !plans?.rows) return undefined;
    return plans.rows.filter((x) => x.crew === id).sort((a, b) => b.day - a.day)[0];
  }, [plans, crew]);

  const form = (save: boolean) => {
    const d = new FormData();
    d.append("file", file!); d.append("direction", direction);
    if (currentUnit) d.append("current_unit", currentUnit);
    if (win) { d.append("window_lo", String(win[0])); d.append("window_hi", String(win[1])); }
    if (save) { d.append("save", "1"); d.append("crew_id", crew.trim()); d.append("mission_phase", phase); d.append("sampled_at", when); d.append("notes", notes); }
    return d;
  };
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setBusy(true);
    call<MeasureResult>("/api/measure", { method: "POST", body: form(false) })
      .then((r) => { if (!cancelled) { setRes(r); setErr(null); } })
      .catch((e) => !cancelled && (setErr(String(e.message ?? e)), setRes(null)))
      .finally(() => !cancelled && setBusy(false));
    return () => { cancelled = true; };
  }, [file, currentUnit, win, direction]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => {
    setBusy(true);
    call<MeasureResult>("/api/measure", { method: "POST", body: form(true) })
      .then((r) => { setSavedMsg(`Saved as reading ${r.saved_id} for ${crew.trim()} (${phase}, ${when.replace("T", " ")}).`); onSaved(); })
      .catch((e) => setErr(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };

  if (setup && !setup.ready) {
    return <div className="notice"><TriangleAlert size={14} /> Finish Setup first: a valid calibration, its concentration units, and the buffer and saliva volumes. <button className="lab-button" onClick={goSetup}>OPEN SETUP</button></div>;
  }
  const r = res?.result, p = res?.peak, s = res?.scan;
  const scanData = s ? s.e.map((e, i) => ({ e, raw: s.raw[i], smooth: s.smooth[i] })) : [];
  const cu = res?.current_unit ?? "";

  return (
    <>
      <WhyPanel />
      <KitProtocol factor={setup?.factor ?? null} />

      <Panel n="M1" title="SAMPLE" tag="WHO, WHEN, WHICH PHASE">
        <div className="lab-body">
          <div className="lab-grid4">
            <label className="lab-field">CREW MEMBER ID
              <input list="crew-ids" value={crew} placeholder="e.g. CM-A (a code, not a name)" onChange={(e) => { setCrew(e.target.value); setSavedMsg(null); }} />
              <datalist id="crew-ids">{crewIds.map((c) => <option key={c} value={c} />)}</datalist>
            </label>
            <label className="lab-field">MISSION PHASE
              <select value={phase} onChange={(e) => { setPhase(e.target.value); setSavedMsg(null); }}>{(setup?.phases ?? ["Pre-flight", "In-flight", "Post-flight"]).map((x) => <option key={x}>{x}</option>)}</select>
            </label>
            <label className="lab-field">SALIVA COLLECTED AT<input type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); setSavedMsg(null); }} /></label>
            <label className="lab-field">NOTES (OPTIONAL)<input value={notes} placeholder="lighting, electrode batch…" onChange={(e) => setNotes(e.target.value)} /></label>
          </div>
          <p className="lab-help">For a body-clock reading, collect an evening series: one sample every 30–60 min from about 6 h before usual sleep until bedtime, under dim light. Each crew member needs at least two pre-flight evenings as a personal baseline.</p>
        </div>
      </Panel>

      <Panel n="M2" title="DPV CURVE" tag="SPCE + PORTABLE POTENTIOSTAT · POTENTIAL (V) VS CURRENT">
        <div className="lab-body">
          <div className="lab-actions">
            <FilePick label={file ? "CHOOSE ANOTHER SCAN" : "UPLOAD DPV SCAN CSV"} onFile={(f) => { setFile(f); setWin(null); setSavedMsg(null); setRes(null); }} />
            <button className="lab-button" onClick={() => fetch("/samples/SIMULATED_single_DPV_sample.csv").then((r) => r.blob())
              .then((b) => { setFile(new File([b], "SIMULATED_single_DPV_sample.csv", { type: "text/csv" })); setWin(null); setSavedMsg(null); setRes(null); })}>
              LOAD SAMPLE SCAN (SIMULATED)</button>
            {file && <span className="lab-meta">{file.name}{busy ? " · analysing…" : ""}</span>}
          </div>
          {err && <div className="notice error">{err}</div>}
          {res?.need_unit && (
            <label className="lab-field inline">CURRENT UNITS (NOT STATED IN THE FILE)
              <select value={currentUnit} onChange={(e) => setCurrentUnit(e.target.value)}>
                <option value="">Select the units</option>{setup?.current_units.map((u) => <option key={u}>{u}</option>)}
              </select>
            </label>
          )}
          {s && res?.range && (
            <>
              <div className="lab-grid4">
                <label className="lab-field">WINDOW FROM (V)<input type="number" step={0.01} value={(win ?? res.window ?? res.range)[0]} onChange={(e) => setWin([Number(e.target.value), (win ?? res.range!)[1]])} /></label>
                <label className="lab-field">WINDOW TO (V)<input type="number" step={0.01} value={(win ?? res.window ?? res.range)[1]} onChange={(e) => setWin([(win ?? res.range!)[0], Number(e.target.value)])} /></label>
                <label className="lab-field">PEAK DIRECTION
                  <select value={direction} onChange={(e) => setDirection(e.target.value)}><option value="auto">Auto</option><option value="up">Up (oxidation)</option><option value="down">Down (reduction)</option></select>
                </label>
                <div className="lab-field">PEAK<strong>{p?.found ? `${p.potential.toFixed(3)} V` : "not found"}</strong></div>
              </div>
              <div className="chart-area" style={{ height: 300 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={scanData} margin={{ top: 16, right: 20, left: 4, bottom: 10 }}>
                    <CartesianGrid stroke="#1b3542" strokeDasharray="3 5" />
                    <XAxis dataKey="e" type="number" domain={["dataMin", "dataMax"]} stroke="#66808b" tick={{ fontSize: 10 }} tickFormatter={(v) => Number(v).toFixed(2)} label={{ value: "potential (V)", position: "insideBottomRight", offset: -4, fill: "#66808b", fontSize: 9 }} />
                    <YAxis stroke="#66808b" tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(Number(v), 3)} domain={["auto", "auto"]} label={{ value: cu, angle: -90, position: "insideLeft", fill: "#66808b", fontSize: 10 }} />
                    <Tooltip contentStyle={TIP} labelFormatter={(v) => `${Number(v).toFixed(3)} V`} formatter={(v, n) => [`${fmt(Number(v), 4)} ${cu}`, n]} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Scatter dataKey="raw" name="As recorded" fill="#5d7883" isAnimationActive={false}
                      shape={(props: { cx?: number; cy?: number }) => <circle cx={props.cx} cy={props.cy} r={1.6} fill="#6f8c96" />} />
                    <Line dataKey="smooth" name="Smoothed" stroke="#58e2cc" strokeWidth={2} dot={false} isAnimationActive={false} />
                    {p?.found && p.baseline_e.length === 2 && (
                      <ReferenceLine segment={[{ x: p.baseline_e[0], y: p.baseline_i[0] }, { x: p.baseline_e[1], y: p.baseline_i[1] }]} stroke="#8aa8b2" strokeDasharray="5 4" />
                    )}
                    {p?.found && (
                      <ReferenceLine segment={[{ x: p.potential, y: p.baseline_at_peak }, { x: p.potential, y: p.peak_current }]} stroke="#f2bd72" strokeWidth={2}
                        label={{ value: `${fmt(p.height, 3)} ${cu} at ${p.potential.toFixed(3)} V`, position: "top", fill: "#f2bd72", fontSize: 10 }} />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
          {res?.message && !r && <div className="notice">{res.message}</div>}
        </div>
      </Panel>

      {r && (
        <Panel n="M3" title="MELATONIN ANALYSIS" tag="LEVEL FROM THE CALIBRATION LINE · REFERENCE RANGE · MELATONIN DOSE">
          <div className="lab-body">
            <div className="result-row">
              <span className="done-badge"><CircleCheck size={15} /> ANALYSIS COMPLETE</span>
              <span className={`status-pill ${STATUS_CLS[r.status] ?? "unknown"}`}>{r.status.toUpperCase()}</span>
            </div>
            <div className="result-cards">
              <div className="rc level">
                <span>MELATONIN LEVEL · SALIVA</span>
                <b>{r.reportable ? fmt(r.saliva_pg) : r.status === "Above calibration range" ? `> ${fmt(r.max_saliva_pg)}` : `< ${fmt(r.loq_saliva_pg)}`}<em>pg/mL</em></b>
                <small>{r.reportable ? `± ${fmt(r.saliva && r.saliva_pg && r.ci_saliva != null ? (r.ci_saliva * r.saliva_pg) / r.saliva : null, 2)} pg/mL (95%) · from the calibration line` : r.status === "Above calibration range" ? "above the highest standard: dilute and re-measure" : "below the sensor's saliva LOQ"}</small>
              </div>
              <RangeCard flag={r.reference_flag} reportable={r.reportable} status={r.status} low={setup?.settings.ref_low ?? null} high={setup?.settings.ref_high ?? null} />
              <DoseCard crew={crew.trim()} row={crewRow} />
            </div>
            <div className="limit-grid">
              <div><span>PEAK CURRENT · BASELINE-CORRECTED</span><b>{fmt(r.height, 4)} {r.cal_unit}</b><small>at {p?.potential.toFixed(3)} V</small></div>
              <div><span>SALIVA · CALIBRATION UNITS</span><b>{r.reportable ? `${fmt(r.saliva)} ${r.unit}` : "—"}</b><small>{r.reportable ? `± ${fmt(r.ci_saliva)} (95%)` : ""}</small></div>
              <div><span>IN THE TUBE</span><b>{r.reportable ? `${fmt(r.tube)} ${r.unit}` : "—"}</b><small>saliva = tube × {fmt(r.factor)}</small></div>
              <div><span>SALIVA LOQ</span><b>{pg(r.loq_saliva_pg)}</b><small>{r.unit_assumed ? "calibration current unit assumed from the scan" : ""}</small></div>
            </div>
            {res?.message && <p className="lab-help strong">{res.message}</p>}
            {p?.at_edge && <p className="lab-help">The peak is at the edge of the window; widen the scan.</p>}
            <div className="lab-actions">
              <button className="lab-button primary" disabled={!crew.trim() || busy || !!savedMsg} onClick={save}>SAVE READING</button>
              {!crew.trim() && <span className="lab-meta">Enter a crew member ID to save this reading.</span>}
              {savedMsg && <span className="lab-ok"><CircleCheck size={13} /> {savedMsg}</span>}
            </div>
            {savedMsg && <p className="lab-help">The reading is in <b>History</b> and <b>Trends</b>, and in the crew results (Data source: RECORDS). Upload the next scan of the series, or change the time and crew above.</p>}
          </div>
        </Panel>
      )}
    </>
  );
}

// ----------------------------------------------------------------------------- RECORDS
export function RecordsPage({ onChanged, mode }: { onChanged: () => void; mode: "history" | "trends" }) {
  const [info, setInfo] = useState<RecordsInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => { call<RecordsInfo>("/api/records").then(setInfo).catch((e) => setErr(String(e.message ?? e))); }, []);

  const crews = useMemo(() => [...new Set((info?.rows ?? []).map((r) => String(r.crew_id)))].sort(), [info]);
  if (!info) return <div className="notice subtle">{err ?? "Loading records…"}</div>;
  if (!info.rows.length) return <div className="notice subtle">No readings saved yet. Measure a DPV scan and save it in <b>Results</b>.</div>;
  const view = info.rows.filter((r) => !hidden.includes(String(r.crew_id)));
  const loq = info.loq_saliva_pg;
  const colour = (c: string) => CREW_COLOURS[crews.indexOf(c) % CREW_COLOURS.length];
  const t = (r: Reading) => (r.sampled_at ? new Date(r.sampled_at).getTime() : NaN);
  const del = (id: number) => {
    if (!confirm(`Delete reading ${id}? This cannot be undone.`)) return;
    call<RecordsInfo>(`/api/records/${id}`, { method: "DELETE" }).then((i) => { setInfo(i); onChanged(); }).catch((e) => setErr(String(e.message ?? e)));
  };

  return (
    <Panel n={mode === "history" ? "H1" : "T1"} title={mode === "history" ? "HISTORY" : "TRENDS"}
      tag={mode === "history" ? `${info.rows.length} SAVED READING(S)` : "SALIVA MELATONIN OVER TIME, PER CREW MEMBER"}>
      <div className="lab-body">
        {info.rows.some((r) => r.data_origin === "simulated") && <div className="notice"><TriangleAlert size={14} /> Some readings come from simulated files, not real measurements.</div>}
        <div className="crew-chips flush">
          {crews.map((c) => (
            <button key={c} className={`crew-chip ${hidden.includes(c) ? "" : "on"}`} onClick={() => setHidden(hidden.includes(c) ? hidden.filter((h) => h !== c) : [...hidden, c])}>
              <i style={{ background: colour(c) }} />{c}<b>{info.rows.filter((r) => String(r.crew_id) === c).length}</b>
            </button>
          ))}
          <a className="lab-button" href="/api/records.csv" download><Download size={13} /> DOWNLOAD CSV</a>
        </div>
        {mode === "trends" && <div className="chart-area" style={{ height: 340 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 14, right: 20, left: 4, bottom: 10 }}>
              <CartesianGrid stroke="#1b3542" strokeDasharray="3 5" />
              <XAxis dataKey="t" type="number" scale="time" domain={["dataMin - 3600000", "dataMax + 3600000"]} stroke="#66808b" tick={{ fontSize: 10 }}
                tickFormatter={(v) => new Date(v).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} />
              <YAxis dataKey="y" type="number" stroke="#66808b" tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(Number(v), 3)} label={{ value: "saliva pg/mL", angle: -90, position: "insideLeft", fill: "#66808b", fontSize: 10 }} />
              <ZAxis range={[50, 50]} />
              <Tooltip contentStyle={TIP} formatter={(v, n) => (n === "t" ? [new Date(Number(v)).toLocaleString(), "sampled"] : [`${fmt(Number(v), 4)} pg/mL`, "saliva"])} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              {loq !== null && <ReferenceLine y={loq} stroke="#5d7883" strokeDasharray="3 4" label={{ value: `saliva LOQ ${fmt(loq)}`, position: "insideTopRight", fill: "#8aa8b2", fontSize: 9 }} />}
              {info.ref_low != null && <ReferenceLine y={info.ref_low} stroke="#2b4d59" />}
              {info.ref_high != null && <ReferenceLine y={info.ref_high} stroke="#2b4d59" />}
              {crews.filter((c) => !hidden.includes(c)).map((c) => (
                <Scatter key={c} name={c} fill={colour(c)} isAnimationActive={false}
                  data={view.filter((r) => String(r.crew_id) === c && r.saliva_pg_ml !== null && Number.isFinite(t(r))).map((r) => ({ t: t(r), y: r.saliva_pg_ml }))} />
              ))}
              {loq !== null && (
                <Scatter name="No reportable value (at LOQ)" fill="#0a1b26" stroke="#8aa8b2" shape="triangle" isAnimationActive={false}
                  data={view.filter((r) => r.saliva_pg_ml === null && Number.isFinite(t(r))).map((r) => ({ t: t(r), y: loq }))} />
              )}
            </ScatterChart>
          </ResponsiveContainer>
        </div>}
        {mode === "trends" && <p className="lab-help">Lines mark the saliva LOQ and the reference range from Settings. Triangles are readings with no reportable value. Body-clock timing and the melatonin dose per crew member are on <b>Results</b> and in <b>Mission systems</b> with the RECORDS data source.</p>}
        {mode === "history" && <div className="plan-table-wrap flush">
          <table className="plan-table">
            <thead><tr><th>ID</th><th>CREW</th><th>PHASE</th><th>SAMPLED</th><th>STATUS</th><th>SALIVA (pg/mL)</th><th>REFERENCE</th><th>DATA</th><th>ENTERED BY</th><th>FILE</th><th>NOTES</th><th /></tr></thead>
            <tbody>
              {[...view].reverse().map((r) => (
                <tr key={r.reading_id}>
                  <td>{r.reading_id}</td><td>{r.crew_id}</td><td>{r.mission_phase}</td><td>{r.sampled_at?.replace("T", " ") ?? "—"}</td>
                  <td><span className={`status-pill ${STATUS_CLS[r.status] ?? "unknown"}`}>{r.status}</span></td>
                  <td>{r.saliva_pg_ml !== null ? fmt(r.saliva_pg_ml) : "—"}</td><td>{r.reference_flag ?? "—"}</td><td>{r.data_origin}</td><td>{r.entered_by ?? "—"}</td>
                  <td className="note">{r.sample_file ?? ""}</td><td className="note">{r.notes ?? ""}</td>
                  <td>{(info.can_delete_all || r.entered_by === info.tester) && <button className="lab-button danger small" onClick={() => del(r.reading_id)}>DELETE</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
        {err && <div className="notice error">{err}</div>}
      </div>
    </Panel>
  );
}

// ----------------------------------------------------------------------------- kit protocol + result cards
const KIT_STEPS = [
  { icon: Package, title: "Ready-to-use test tube", text: "Open a sterile kit tube, pre-filled with buffer that stabilises the sample and keeps the pH." },
  { icon: Droplet, title: "Add saliva", text: "Add saliva up to the red fill line." },
  { icon: Timer, title: "Shake for 1 minute", text: "Close the cap and shake for 1 minute to mix saliva and buffer." },
  { icon: Zap, title: "Electrochemical measurement", text: "Insert the screen-printed carbon electrode (SPCE), connect the portable potentiostat and run the DPV scan. Upload the scan CSV below." },
];

function KitProtocol({ factor }: { factor: number | null }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (left === null || left <= 0) return;
    const t = window.setTimeout(() => setLeft(left - 1), 1000);
    return () => window.clearTimeout(t);
  }, [left]);
  return (
    <Panel n="K" title="SAMPLE KIT PROTOCOL" tag="SALIVA TUBE → SHAKE → SPCE + PORTABLE POTENTIOSTAT">
      <div className="lab-body">
        <ol className="kit-steps">
          {KIT_STEPS.map((k, i) => {
            const Icon = k.icon;
            return (
              <li key={k.title}>
                <div className="kit-num">{i + 1}</div>
                <Icon size={22} />
                <b>{k.title}</b>
                <p>{k.text}{i === 1 && factor ? ` Saliva is diluted × ${fmt(factor)} in the tube; results are corrected back to undiluted saliva.` : ""}</p>
                {i === 2 && (
                  <button className={`lab-button small ${left === 0 ? "done" : ""}`} onClick={() => setLeft(60)}>
                    <Timer size={12} /> {left === null ? "START 1-MIN TIMER" : left > 0 ? `0:${String(left).padStart(2, "0")} LEFT` : "DONE · RESTART"}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </Panel>
  );
}

function RangeCard({ flag, reportable, status, low, high }: { flag: string | null; reportable: boolean; status: string; low: number | null; high: number | null }) {
  const range = low != null && high != null ? `Reference ${fmt(low)}–${fmt(high)} pg/mL (set in Settings)` : "No reference range set in Settings";
  let cls = "neutral", icon = <TriangleAlert size={18} />, text = "Not compared";
  if (flag?.startsWith("Below")) { cls = "low"; icon = <ArrowDown size={18} />; text = "Below reference range"; }
  else if (flag?.startsWith("Above")) { cls = "high"; icon = <ArrowUp size={18} />; text = "Above reference range"; }
  else if (flag?.startsWith("Within")) { cls = "in"; icon = <CircleCheck size={18} />; text = "Within reference range"; }
  else if (!reportable) text = status === "Above calibration range" ? "Above calibration range" : "Below detection or LOQ";
  return (
    <div className={`rc range ${cls}`}>
      <span>REFERENCE RANGE</span>
      <b>{icon}{text}</b>
      <small>{range}. Melatonin varies over the day (about 1–2 pg/mL by day, 30–50 pg/mL at night), so compare evening series, not single values.</small>
    </div>
  );
}

const PLAN_LABEL: Record<string, string> = {
  "Baseline": "No dose · baseline evening", "No melatonin needed": "0 mg · not needed", "Melatonin not advised": "0 mg · not advised", "Re-sample first": "Re-sample first",
};

function DoseCard({ crew, row }: { crew: string; row: Row | undefined }) {
  if (!crew) {
    return <div className="rc dose neutral"><span><Pill size={13} /> MELATONIN DOSE</span><b>—</b><small>Enter the crew member ID above to see their melatonin dose.</small></div>;
  }
  if (!row) {
    return (
      <div className="rc dose neutral"><span><Pill size={13} /> MELATONIN DOSE · {crew}</span><b>No body-clock result yet</b>
        <small>Save this reading. The dose is set from {crew}'s evening series (one sample every 30–60 min) compared with at least two pre-flight evenings.</small></div>
    );
  }
  const p = row.plan;
  if (p.action === "Melatonin") {
    return (
      <div className="rc dose give">
        <span><Pill size={13} /> RECOMMENDED MELATONIN SUPPLEMENT · {crew}{p.priority === "high" ? " · HIGH PRIORITY" : ""}</span>
        <b>{p.dose_mg} mg<em>at {p.take_at}</em></b>
        <small>Once daily, window {p.window[0]}–{p.window[1]} ({row.label}: {p.headline}). Re-measure after 3 days. Suggestion for flight-surgeon approval.</small>
      </div>
    );
  }
  return (
    <div className={`rc dose ${p.action === "Re-sample first" ? "warn" : "neutral"}`}>
      <span><Pill size={13} /> MELATONIN DOSE · {crew}</span>
      <b>{PLAN_LABEL[p.action] ?? p.action}</b>
      <small>{row.label}: {p.headline}{p.reasons[0] ? ` ${p.reasons[0]}` : ""}</small>
    </div>
  );
}

// ----------------------------------------------------------------------------- NASA HRP basis
function WhyPanel() {
  const [open, setOpen] = useState(false);
  return (
    <Panel n="i" title="WHY MONITOR THE BODY CLOCK" tag="BASIS: NASA HUMAN RESEARCH PROGRAM">
      <div className="lab-body why">
        <div className="why-grid">
          <div><b>16</b><span>sunrises and sunsets a day aboard the space station, which can disrupt the sleep-wake cycle (NASA HRP).</span></div>
          <div><b>Circadian risk</b><span>NASA HRP lists performance and health risks from sleep loss, circadian desynchronization and work overload.</span></div>
          <div><b>Self-assessment</b><span>Far from Earth, crews must check their own health. OrbitClock reads the body clock from saliva melatonin and suggests when melatonin could help, for flight-surgeon approval.</span></div>
        </div>
        <button className="lab-button small" onClick={() => setOpen(!open)}>{open ? "HIDE NASA SOURCES" : "SHOW NASA SOURCES"}</button>
        {open && <ul className="why-src">{NASA_RESOURCES.map((r) => <li key={r.name}><a href={r.url} target="_blank" rel="noreferrer">{r.name}</a>: {r.use}</li>)}</ul>}
      </div>
    </Panel>
  );
}
