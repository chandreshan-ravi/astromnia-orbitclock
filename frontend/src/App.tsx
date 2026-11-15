import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity, Clock3, History, TrendingUp, Database, Download, LogOut, MessageSquare, Settings2, FlaskConical, Moon, Orbit, Pill, Radio, ShieldCheck, Signal,
  Satellite, Sparkles, Users, Waves
} from "lucide-react";
import {
  CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis
} from "recharts";
import "./App.css";
const BrainModel = lazy(() => import("./BrainModel"));
import { MeasurePage, RecordsPage, SetupPage } from "./Lab";
import { OrbitPage } from "./Orbit";
import { AboutModal, FeedbackModal, useSession } from "./Access";
import {
  CREW_COLOURS, STATUS, fetchMission, fetchOptions, fetchSensitivity, fmtClock, fmtOffset,
  type Mission, type Options, type Row, type Sensitivity
} from "./api";

const navItems = [
  { id: "orbit", label: "Live ISS light-dark", icon: Satellite },
  { id: "overview", label: "Mission overview", icon: Orbit },
  { id: "crew", label: "Crew monitoring", icon: Users },
  { id: "clock", label: "Biological clock", icon: Clock3 },
  { id: "hormones", label: "Melatonin laboratory", icon: Waves },
  { id: "sensors", label: "Sensor laboratory", icon: Radio }
];
const inputItems = [
  { id: "measure", label: "Results", icon: Activity, title: "Melatonin analysis" },
  { id: "history", label: "History", icon: History, title: "History" },
  { id: "trends", label: "Trends", icon: TrendingUp, title: "Trends" },
  { id: "setup", label: "Settings", icon: Settings2, title: "Settings & calibration" }
];
const INPUT_IDS = inputItems.map((i) => i.id);

const TIP = { background: "#0a1b26", border: "1px solid #28515d", borderRadius: 8, fontSize: 11 };
const GIVE = "Melatonin";

/** Latest session for each crew member on or before `asOf` (same rule as the Streamlit Crew results tab). */
function latestRows(m: Mission | null, asOf: number): Record<string, Row> {
  const out: Record<string, Row> = {};
  if (!m) return out;
  for (const r of m.rows) if (r.day <= asOf && (!out[r.crew] || r.day > out[r.crew].day)) out[r.crew] = r;
  return out;
}

function App() {
  const { session: auth, signOut } = useSession();
  const [modal, setModal] = useState<"" | "feedback" | "about">("");
  const [active, setActive] = useState("measure");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showDosage, setShowDosage] = useState(false);
  const [keepDosagePanel, setKeepDosagePanel] = useState(false);

  // engine inputs
  const [options, setOptions] = useState<Options | null>(null);
  const [source, setSource] = useState<"sim" | "records">("sim");
  const [sensor, setSensor] = useState("");
  const [cortisol, setCortisol] = useState("");
  const [interval, setIntervalH] = useState(0.5);
  const [seed, setSeed] = useState(7);

  // engine outputs
  const [mission, setMission] = useState<Mission | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [sens, setSens] = useState<Sensitivity | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const dataChanged = () => setDataVersion((v) => v + 1);

  // view state
  const [selectedCrew, setSelectedCrew] = useState("");
  const [asOf, setAsOf] = useState<number | null>(null);
  const [clockHour, setClockHour] = useState(21);

  useEffect(() => {
    fetchOptions()
      .then((o) => {
        setOptions(o);
        setSensor((prev) => (o.sensors.some((x) => x.label === prev) ? prev : o.default_sensor));
        setCortisol((prev) => prev || o.cortisol[0]);
      })
      .catch((e) => { setApiError(String(e)); setLoading(false); });
    if (dataVersion === 0) fetchSensitivity().then(setSens).catch(() => {});
  }, [dataVersion]);

  useEffect(() => {
    if (!options) return;
    let cancelled = false;
    setLoading(true);
    fetchMission({ source, sensor, cortisol, interval, seed })
      .then((m) => {
        if (cancelled) return;
        setMission(m);
        setApiError(null);
        if (!m.error && m.sessions.length) {
          setAsOf((prev) => (prev !== null && m.sessions.some((s) => s.day === prev) ? prev : m.sessions[m.sessions.length - 1].day));
          setSelectedCrew((prev) => (m.crew.some((c) => c.id === prev) ? prev : m.crew[0].id));
        }
      })
      .catch((e) => !cancelled && setApiError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [options, source, sensor, cortisol, interval, seed]);  // options is refetched (new object) whenever saved data change

  const ok = mission && !mission.error && mission.sessions.length > 0;
  const sessions = ok ? mission.sessions : [];
  const sessionIdx = Math.max(0, sessions.findIndex((s) => s.day === asOf));
  const session = sessions[sessionIdx];
  const latest = useMemo(() => latestRows(ok ? mission : null, asOf ?? Infinity), [ok, mission, asOf]);
  const crew = ok ? mission.crew : [];
  const colour = (id: string) => CREW_COLOURS[Math.max(0, crew.findIndex((c) => c.id === id)) % CREW_COLOURS.length];
  const row: Row | undefined = latest[selectedCrew];
  const person = crew.find((c) => c.id === selectedCrew);
  const nGive = Object.values(latest).filter((r) => r.plan.action === GIVE).length;
  const status = (r?: Row) => STATUS[r?.level ?? "unknown"] ?? STATUS.unknown;

  const openDosage = (id?: string) => { if (id) setSelectedCrew(id); setKeepDosagePanel(true); setShowDosage(true); };
  const closeDosage = () => { setShowDosage(false); window.setTimeout(() => setKeepDosagePanel(false), 350); };

  // sensor readability from the Monte-Carlo table (log-interpolated)
  const sensorLoq = mission?.sensor_loq ?? options?.sensors.find((s) => s.label === sensor)?.loq ?? null;
  const readability = useMemo(() => {
    if (!sens || sensorLoq === null) return null;
    const pts = sens.rows.filter((r) => r.interval_h === interval).sort((a, b) => a.loq - b.loq);
    if (!pts.length) return null;
    if (sensorLoq <= pts[0].loq) return pts[0].within_30min_pct;
    if (sensorLoq >= pts[pts.length - 1].loq) return pts[pts.length - 1].within_30min_pct;
    for (let i = 1; i < pts.length; i++) {
      if (sensorLoq <= pts[i].loq) {
        const f = (Math.log(sensorLoq) - Math.log(pts[i - 1].loq)) / (Math.log(pts[i].loq) - Math.log(pts[i - 1].loq));
        return pts[i - 1].within_30min_pct + f * (pts[i].within_30min_pct - pts[i - 1].within_30min_pct);
      }
    }
    return null;
  }, [sens, sensorLoq, interval]);
  const inflight = ok ? mission.rows.filter((r) => r.phase !== "preflight") : [];
  const readPct = inflight.length ? Math.round((100 * inflight.filter((r) => r.dlmo_status === "ok").length) / inflight.length) : 0;

  const title = inputItems.find((item) => item.id === active)?.title ?? navItems.find((item) => item.id === active)?.label ?? "Mission overview";
  const isInput = INPUT_IDS.includes(active);
  const sourceLabel = source === "sim" ? "SIMULATED MISSION" : "RECORDED READINGS";

  return (
    <main className="app-shell">
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <button className="sidebar-toggle" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>{sidebarCollapsed ? "❯" : "❮"}</button>
        <div className="brand">
          <div className="brand-mark"><img src="/astromnia-logo.png" alt="ASTROMNIA Logo" /></div>
          <div>
            <div className="brand-name">ASTROMNIA</div>
            <div className="brand-sub">ANALYSIS SOFTWARE</div>
          </div>
        </div>
        <div className="side-label">MELATONIN ANALYSIS</div>
        <nav className="nav-group">
          {inputItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={`nav-item ${active === item.id ? "selected" : ""}`} onClick={() => setActive(item.id)}>
                <Icon size={17} /><span>{item.label}</span>{active === item.id && <span className="nav-indicator" />}
              </button>
            );
          })}
        </nav>
        <div className="side-label">MISSION SYSTEMS</div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={`nav-item ${active === item.id ? "selected" : ""}`} onClick={() => setActive(item.id)}>
                <Icon size={17} /><span>{item.label}</span>{active === item.id && <span className="nav-indicator" />}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          {auth.tester && <div className="who"><span>SIGNED IN</span><b>{auth.tester}</b>{auth.role === "admin" && <i>COORDINATOR</i>}</div>}
          <button className="sidebar-link icon" onClick={() => setModal("feedback")}><MessageSquare size={14} /><span>Send feedback</span></button>
          {auth.role === "admin" && <a className="sidebar-link icon" href="/api/feedback.csv" download><Download size={14} /><span>Download feedback</span></a>}
          <button className="sidebar-link icon" onClick={() => setModal("about")}><Orbit size={14} /><span>About, sources &amp; credits</span></button>
          {auth.required && <button className="sidebar-link icon" onClick={signOut}><LogOut size={14} /><span>Sign out</span></button>}
          <div className="ai-label">Research prototype, not a medical device · Developed with AI assistance (Claude Code), see About</div>
        </div>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <div>
            <div className="eyebrow">CONNECTED CREW HEALTH / CIRCADIAN ANALYTICS</div>
            <h1>{title.toUpperCase()}</h1>
            <p className="top-subtitle">Body-clock estimates and melatonin plans computed by the OrbitClock engine</p>
          </div>
          <div className="top-status">
            <div className="secure-box"><ShieldCheck size={16} /><span>ORBITCLOCK ENGINE</span><strong>{apiError ? "OFFLINE" : loading ? "RUNNING…" : "RESULTS READY"}</strong></div>
            <div className="online-box"><span className={`pulse-dot ${apiError ? "dot-off" : ""}`} /> {sourceLabel}</div>
          </div>
        </header>

        <div className="mission-strip">
          <div><span className="strip-label">DATA SOURCE</span>
            <div className="source-toggle">
              <button className={source === "sim" ? "on" : ""} onClick={() => setSource("sim")}><FlaskConical size={12} /> SIMULATED</button>
              <button className={source === "records" ? "on" : ""} onClick={() => setSource("records")}
                title={`${options?.records.count ?? 0} saved reading(s)`}><Database size={12} /> RECORDS ({options?.records.count ?? 0})</button>
            </div>
          </div>
          <div><span className="strip-label">ASSESSED AS OF</span><strong>{session?.label ?? "—"}</strong></div>
          <div><span className="strip-label">SELECTED CREW</span><strong>{selectedCrew || "—"}</strong></div>
          <div><span className="strip-label">MELATONIN SENSOR</span><strong className="teal-text strip-sensor" title={mission?.sensor}>{mission?.sensor ?? "—"}</strong></div>
          <div className="strip-right"><Signal size={15} /> {ok ? (nGive ? `${nGive} CREW NEED MELATONIN` : "NO MELATONIN NEEDED") : "AWAITING DATA"}</div>
        </div>

        <div className="content">
          <div className="section-heading">
            <div><span className="section-index">01</span><span>{title.toUpperCase()}</span></div>
            <span className="demo-label">{isInput ? "SHARED STUDY DATASET · FEEDS THE RECORDS DATA SOURCE" : source === "sim" ? "SYNTHETIC CREW · SIMULATOR OUTPUT" : mission?.simulated_files ? "RECORDS · INCLUDES SIMULATED FILES" : "RECORDED READINGS"}</span>
          </div>

          {apiError && (
            <div className="notice error">The OrbitClock engine is not reachable ({apiError}). Reload the page in a minute; if it persists, tell the study coordinator.</div>
          )}
          {!isInput && mission?.error && <div className="notice">{mission.error}</div>}
          {!isInput && source === "records" && ok && mission.skipped ? <div className="notice subtle">{mission.skipped} saved reading(s) skipped: above the calibration range, or missing time, phase or LOQ.</div> : null}

          {active === "setup" && <SetupPage onChanged={dataChanged} />}
          {active === "measure" && <MeasurePage crewIds={options?.records.crew ?? []} onSaved={dataChanged} goSetup={() => setActive("setup")} dataVersion={dataVersion} />}
          {active === "orbit" && (
            <OrbitPage nGive={ok && source === "sim" ? nGive : null} onOpenMission={() => { setSource("sim"); setActive("overview"); }}>
              {ok && source === "sim" && <>
                <p className="lab-help strong">Simulated crew: body-clock offset from each member's pre-flight baseline across the mission (dashed lines: 1 h = melatonin, 2 h = high priority).</p>
                <OffsetChart mission={mission} colour={colour} asOf={asOf} height={260} />
              </>}
              {source !== "sim" && <p className="lab-help">Switch the data source to SIMULATED to see the simulated crew's body-clock drift here.</p>}
            </OrbitPage>
          )}
          {active === "history" && <RecordsPage mode="history" onChanged={dataChanged} />}
          {active === "trends" && <RecordsPage mode="trends" onChanged={dataChanged} />}

          {ok && active === "overview" && (
            <>
              <section className="metric-grid">
                <Metric icon={<Users />} label="CREW MONITORED" value={String(crew.length).padStart(2, "0")} note={`${nGive} need melatonin as of ${session?.label}`} />
                <Metric icon={<Moon />} label="DLMO ESTIMATE" value={row?.dlmo ?? "—"} note={`${selectedCrew} · ${row?.label ?? ""} · confidence ${row?.confidence ?? "—"}`} />
                <Metric icon={<Clock3 />} label="CLOCK OFFSET" value={fmtOffset(row?.offset_h)} note={`vs own pre-flight baseline ${person?.baseline_dlmo ?? "(none)"}`} />
                <Metric icon={<Pill />} label="MELATONIN DOSE" value={row?.plan.action === GIVE ? `${row.plan.dose_mg} mg` : "NONE"}
                  note={row?.plan.action === GIVE ? `take at ${row.plan.take_at}` : row?.plan.action ?? ""} accent={row?.plan.action === GIVE} />
              </section>

              <div className="dashboard-grid">
                <section className="panel twin-panel">
                  <PanelTitle number="02" title="CREW DIGITAL TWIN" tag="CLICK THE BRAIN FOR THE DOSAGE RESULT" />
                  <div className="twin-content">
                    <div className="orbit-rings">
                      <div className="ring ring-one" /><div className="ring ring-two" /><div className="ring ring-three" />
                      <Suspense fallback={<div className="brain-loading">LOADING 3D MODEL…</div>}><BrainModel onPinealClick={() => (showDosage ? closeDosage() : openDosage())} /></Suspense>
                      <div className="twin-orbit-label label-top">BIOLOGICAL PROFILE</div>
                      <div className="twin-orbit-label label-bottom">CREW ID // {selectedCrew}</div>
                    </div>
                    <div className="twin-info">
                      <div className="profile-label">ACTIVE CREW MEMBER</div>
                      <h2>{selectedCrew}</h2>
                      <p>{person?.role}{person?.scenario ? ` · ${person.scenario}` : ""}</p>
                      <div className={`status-pill ${status(row).cls}`}>{status(row).label}</div>
                      <div className="profile-divider" />
                      <div className="profile-stat"><span>ESTIMATED DLMO</span><strong>{row?.dlmo ?? "—"}</strong></div>
                      <div className="profile-stat"><span>CLOCK OFFSET</span><strong>{fmtOffset(row?.offset_h)}</strong></div>
                      <div className="profile-stat"><span>MELATONIN</span><strong className={row?.plan.action === GIVE ? "dose-text" : ""}>{row?.plan.action === GIVE ? row.plan.dose_text : row?.plan.action ?? "—"}</strong></div>
                      <label className="select-label" htmlFor="crew-select">CHANGE CREW MEMBER</label>
                      <select id="crew-select" value={selectedCrew} onChange={(e) => setSelectedCrew(e.target.value)}>
                        {crew.map((c) => <option key={c.id} value={c.id}>{c.id} — {c.role}</option>)}
                      </select>
                      <button className="text-button dose-button" onClick={() => openDosage()}><Pill size={12} /> VIEW DOSAGE RESULT</button>
                    </div>
                  </div>
                </section>

                <section className="panel clock-panel">
                  <PanelTitle number="03" title="CIRCADIAN CLOCK" tag={`${selectedCrew} · ${row?.label ?? ""}`} />
                  <div className="clock-wrap">
                    <ClockFace hour={clockHour} row={row} radius={105} />
                    <div className="clock-controls">
                      <label htmlFor="clock-slider">EXPLORE SHIP TIME</label>
                      <input id="clock-slider" type="range" min="0" max="23" value={clockHour} onChange={(e) => setClockHour(Number(e.target.value))} />
                      <ClockLegend />
                    </div>
                  </div>
                </section>

                <section className="panel chart-panel">
                  <PanelTitle number="04" title="MELATONIN PROFILE" tag={`${selectedCrew} · ${row?.label ?? ""} EVENING SERIES`} />
                  <EveningChart row={row} colour={colour(selectedCrew)} height={225} />
                </section>

                <section className="panel mission-panel">
                  <PanelTitle number="05" title="MISSION TIMELINE" tag="ASSESS AS OF SESSION" />
                  <div className="timeline-number">SESSION <strong>{session?.label}</strong><span> · {sessionIdx + 1} / {sessions.length}</span></div>
                  <input aria-label="Session" className="mission-slider" type="range" min="0" max={sessions.length - 1} value={sessionIdx}
                    onChange={(e) => setAsOf(sessions[Number(e.target.value)].day)} />
                  <div className="timeline-labels"><span>{sessions[0]?.label}</span><span>{sessions[sessions.length - 1]?.label}</span></div>
                  <div className="timeline-data">
                    <div><span>CLOCK OFFSET</span><strong>{fmtOffset(row?.offset_h)}</strong></div>
                    <div><span>DLMO</span><strong>{row?.dlmo ?? "—"}</strong></div>
                    <div><span>PLAN</span><strong className={row?.plan.action === GIVE ? "dose-text" : ""}>{row?.plan.action === GIVE ? row.plan.dose_text : row?.plan.action}</strong></div>
                  </div>
                  <div className="crew-chips">
                    {crew.map((c) => {
                      const r = latest[c.id];
                      return (
                        <button key={c.id} className={`crew-chip ${c.id === selectedCrew ? "on" : ""}`} onClick={() => setSelectedCrew(c.id)}>
                          <i style={{ background: colour(c.id) }} />{c.id}
                          <b className={r?.plan.action === GIVE ? "dose-text" : ""}>{r?.plan.action === GIVE ? r.plan.dose_text : r?.plan.action ?? "—"}</b>
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>
            </>
          )}

          {ok && active === "crew" && (
            <section className="panel full-panel">
              <PanelTitle number="06" title="CREW MONITORING" tag={`MELATONIN PLAN AS OF ${session?.label}`} />
              <SessionSlider sessions={sessions} idx={sessionIdx} onChange={(d) => setAsOf(d)} />
              <div className="crew-list">
                {crew.map((c) => {
                  const r = latest[c.id];
                  return (
                    <div key={c.id} role="button" tabIndex={0} className={`crew-row ${selectedCrew === c.id ? "crew-active" : ""}`}
                      onClick={() => setSelectedCrew(c.id)} onKeyDown={(e) => e.key === "Enter" && setSelectedCrew(c.id)}>
                      <span className="crew-avatar" style={{ borderColor: colour(c.id), color: colour(c.id) }}>{c.id.slice(-1)}</span>
                      <span className="crew-identity"><strong>{c.id} · {c.role}</strong><small>{r?.label} · {r?.plan.headline}</small></span>
                      <span className={`status-pill ${status(r).cls}`}>{status(r).label}</span>
                      <span className="crew-dlmo"><small>DLMO</small><strong>{r?.dlmo ?? "—"}</strong></span>
                      <span className="crew-offset"><small>CLOCK OFFSET</small><strong>{fmtOffset(r?.offset_h)}</strong></span>
                      <span className="crew-dose"><small>MELATONIN</small><strong className={r?.plan.action === GIVE ? "dose-text" : "muted-text"}>{r?.plan.action === GIVE ? r.plan.dose_text : r?.plan.action ?? "—"}</strong></span>
                      <button className="text-button" onClick={(e) => { e.stopPropagation(); openDosage(c.id); }}>DETAILS</button>
                    </div>
                  );
                })}
              </div>
              <PlanTable rows={mission.rows.filter((r) => r.crew === selectedCrew)} asOf={asOf} onPick={(d) => setAsOf(d)} />
              <p className="panel-footnote">Plans follow fixed rules: 0.5 mg melatonin 4 h before the current DLMO, only when the clock runs at least {mission.watch_h} h later than the crew member's own pre-flight baseline. Every plan needs flight-surgeon approval before use.</p>
            </section>
          )}

          {ok && active === "clock" && (
            <section className="panel full-panel">
              <PanelTitle number="07" title="BIOLOGICAL CLOCK EXPLORER" tag={`${selectedCrew} · ${row?.label ?? ""}`} />
              <div className="explorer-clock">
                <ClockFace hour={clockHour} row={row} radius={140} large />
                <div className="explorer-controls">
                  <div className="profile-label">ACTIVE CREW</div>
                  <h2>{selectedCrew}</h2>
                  <p>DLMO {row?.dlmo ?? "not read"} · baseline {person?.baseline_dlmo ?? "—"} · offset {fmtOffset(row?.offset_h)}</p>
                  <label htmlFor="clock-large">SHIP TIME · {String(clockHour).padStart(2, "0")}:00</label>
                  <input id="clock-large" type="range" min="0" max="23" value={clockHour} onChange={(e) => setClockHour(Number(e.target.value))} />
                  <div className="time-buttons">
                    {row?.plan.take_at_h != null && row.plan.action === GIVE && <button onClick={() => setClockHour(Math.floor(row.plan.take_at_h!))}>DOSE {row.plan.take_at}</button>}
                    {row?.dlmo_h != null && <button onClick={() => setClockHour(Math.floor(row.dlmo_h!))}>DLMO {row.dlmo}</button>}
                    {[0, 6, 12, 18].map((h) => <button key={h} onClick={() => setClockHour(h)}>{String(h).padStart(2, "0")}:00</button>)}
                  </div>
                  <ClockLegend />
                  <div className="interpretation-box"><Sparkles size={17} /><span>{clockText(clockHour, row)}</span></div>
                  {row?.timing.length ? (
                    <ul className="plan-list">{row.timing.map((t) => <li key={t}>{t}</li>)}</ul>
                  ) : null}
                </div>
              </div>
            </section>
          )}

          {ok && active === "hormones" && (
            <section className="panel full-panel">
              <PanelTitle number="08" title="MELATONIN LABORATORY" tag="BODY-CLOCK ANALYSIS" />
              <div className="lab-summary">
                <div><span>ACTIVE CREW</span><strong>{selectedCrew} · {row?.label}</strong></div>
                <div><span>DLMO (95% INTERVAL)</span><strong>{row?.dlmo ?? "not read"}{row?.series?.ci_low != null ? ` (${fmtClock(row.series.ci_low)}–${fmtClock(row.series.ci_high)})` : ""}</strong></div>
                <div><span>READINGS BELOW LOQ</span><strong>{row?.n_censored ?? "—"} of {row?.n_mel ?? "—"}</strong></div>
              </div>
              <SessionSlider sessions={sessions} idx={sessionIdx} onChange={(d) => setAsOf(d)} />
              <div className="lab-grid">
                <div>
                  <div className="chart-caption">EVENING MELATONIN · {selectedCrew} · {row?.label}</div>
                  <EveningChart row={row} colour={colour(selectedCrew)} height={320} />
                </div>
                <div>
                  <div className="chart-caption">CLOCK OFFSET VS OWN BASELINE · ALL CREW</div>
                  <OffsetChart mission={mission} colour={colour} asOf={asOf} height={320} />
                </div>
              </div>
              {row && (
                <div className="findings">
                  <div className="profile-label">ENGINE INTERPRETATION</div>
                  <p className="finding-head">{row.headline}</p>
                  <ul className="plan-list">{row.findings.map((f) => <li key={f}>{f}</li>)}</ul>
                </div>
              )}
            </section>
          )}

          {active === "sensors" && options && (
            <section className="panel full-panel">
              <PanelTitle number="09" title="SENSOR LABORATORY" tag="RE-RUNS THE MISSION SIMULATOR" />
              {source === "records" && <div className="notice subtle inset">Sensor settings apply to the simulated mission. Switch DATA SOURCE to SIMULATED to use them.</div>}
              <div className="sensor-controls four">
                <div className="sensor-control">
                  <label htmlFor="sensor-select">MELATONIN SENSOR</label>
                  <strong>{sensorLoq !== null ? `${sensorLoq.toLocaleString(undefined, { maximumSignificantDigits: 3 })} pg/mL` : "—"}</strong>
                  <select id="sensor-select" value={sensor} onChange={(e) => { setSensor(e.target.value); setSource("sim"); }}>
                    {options.sensors.map((s) => <option key={s.label} value={s.label}>{s.label}</option>)}
                  </select>
                  <small>Saliva LOQ. Every simulated reading below it is censored.{options.your_loq !== null ? " “Your sensor” comes from the calibration saved in OrbitClock Setup." : ""}</small>
                </div>
                <div className="sensor-control">
                  <label htmlFor="sampling-select">EVENING SAMPLING INTERVAL</label>
                  <strong>{interval * 60} min</strong>
                  <select id="sampling-select" value={interval} onChange={(e) => { setIntervalH(Number(e.target.value)); setSource("sim"); }}>
                    <option value={0.5}>Every 30 minutes</option>
                    <option value={1}>Every 60 minutes</option>
                  </select>
                  <small>Saliva samples from about 6 h before usual sleep until bedtime.</small>
                </div>
                <div className="sensor-control">
                  <label htmlFor="cort-select">CORTISOL SENSOR</label>
                  <strong>{cortisol.split(" (")[0]}</strong>
                  <select id="cort-select" value={cortisol} onChange={(e) => { setCortisol(e.target.value); setSource("sim"); }}>
                    {options.cortisol.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <small>Used for the stress and awakening-response checks.</small>
                </div>
                <div className="sensor-control">
                  <label htmlFor="seed-input">SIMULATION SEED</label>
                  <strong>{seed}</strong>
                  <input id="seed-input" className="seed-input" type="number" min={0} max={9999} value={seed}
                    onChange={(e) => { setSeed(Math.max(0, Math.min(9999, Number(e.target.value) || 0))); setSource("sim"); }} />
                  <small>Change it to draw a new noisy mission.</small>
                </div>
              </div>
              <div className="sensor-result">
                <div className="sensor-gauge" style={{ borderColor: readPct >= 80 ? "var(--teal)" : readPct >= 40 ? "#f2bd72" : "#ff8888" }}>
                  <strong>{ok ? `${readPct}%` : "—"}</strong><span>CLOCKS READ</span>
                </div>
                <div>
                  <div className="profile-label">RESULT FOR THIS MISSION RUN</div>
                  <h2>{readPct >= 80 ? "Body clock readable" : readPct >= 40 ? "Partly readable" : "Body clock cannot be read"}</h2>
                  <p>
                    {ok ? `${inflight.filter((r) => r.dlmo_status === "ok").length} of ${inflight.length} in-flight and post-flight evenings produced a DLMO estimate. ` : ""}
                    {readability !== null ? `In the sensitivity simulation, a sensor at this LOQ places DLMO within 30 min on ${Math.round(readability)}% of evenings at ${interval * 60}-min sampling. ` : ""}
                    {sens?.required_30 != null ? `Largest usable LOQ: ${sens.required_30} pg/mL (30-min) · ${sens.required_60} pg/mL (60-min).` : ""}
                    {nGive ? ` ${nGive} crew member(s) get a melatonin dose as of ${session?.label}.` : ""}
                  </p>
                </div>
              </div>
              {sens && <SensitivityChart sens={sens} loq={sensorLoq} />}
            </section>
          )}

          <footer className="footer">
            <span><i className="legend-dot teal" /> ORBITCLOCK MELATONIN MONITORING PLATFORM</span>
            <span>RESEARCH PROTOTYPE · {source === "sim" ? "SYNTHETIC DATA" : "RECORDED DATA"} · NOT A MEDICAL DEVICE · PLANS NEED FLIGHT-SURGEON APPROVAL</span>
            <span>ORBITCLOCK ENGINE</span>
          </footer>
        </div>
      </section>

      {modal === "feedback" && <FeedbackModal page={title} onClose={() => setModal("")} />}
      {modal === "about" && <AboutModal onClose={() => setModal("")} />}
      {keepDosagePanel && createPortal(
        <div className={`dosage-overlay ${showDosage ? "" : "closing"}`} onClick={closeDosage}>
          <div className={`dosage-chat ${showDosage ? "" : "closing"}`} onClick={(e) => e.stopPropagation()}>
            <div className="dosage-chat-header">
              <div>
                <div className="profile-label">ASTROMNIA ASSISTANT · ORBITCLOCK ENGINE</div>
                <h2>DOSAGE RESULT</h2>
              </div>
              <button className="dosage-close" onClick={closeDosage}>×</button>
            </div>
            <div className="dosage-scroll">
              {row ? (
                <div className="dosage-message">
                  <span className="profile-label">{selectedCrew} · {row.label} · MELATONIN ASSESSMENT</span>
                  <div className={`dosage-value ${row.plan.action === GIVE ? "" : "dosage-none"}`}>
                    {row.plan.action === GIVE ? `${row.plan.dose_mg} mg at ${row.plan.take_at}` : row.plan.action.toUpperCase()}
                  </div>
                  {row.plan.action === GIVE && <div className="dosage-window">Acceptable window {row.plan.window.join("–")}{row.plan.priority ? " · HIGH PRIORITY" : ""}</div>}
                  <p className="dosage-head">{row.plan.headline}</p>
                  <ul>{row.plan.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                  {row.plan.light.length > 0 && (<><span className="profile-label">LIGHT TIMING</span><ul>{row.plan.light.map((r) => <li key={r}>{r}</li>)}</ul></>)}
                  <div className="dosage-stats">
                    <div><span>DLMO</span><b>{row.dlmo ?? "—"}</b></div>
                    <div><span>BASELINE</span><b>{person?.baseline_dlmo ?? "—"}</b></div>
                    <div><span>OFFSET</span><b>{fmtOffset(row.offset_h)}</b></div>
                    <div><span>CONFIDENCE</span><b>{row.confidence}</b></div>
                  </div>
                </div>
              ) : <div className="dosage-message"><div className="dosage-value dosage-none">NO DATA</div><p>No session for this crew member yet.</p></div>}
              <div className="dosage-crew">
                <span className="profile-label">ALL CREW · AS OF {session?.label}</span>
                {crew.map((c) => {
                  const r = latest[c.id];
                  return (
                    <button key={c.id} className={c.id === selectedCrew ? "on" : ""} onClick={() => setSelectedCrew(c.id)}>
                      <i style={{ background: colour(c.id) }} /><span>{c.id}</span>
                      <b className={r?.plan.action === GIVE ? "dose-text" : ""}>{r?.plan.action === GIVE ? r.plan.dose_text : r?.plan.action ?? "—"}</b>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="dosage-chat-footer">SUGGESTION FOR FLIGHT-SURGEON APPROVAL · NOT A MEDICAL DEVICE</div>
          </div>
        </div>,
        document.body
      )}
    </main>
  );
}

function clockText(hour: number, row?: Row): string {
  if (!row || row.dlmo_h == null) return "No DLMO estimate for this session, so biological night cannot be placed on the clock.";
  const d = (h: number) => (((h - row.dlmo_h!) % 24) + 24) % 24; // hours since DLMO
  const since = d(hour);
  const dose = row.plan.action === GIVE && row.plan.take_at_h != null ? row.plan.take_at_h : null;
  if (dose !== null && Math.abs(((hour - dose + 36) % 24) - 12) >= 11) return `Melatonin dose time (${row.plan.take_at}): ${row.plan.dose_mg} mg, 4 h before this crew member's DLMO.`;
  if (since < 10) return `${String(hour).padStart(2, "0")}:00 is ${since.toFixed(0)} h after DLMO (${row.dlmo}): biological night, melatonin elevated. Keep light dim.`;
  if (since >= 20) return `${String(hour).padStart(2, "0")}:00 is ${(24 - since).toFixed(0)} h before DLMO: melatonin still low, the window where a dose advances the clock.`;
  return `${String(hour).padStart(2, "0")}:00 is biological day for this crew member (DLMO ${row.dlmo}).`;
}

function ClockFace({ hour, row, radius, large }: { hour: number; row?: Row; radius: number; large?: boolean }) {
  const mark = (h: number) => ({ transform: `rotate(${h * 15}deg) translateY(-${radius - 22}px)` });
  const nightStart = row?.dlmo_h ?? null;
  return (
    <div className={`clock-face ${large ? "large-clock" : ""}`}>
      <div className="clock-track" />
      {nightStart !== null && (
        <div className="clock-night" style={{
          background: `conic-gradient(from ${nightStart * 15}deg, #58e2cc33 0deg 150deg, transparent 150deg 360deg)`
        }} />
      )}
      <div className="clock-progress" style={{ transform: `rotate(${hour * 15}deg)` }} />
      <div className="clock-center"><Moon size={large ? 30 : 25} /><strong>{String(hour).padStart(2, "0")}:00</strong><small>SHIP TIME</small></div>
      {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
        <span key={h} className="clock-tick" style={{ transform: `rotate(${h * 15}deg) translateY(-${radius}px) rotate(-${h * 15}deg)` }}>{String(h).padStart(2, "0")}</span>
      ))}
      {row?.dlmo_h != null && <span className="clock-marker dlmo" style={mark(row.dlmo_h)} title={`DLMO ${row.dlmo}`} />}
      {row?.plan.action === GIVE && row.plan.take_at_h != null && <span className="clock-marker dose" style={mark(row.plan.take_at_h)} title={`Dose ${row.plan.take_at}`} />}
    </div>
  );
}

function ClockLegend() {
  return (
    <div className="clock-legend">
      <span><i className="legend-dot teal" /> DLMO</span>
      <span><i className="legend-dot amber" /> Melatonin dose</span>
      <span><i className="legend-band" /> Biological night (DLMO + 10 h)</span>
    </div>
  );
}

function EveningChart({ row, colour, height }: { row?: Row; colour: string; height: number }) {
  const s = row?.series;
  if (!s) return <div className="empty-chart" style={{ height }}>No melatonin samples for this session.</div>;
  const vals = s.v.filter((v): v is number => v !== null);
  const ytop = Math.max((vals.length ? Math.max(...vals) : 0) * 1.15, s.threshold * 2.2);
  const loqOnScale = s.loq <= ytop;
  const data = s.t.map((t, i) => ({
    t, v: s.censored[i] ? null : s.v[i], c: s.censored[i] ? (loqOnScale ? s.loq : ytop * 0.04) : null
  }));
  const dose = row?.plan.action === GIVE ? row.plan.take_at_h : null;
  const doseX = dose != null ? (dose < s.t[0] - 6 ? dose + 24 : dose) : null;
  const xmin = Math.min(s.t[0], doseX ?? Infinity) - 0.25;
  const xmax = s.t[s.t.length - 1] + 0.25;
  return (
    <div className="chart-area" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 24, right: 16, left: -8, bottom: 0 }}>
          <CartesianGrid stroke="#1b3542" strokeDasharray="3 5" />
          <XAxis dataKey="t" type="number" domain={[xmin, xmax]} tickFormatter={fmtClock} stroke="#66808b" tick={{ fontSize: 10 }} tickCount={8} />
          <YAxis domain={[0, Math.ceil(ytop)]} stroke="#66808b" tick={{ fontSize: 10 }} unit="" label={{ value: "pg/mL", angle: -90, position: "insideLeft", fill: "#66808b", fontSize: 10, dx: 14 }} />
          <Tooltip contentStyle={TIP} labelFormatter={(t) => fmtClock(Number(t))}
            formatter={(v, name) => (name === "Below LOQ" ? [`< ${s.loq.toLocaleString(undefined, { maximumSignificantDigits: 3 })} pg/mL`, name] : [`${Number(v).toFixed(1)} pg/mL`, name])} />
          {s.ci_low != null && s.ci_high != null && <ReferenceArea x1={s.ci_low} x2={s.ci_high} fill={colour} fillOpacity={0.12} />}
          <ReferenceLine y={s.threshold} stroke="#8aa8b2" strokeDasharray="4 4" label={{ value: `onset threshold ${s.threshold} pg/mL`, position: "insideTopLeft", fill: "#8aa8b2", fontSize: 9 }} />
          {loqOnScale && Math.abs(s.loq - s.threshold) > 1e-6 && <ReferenceLine y={s.loq} stroke="#5d7883" strokeDasharray="2 4" label={{ value: `sensor LOQ ${s.loq}`, position: "insideBottomRight", fill: "#5d7883", fontSize: 9 }} />}
          {s.dlmo_h != null && <ReferenceLine x={s.dlmo_h} stroke="#58e2cc" label={{ value: `DLMO ${fmtClock(s.dlmo_h)}`, position: "top", fill: "#58e2cc", fontSize: 10 }} />}
          {doseX != null && doseX >= xmin && <ReferenceLine x={doseX} stroke="#f2bd72" strokeDasharray="5 3" label={{ value: `dose ${row?.plan.take_at}`, position: "insideTopRight", fill: "#f2bd72", fontSize: 10 }} />}
          <Line dataKey="v" name="Melatonin" stroke={colour} strokeWidth={2} dot={{ r: 3, fill: colour }} connectNulls isAnimationActive={false} />
          <Scatter dataKey="c" name="Below LOQ" fill="#0a1b26" stroke="#8aa8b2" shape="triangle" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      {!loqOnScale && <div className="chart-note">Sensor LOQ {s.loq.toLocaleString()} pg/mL is far above this scale: every reading is censored (▼).</div>}
    </div>
  );
}

function OffsetChart({ mission, colour, asOf, height }: { mission: Mission; colour: (id: string) => string; asOf: number | null; height: number }) {
  const byDay = new Map<number, Record<string, number | string>>();
  for (const s of mission.sessions) byDay.set(s.day, { day: s.day, label: s.label });
  for (const r of mission.rows) if (r.offset_h !== null && r.dlmo_status === "ok") byDay.get(r.day)![r.crew] = r.offset_h;
  const data = [...byDay.values()];
  const labels = new Map(mission.sessions.map((s) => [s.day, s.label]));
  return (
    <div className="chart-area" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 16, left: -8, bottom: 0 }}>
          <CartesianGrid stroke="#1b3542" strokeDasharray="3 5" />
          <XAxis dataKey="day" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(d) => labels.get(d) ?? ""} stroke="#66808b" tick={{ fontSize: 10 }}
            ticks={mission.sessions.map((s) => s.day)} interval="preserveStartEnd" />
          <YAxis stroke="#66808b" tick={{ fontSize: 10 }} tickFormatter={(v) => `${v > 0 ? "+" : ""}${v} h`} />
          <Tooltip contentStyle={TIP} labelFormatter={(d) => labels.get(Number(d)) ?? ""} formatter={(v, n) => [fmtOffset(Number(v)), n]} />
          <Legend wrapperStyle={{ fontSize: 10 }} />
          <ReferenceLine y={0} stroke="#2b4d59" />
          <ReferenceLine y={mission.watch_h} stroke="#a17a44" strokeDasharray="3 4" label={{ value: "watch", position: "insideTopRight", fill: "#f2bd72", fontSize: 9 }} />
          <ReferenceLine y={mission.alert_h} stroke="#a64b55" strokeDasharray="3 4" label={{ value: "alert", position: "insideTopRight", fill: "#ff8888", fontSize: 9 }} />
          <ReferenceLine y={-mission.watch_h} stroke="#a17a44" strokeDasharray="3 4" />
          {asOf !== null && <ReferenceLine x={asOf} stroke="#58e2cc" strokeOpacity={0.5} />}
          {mission.crew.map((c) => (
            <Line key={c.id} dataKey={c.id} stroke={colour(c.id)} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function SensitivityChart({ sens, loq }: { sens: Sensitivity; loq: number | null }) {
  const loqs = [...new Set(sens.rows.map((r) => r.loq))].sort((a, b) => a - b);
  const data = loqs.map((l) => ({
    loq: l,
    m30: sens.rows.find((r) => r.loq === l && r.interval_h === 0.5)?.within_30min_pct,
    m60: sens.rows.find((r) => r.loq === l && r.interval_h === 1)?.within_30min_pct,
  }));
  const max = loqs[loqs.length - 1];
  return (
    <div className="sens-chart">
      <div className="chart-caption">EVENINGS WITH DLMO WITHIN 30 MIN OF THE TRUTH · BY SENSOR LOQ (SIMULATED)</div>
      <div className="chart-area" style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 24, left: -8, bottom: 0 }}>
            <CartesianGrid stroke="#1b3542" strokeDasharray="3 5" />
            <XAxis dataKey="loq" type="number" scale="log" domain={[loqs[0], max]} ticks={[0.5, 1, 2, 5, 10, 20, 40, 100]} stroke="#66808b" tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}`} label={{ value: "saliva LOQ (pg/mL)", position: "insideBottomRight", offset: -2, fill: "#66808b", fontSize: 9 }} />
            <YAxis domain={[0, 100]} stroke="#66808b" tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
            <Tooltip contentStyle={TIP} labelFormatter={(l) => `LOQ ${l} pg/mL`} formatter={(v, n) => [`${Number(v).toFixed(0)}%`, n]} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <ReferenceLine y={90} stroke="#5d7883" strokeDasharray="3 4" label={{ value: "90% target", position: "insideTopRight", fill: "#8aa8b2", fontSize: 9 }} />
            {loq !== null && loq <= max && <ReferenceLine x={loq} stroke="#f2bd72" label={{ value: "selected sensor", position: "top", fill: "#f2bd72", fontSize: 10 }} />}
            <Line dataKey="m30" name="30-min sampling" stroke="#58e2cc" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            <Line dataKey="m60" name="60-min sampling" stroke="#69baff" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {loq !== null && loq > max && <div className="chart-note">Selected sensor LOQ ({loq.toLocaleString(undefined, { maximumSignificantDigits: 3 })} pg/mL) is beyond this chart: no evening can be read.</div>}
      <div className="ref-row">{sens.references.map((r) => <span key={r.label}>{r.label}: <b>{r.loq.toLocaleString(undefined, { maximumSignificantDigits: 3 })} pg/mL</b></span>)}</div>
    </div>
  );
}

function SessionSlider({ sessions, idx, onChange }: { sessions: Mission["sessions"]; idx: number; onChange: (day: number) => void }) {
  return (
    <div className="session-slider">
      <label>ASSESS AS OF · <b>{sessions[idx]?.label}</b></label>
      <input type="range" min={0} max={sessions.length - 1} value={idx} onChange={(e) => onChange(sessions[Number(e.target.value)].day)} />
      <div className="timeline-labels"><span>{sessions[0]?.label}</span><span>{sessions[sessions.length - 1]?.label}</span></div>
    </div>
  );
}

function PlanTable({ rows, asOf, onPick }: { rows: Row[]; asOf: number | null; onPick: (day: number) => void }) {
  return (
    <div className="plan-table-wrap">
      <div className="chart-caption">EVERY SESSION · {rows[0]?.crew}</div>
      <table className="plan-table">
        <thead><tr><th>SESSION</th><th>STATUS</th><th>DLMO</th><th>OFFSET</th><th>PLAN</th><th>DOSE</th><th>NOTE</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day} className={r.day === asOf ? "on" : ""} onClick={() => onPick(r.day)}>
              <td>{r.label}</td>
              <td><span className={`status-pill ${(STATUS[r.level] ?? STATUS.unknown).cls}`}>{(STATUS[r.level] ?? STATUS.unknown).label}</span></td>
              <td>{r.dlmo ?? "—"}</td><td>{fmtOffset(r.offset_h)}</td><td>{r.plan.action}</td>
              <td className={r.plan.action === GIVE ? "dose-text" : ""}>{r.plan.dose_text}</td><td className="note">{r.plan.headline}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Metric({ icon, label, value, unit, note, accent }: { icon: React.ReactNode; label: string; value: string; unit?: string; note: string; accent?: boolean }) {
  return (
    <div className={`metric-card ${accent ? "metric-accent" : ""}`}>
      <div className="metric-top">{icon}<span>{label}</span></div>
      <div className="metric-value">{value}<small>{unit}</small></div>
      <div className="metric-note">{note}</div>
    </div>
  );
}

function PanelTitle({ number, title, tag }: { number: string; title: string; tag: string }) {
  return (
    <div className="panel-title">
      <div><span className="panel-number">{number}</span><strong>{title}</strong></div>
      <span>{tag}</span>
    </div>
  );
}

export default App;
