// Settings (calibration), Results (DPV scan → melatonin level → dose), History and Trends; served by backend/orbitclock/lab_api.py.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CircleCheck, Download, Droplet, Package, Pill, Timer, TriangleAlert, Upload, Zap } from "lucide-react";
import {
  CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Scatter,
  Tooltip, XAxis, YAxis
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
type RecordsInfo = { rows: Reading[]; loq_saliva_pg: number | null; ref_low: number | null; ref_high: number | null; launch_date?: string | null; tester: string; can_delete_all: boolean };

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

      <BackupsPanel canEdit={info.can_edit} />
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
function RecordsView({ onChanged, mode }: { onChanged: () => void; mode: "history" | "trends" }) {
  const [info, setInfo] = useState<RecordsInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call<RecordsInfo>("/api/records").then(setInfo).catch((e) => setErr(String(e.message ?? e))); }, []);

  const crews = useMemo(() => [...new Set((info?.rows ?? []).map((r) => String(r.crew_id)))].sort(), [info]);
  if (!info) return <div className="notice subtle">{err ?? "Loading records…"}</div>;
  if (!info.rows.length) return <div className="notice subtle">No readings saved yet. Measure a DPV scan and save it in <b>Results</b>.</div>;
  const view = info.rows.filter((r) => !hidden.includes(String(r.crew_id)));
  const loq = info.loq_saliva_pg;
  const colour = (c: string) => CREW_COLOURS[crews.indexOf(c) % CREW_COLOURS.length];
  const canDelete = (r: Reading) => info.can_delete_all || r.entered_by === info.tester;
  const visibleIds = view.map((r) => r.reading_id);
  const pickedRows = info.rows.filter((r) => picked.includes(r.reading_id));
  const deletable = pickedRows.filter(canDelete);
  const allOn = visibleIds.length > 0 && visibleIds.every((id) => picked.includes(id));
  const toggle = (id: number) => setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);
  const toggleAll = () => setPicked(allOn ? picked.filter((p) => !visibleIds.includes(p)) : [...new Set([...picked, ...visibleIds])]);
  const delPicked = async () => {
    const skip = pickedRows.length - deletable.length;
    if (!confirm(`Delete ${deletable.length} reading(s)?${skip ? ` ${skip} selected reading(s) entered by others will be kept.` : ""} They move to Recently deleted, where they can be restored.`)) return;
    setBusy(true);
    let last: RecordsInfo | null = null;
    try {
      for (const r of deletable) last = await call<RecordsInfo>(`/api/records/${r.reading_id}`, { method: "DELETE" });
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    if (last) setInfo(last); else call<RecordsInfo>("/api/records").then(setInfo);
    setPicked([]); setBusy(false); onChanged();
  };
  const del = (id: number) => {
    if (!confirm(`Delete reading ${id}? It moves to Recently deleted, where it can be restored.`)) return;
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
        {mode === "trends" && (
          <TrendChart rows={view} crews={crews.filter((c) => !hidden.includes(c))} colour={colour} loq={loq}
            refLow={info.ref_low} refHigh={info.ref_high} launch={info.launch_date ?? null} />
        )}
        {mode === "trends" && <p className="lab-help">Each column is one evening of saliva sampling, read left to right from about 17:00 to midnight; points from the same evening are joined. Shaded bands show the mission phase saved with each reading. Day labels count from the launch date in Settings: L = days before launch, FD = flight day, R+ = days after the last in-flight evening. Dashed lines mark the saliva LOQ and the reference range; triangles are readings with no reportable value.</p>}
        {mode === "history" && <div className="plan-table-wrap flush">
          {mode === "history" && (
            <div className="pick-bar">
              <b>{picked.length ? `${picked.length} SELECTED` : "TICK READINGS TO SELECT THEM"}</b>
              {picked.length > 0 && <>
                <a className="lab-button small" href={`/api/records.csv?ids=${picked.join(",")}`} download><Download size={12} /> DOWNLOAD SELECTED</a>
                <button className="lab-button danger small" disabled={!deletable.length || busy} onClick={delPicked}
                  title={deletable.length < picked.length ? "Testers can delete only readings they entered" : ""}>
                  {busy ? "DELETING…" : `DELETE SELECTED (${deletable.length})`}</button>
                <button className="lab-button small" onClick={() => setPicked([])}>CLEAR</button>
              </>}
            </div>
          )}
          <table className="plan-table">
            <thead><tr><th className="pick"><input type="checkbox" aria-label="Select all shown readings" checked={allOn} onChange={toggleAll} /></th><th>ID</th><th>CREW</th><th>PHASE</th><th>SAMPLED</th><th>STATUS</th><th>SALIVA (pg/mL)</th><th>REFERENCE</th><th>DATA</th><th>ENTERED BY</th><th>FILE</th><th>NOTES</th><th /></tr></thead>
            <tbody>
              {[...view].reverse().map((r) => (
                <tr key={r.reading_id} className={picked.includes(r.reading_id) ? "picked" : ""}>
                  <td className="pick"><input type="checkbox" aria-label={`Select reading ${r.reading_id}`} checked={picked.includes(r.reading_id)} onChange={() => toggle(r.reading_id)} /></td>
                  <td>{r.reading_id}</td><td>{r.crew_id}</td><td>{r.mission_phase}</td><td>{r.sampled_at?.replace("T", " ") ?? "—"}</td>
                  <td><span className={`status-pill ${STATUS_CLS[r.status] ?? "unknown"}`}>{r.status}</span></td>
                  <td>{r.saliva_pg_ml !== null ? fmt(r.saliva_pg_ml) : "—"}</td><td>{r.reference_flag ?? "—"}</td><td>{r.data_origin}</td><td>{r.entered_by ?? "—"}</td>
                  <td className="note">{r.sample_file ?? ""}</td><td className="note">{r.notes ?? ""}</td>
                  <td>{canDelete(r) && <button className="lab-button danger small" onClick={() => del(r.reading_id)}>DELETE</button>}</td>
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

// ----------------------------------------------------------------------------- TRENDS chart (phase bands)
const PHASE_ORDER = ["Pre-flight", "In-flight", "Post-flight"];
const PHASE_STYLE: Record<string, { fill: string; text: string; label: string }> = {
  "Pre-flight": { fill: "rgba(114,191,255,0.06)", text: "#72bfff", label: "PRE-FLIGHT" },
  "In-flight": { fill: "rgba(242,189,114,0.11)", text: "#f2bd72", label: "IN FLIGHT" },
  "Post-flight": { fill: "rgba(180,154,255,0.08)", text: "#b49aff", label: "POST-FLIGHT" },
};
const DAY_MS = 86400000;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayNum = (s: string) => Math.round(new Date(`${s}T00:00`).getTime() / DAY_MS);

type TPoint = { x: number; y: number; crew: string; time: string; phase: string; evening: string; censored: boolean; value: number | null };

function TrendChart({ rows, crews, colour, loq, refLow, refHigh, launch }: {
  rows: Reading[]; crews: string[]; colour: (c: string) => string; loq: number | null;
  refLow: number | null; refHigh: number | null; launch: string | null;
}) {
  const model = useMemo(() => {
    const pts = rows.filter((r) => r.sampled_at && crews.includes(String(r.crew_id))).map((r) => {
      const t = new Date(r.sampled_at!.replace(" ", "T"));
      const ev = ymd(new Date(t.getTime() - 12 * 3600000));          // after-midnight samples belong to the previous evening
      const sinceNoon = (t.getTime() - new Date(`${ev}T12:00`).getTime()) / 3600000;
      return { r, t, ev, frac: Math.min(1, Math.max(0, (sinceNoon - 5) / 7)) };  // 17:00 → 0, midnight → 1
    }).filter((p) => !Number.isNaN(p.t.getTime()));
    const evenings = [...new Set(pts.map((p) => p.ev))].sort();
    const idx = new Map(evenings.map((e, i) => [e, i]));
    // phase of an evening = most common phase saved with its readings
    const phaseOf = new Map<string, string>();
    for (const e of evenings) {
      const n: Record<string, number> = {};
      for (const p of pts) if (p.ev === e) n[p.r.mission_phase] = (n[p.r.mission_phase] ?? 0) + 1;
      phaseOf.set(e, Object.entries(n).sort((a, b) => b[1] - a[1] || PHASE_ORDER.indexOf(a[0]) - PHASE_ORDER.indexOf(b[0]))[0][0]);
    }
    const launchDay = launch ? dayNum(launch) : null;
    const inflight = evenings.filter((e) => phaseOf.get(e) === "In-flight");
    const lastIn = inflight.length ? dayNum(inflight[inflight.length - 1]) : null;
    const ticks = evenings.map((e, i) => {
      const d = dayNum(e), ph = phaseOf.get(e);
      let label = "";
      if (launchDay !== null && ph === "Pre-flight" && d <= launchDay) label = `L${d - launchDay}`;
      else if (launchDay !== null && ph === "In-flight" && d >= launchDay) label = `FD${d - launchDay + 1}`;
      else if (ph === "Post-flight" && lastIn !== null && d > lastIn) label = `R+${d - lastIn}`;
      const date = new Date(`${e}T00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      return { x: i + 0.5, label: label || date, date: label ? date : "" };
    });
    const bands: { phase: string; x1: number; x2: number }[] = [];
    evenings.forEach((e, i) => {
      const ph = phaseOf.get(e)!;
      const last = bands[bands.length - 1];
      if (last && last.phase === ph) last.x2 = i + 1; else bands.push({ phase: ph, x1: i, x2: i + 1 });
    });
    const toPoint = (p: (typeof pts)[number]): TPoint => ({
      x: idx.get(p.ev)! + 0.12 + 0.76 * p.frac, y: p.r.saliva_pg_ml ?? loq ?? 0, crew: String(p.r.crew_id),
      time: p.r.sampled_at!.replace("T", " "), phase: p.r.mission_phase, evening: p.ev,
      censored: p.r.saliva_pg_ml === null, value: p.r.saliva_pg_ml,
    });
    const series: { key: string; crew: string; data: TPoint[] }[] = [];
    for (const c of crews) for (const e of evenings) {
      const data = pts.filter((p) => String(p.r.crew_id) === c && p.ev === e && p.r.saliva_pg_ml !== null).map(toPoint).sort((a, b) => a.x - b.x);
      if (data.length) series.push({ key: `${c}|${e}`, crew: c, data });
    }
    const censored = pts.filter((p) => p.r.saliva_pg_ml === null).map(toPoint);
    return { evenings, ticks, bands, series, censored };
  }, [rows, crews, loq, launch]);

  if (!model.evenings.length) return <div className="notice subtle">No readings with a sampling time for the crew members shown.</div>;
  const width = Math.max(model.evenings.length * 92, 0);
  const tipContent = ({ active, payload }: { active?: boolean; payload?: readonly { payload?: TPoint }[] }) => {
    const p = active ? payload?.[0]?.payload : undefined;
    if (!p) return null;
    return (
      <div style={{ ...TIP, padding: "8px 10px", color: "#d6eeee" }}>
        <b style={{ color: colour(p.crew) }}>{p.crew}</b> · {p.phase}<br />
        {p.time}<br />
        {p.censored ? `below LOQ (< ${fmt(loq)} pg/mL)` : `${fmt(p.value, 4)} pg/mL saliva`}
      </div>
    );
  };
  return (
    <div className="trend-scroll">
      <div className="chart-area" style={{ height: 380, minWidth: width }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 26, right: 24, left: 4, bottom: 18 }}>
            {model.bands.map((b, i) => (
              <ReferenceArea key={i} x1={b.x1} x2={b.x2} fill={PHASE_STYLE[b.phase]?.fill ?? "transparent"} fillOpacity={1} stroke="none" ifOverflow="visible"
                label={{ value: PHASE_STYLE[b.phase]?.label ?? b.phase.toUpperCase(), position: "insideTop", fill: PHASE_STYLE[b.phase]?.text ?? "#8aa8b2", fontSize: 10, fontWeight: 700, offset: -18 }} />
            ))}
            {model.bands.slice(1).map((b, i) => <ReferenceLine key={`s${i}`} x={b.x1} stroke="#3c5f6c" strokeDasharray="4 4" />)}
            <CartesianGrid stroke="#1b3542" strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="x" type="number" domain={[0, model.evenings.length]} ticks={model.ticks.map((t) => t.x)} interval={0} stroke="#66808b" height={40}
              tick={(props: { x?: number | string; y?: number | string; payload?: { value: number } }) => {
                const t = model.ticks.find((k) => Math.abs(k.x - (props.payload?.value ?? -1)) < 1e-6);
                return (
                  <g transform={`translate(${props.x},${props.y})`}>
                    <text y={12} textAnchor="middle" fill="#b9d0d6" fontSize={11} fontWeight={600}>{t?.label}</text>
                    {t?.date && <text y={26} textAnchor="middle" fill="#66808b" fontSize={9}>{t.date}</text>}
                  </g>
                );
              }} />
            <YAxis dataKey="y" type="number" stroke="#66808b" tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(Number(v), 3)} domain={[0, "auto"]}
              label={{ value: "saliva melatonin (pg/mL)", angle: -90, position: "insideLeft", fill: "#66808b", fontSize: 10 }} />
            <Tooltip content={tipContent} cursor={false} />
            {loq !== null && <ReferenceLine y={loq} stroke="#5d7883" strokeDasharray="3 4" label={{ value: `LOQ ${fmt(loq)}`, position: "insideBottomRight", fill: "#8aa8b2", fontSize: 9 }} />}
            {refLow != null && <ReferenceLine y={refLow} stroke="#2e6b62" strokeDasharray="6 4" />}
            {refHigh != null && <ReferenceLine y={refHigh} stroke="#2e6b62" strokeDasharray="6 4" label={{ value: `reference ${fmt(refLow)}–${fmt(refHigh)}`, position: "insideTopRight", fill: "#5fa89c", fontSize: 9 }} />}
            {model.series.map((s) => (
              <Scatter key={s.key} data={s.data} dataKey="y" fill={colour(s.crew)} line={{ stroke: colour(s.crew), strokeWidth: 2 }} lineJointType="monotoneX"
                isAnimationActive={false} legendType="none" shape={(p: { cx?: number; cy?: number }) => <circle cx={p.cx} cy={p.cy} r={3.6} fill={colour(s.crew)} stroke="#0a1b26" strokeWidth={1} />} />
            ))}
            {model.censored.length > 0 && (
              <Scatter data={model.censored} dataKey="y" isAnimationActive={false} legendType="none"
                shape={(p: { cx?: number; cy?: number; payload?: TPoint }) => <path d={`M${p.cx},${(p.cy ?? 0) - 5} l5,8 h-10 z`} fill="#0a1b26" stroke={colour(p.payload?.crew ?? "")} strokeWidth={1.4} />} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- HISTORY tabs + recycle bin
type DeletedInfo = { rows: (Reading & { deleted_at: string | null; deleted_by: string | null })[]; tester: string; can_purge: boolean };

export function RecordsPage({ onChanged, mode }: { onChanged: () => void; mode: "history" | "trends" }) {
  const [tab, setTab] = useState<"saved" | "deleted">("saved");
  const [bin, setBin] = useState<DeletedInfo | null>(null);
  const [version, setVersion] = useState(0);
  const loadBin = () => call<DeletedInfo>("/api/records/deleted").then(setBin).catch(() => setBin(null));
  useEffect(() => { if (mode === "history") loadBin(); }, [mode, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = () => { setVersion((v) => v + 1); onChanged(); };
  if (mode === "trends") return <RecordsView mode="trends" onChanged={onChanged} />;
  return (
    <>
      <div className="history-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "saved"} className={tab === "saved" ? "on" : ""} onClick={() => setTab("saved")}>SAVED READINGS</button>
        <button role="tab" aria-selected={tab === "deleted"} className={tab === "deleted" ? "on" : ""} onClick={() => setTab("deleted")}>
          RECENTLY DELETED{bin ? ` (${bin.rows.length})` : ""}</button>
      </div>
      {tab === "saved" ? <RecordsView key={`v${version}`} mode="history" onChanged={changed} /> : <DeletedView info={bin} onChanged={changed} setInfo={setBin} />}
    </>
  );
}

function DeletedView({ info, setInfo, onChanged }: { info: DeletedInfo | null; setInfo: (i: DeletedInfo) => void; onChanged: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  if (!info) return <div className="notice subtle">Loading recently deleted readings…</div>;
  const act = (path: string, method: string) =>
    call<DeletedInfo>(path, { method }).then((i) => { setInfo(i); setErr(null); onChanged(); }).catch((e) => setErr(String(e.message ?? e)));
  const canRestore = (r: DeletedInfo["rows"][number]) => info.can_purge || r.entered_by === info.tester || r.deleted_by === info.tester;
  return (
    <Panel n="H2" title="RECENTLY DELETED" tag={`${info.rows.length} READING(S) THAT CAN BE RESTORED`}>
      <div className="lab-body">
        <p className="lab-help">Deleting a reading in History moves it here instead of erasing it. <b>Restore</b> puts it back with its original ID. {info.can_purge ? "Delete permanently empties it from this list; it stays in the backup snapshots in Settings." : "Testers can restore readings they entered or deleted; only the study coordinator can delete permanently."}</p>
        {err && <div className="notice error">{err}</div>}
        {!info.rows.length ? <div className="notice subtle">Nothing has been deleted.</div> : (
          <div className="plan-table-wrap flush">
            <table className="plan-table">
              <thead><tr><th>ID</th><th>CREW</th><th>PHASE</th><th>SAMPLED</th><th>SALIVA (pg/mL)</th><th>ENTERED BY</th><th>DELETED</th><th>DELETED BY</th><th /></tr></thead>
              <tbody>
                {info.rows.map((r) => (
                  <tr key={r.reading_id}>
                    <td>{r.reading_id}</td><td>{r.crew_id}</td><td>{r.mission_phase}</td><td>{r.sampled_at?.replace("T", " ") ?? "—"}</td>
                    <td>{r.saliva_pg_ml !== null ? fmt(r.saliva_pg_ml) : "—"}</td><td>{r.entered_by ?? "—"}</td>
                    <td>{r.deleted_at ? new Date(r.deleted_at).toLocaleString() : "—"}</td><td>{r.deleted_by ?? "—"}</td>
                    <td className="row-actions">
                      {canRestore(r) && <button className="lab-button small" onClick={() => act(`/api/records/deleted/${r.reading_id}/restore`, "POST")}>RESTORE</button>}
                      {info.can_purge && <button className="lab-button danger small" onClick={() => confirm(`Delete reading ${r.reading_id} permanently? It will remain only in backup snapshots.`) && act(`/api/records/deleted/${r.reading_id}`, "DELETE")}>DELETE PERMANENTLY</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ----------------------------------------------------------------------------- SETTINGS: backups
type Snapshot = { name: string; size: number; created: string | null; reason: string | null; readings: number | null; deleted: number | null };
type BackupInfo = {
  snapshots: Snapshot[]; readings: number; deleted: number;
  offsite: { enabled: boolean; repo: string; branch: string; last_ok: string | null; last_error: string | null };
};
const REASON: Record<string, string> = {
  "reading-saved": "reading saved", "reading-deleted": "reading deleted", "reading-restored": "reading restored", "reading-purged": "deleted permanently",
  settings: "settings changed", calibration: "calibration changed", "calibration-removed": "calibration removed", feedback: "feedback sent",
  startup: "server started", manual: "manual backup", restored: "backup restored", "before-restore": "before a restore",
};

function BackupsPanel({ canEdit }: { canEdit: boolean }) {
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { if (canEdit) call<BackupInfo>("/api/backups").then(setInfo).catch((e) => setErr(String(e.message ?? e))); }, [canEdit]);
  const run = (p: Promise<BackupInfo & { restored?: { readings: number; deleted: number } }>, done?: (i: BackupInfo & { restored?: { readings: number } }) => void) => {
    setBusy(true); setErr(null); setMsg(null);
    p.then((i) => { setInfo(i); done?.(i); }).catch((e) => setErr(String(e.message ?? e))).finally(() => setBusy(false));
  };
  const restored = (i: { restored?: { readings: number } }) => {
    setMsg(`Restored: ${i.restored?.readings ?? 0} reading(s). Reloading…`);
    window.setTimeout(() => window.location.reload(), 1200);
  };
  return (
    <Panel n="S4" title="BACKUPS & RESTORE" tag="EVERY CHANGE IS SAVED AS A SNAPSHOT">
      <div className="lab-body">
        {!canEdit ? (
          <p className="lab-help">Every change to the shared data is backed up automatically. The study coordinator can restore an earlier version here.</p>
        ) : !info ? <div className="notice subtle">{err ?? "Loading backups…"}</div> : (
          <>
            <p className="lab-help">After every change (a reading saved or deleted, Settings or the calibration changed) the server keeps a snapshot of all data; the newest 100 are kept. Restoring one first snapshots the current data, so a restore can be undone too.</p>
            <div className={`notice ${info.offsite.enabled && !info.offsite.last_error ? "ok" : ""}`}>
              {info.offsite.enabled
                ? info.offsite.last_error
                  ? <><TriangleAlert size={14} /> Off-site backup to GitHub ({info.offsite.repo}, branch {info.offsite.branch}) failed: {info.offsite.last_error}</>
                  : <><CircleCheck size={14} /> Off-site backup on: copied to GitHub ({info.offsite.repo}, branch <b>{info.offsite.branch}</b>){info.offsite.last_ok ? `, last at ${new Date(info.offsite.last_ok).toLocaleString()}` : ", first copy pending"}. If the server's disk is ever wiped, the data comes back from there on the next start.</>
                : <><TriangleAlert size={14} /> Off-site backup is off: snapshots live on the server's own disk. Download a backup regularly, or set BACKUP_GITHUB_TOKEN and BACKUP_GITHUB_REPO on the host to copy the data to GitHub after every change.</>}
            </div>
            <div className="lab-actions">
              <a className="lab-button primary" href="/api/backups/download" download><Download size={13} /> DOWNLOAD FULL BACKUP NOW</a>
              <button className="lab-button" disabled={busy} onClick={() => run(call("/api/backups/snapshot", { method: "POST" }), () => setMsg("Snapshot saved."))}>SAVE A SNAPSHOT NOW</button>
              <FilePick label="RESTORE FROM A BACKUP FILE" accept=".zip" onFile={(f) => {
                if (!confirm(`Replace all current data with the backup in ${f.name}? The current data is snapshotted first.`)) return;
                const d = new FormData(); d.append("file", f);
                run(call("/api/backups/restore", { method: "POST", body: d }), restored);
              }} />
            </div>
            {msg && <p className="lab-ok"><CircleCheck size={13} /> {msg}</p>}
            {err && <div className="notice error">{err}</div>}
            <p className="lab-meta">Now: {info.readings} saved reading(s), {info.deleted} in Recently deleted.</p>
            <div className="plan-table-wrap flush">
              <table className="plan-table">
                <thead><tr><th>SNAPSHOT TIME</th><th>AFTER</th><th>READINGS</th><th>DELETED</th><th /></tr></thead>
                <tbody>
                  {(showAll ? info.snapshots : info.snapshots.slice(0, 8)).map((b) => (
                    <tr key={b.name}>
                      <td>{b.created ? new Date(b.created).toLocaleString() : b.name}</td><td>{REASON[b.reason ?? ""] ?? b.reason ?? "—"}</td>
                      <td>{b.readings ?? "—"}</td><td>{b.deleted ?? "—"}</td>
                      <td className="row-actions">
                        <a className="lab-button small" href={`/api/backups/download?name=${encodeURIComponent(b.name)}`} download><Download size={12} /> DOWNLOAD</a>
                        <button className="lab-button small" disabled={busy} onClick={() => confirm(`Restore the data as it was at ${b.created ? new Date(b.created).toLocaleString() : b.name} (${b.readings ?? 0} readings)? The current data is snapshotted first.`)
                          && run(call("/api/backups/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: b.name }) }), restored)}>RESTORE</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {info.snapshots.length > 8 && <button className="lab-button small" onClick={() => setShowAll(!showAll)}>{showAll ? "SHOW FEWER" : `SHOW ALL ${info.snapshots.length}`}</button>}
          </>
        )}
      </div>
    </Panel>
  );
}
