// Live orbital light-dark cycle of the ISS (backend/orbitclock/orbit.py) and why it matters for the body clock.
import { useEffect, useMemo, useState } from "react";
import { Moon, Satellite, Sun, Sunrise } from "lucide-react";
import { unauthorized } from "./Access";

type Orbit = {
  now: number; source: string; tle_epoch: number; sunlit: boolean; lat: number; lon: number; alt_km: number; period_min: number;
  sunrises_24h: number; sunsets_24h: number; next_event: { t: number; kind: string } | null;
  events: { t: number; kind: string }[]; segments: { start: number; end: number; sunlit: boolean }[];
  track: { t: number; lat: number; lon: number; sunlit: boolean }[]; subsolar: { lat: number; lon: number };
};

const W = 720, H = 360;
const px = (lon: number) => ((lon + 180) / 360) * W;
const py = (lat: number) => ((90 - lat) / 180) * H;
const SLEEP = { from: 21.5, to: 6 }; // assumed crew sleep, station time (GMT)

function hhmm(t: number) {
  const d = new Date(t * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
function mmss(s: number) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Night-side polygon (equirectangular) from the subsolar point. */
function nightPath(sub: { lat: number; lon: number }) {
  const dec = (sub.lat * Math.PI) / 180;
  const t = Math.abs(Math.tan(dec)) < 1e-4 ? 1e-4 * Math.sign(dec || 1) : Math.tan(dec);
  const pts: string[] = [];
  for (let lon = -180; lon <= 180; lon += 3) {
    const d = ((lon - sub.lon) * Math.PI) / 180;
    const lat = (Math.atan(-Math.cos(d) / t) * 180) / Math.PI;
    pts.push(`${px(lon).toFixed(1)},${py(lat).toFixed(1)}`);
  }
  const pole = sub.lat < 0 ? 0 : H;
  return `M0,${pole} L${pts.join(" L")} L${W},${pole} Z`;
}

export function OrbitPage({ children, nGive, onOpenMission }: { children?: React.ReactNode; nGive: number | null; onOpenMission: () => void }) {
  const [o, setO] = useState<Orbit | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now() / 1000);

  useEffect(() => {
    const load = () =>
      fetch("/api/orbit").then(async (r) => {
        if (r.status === 401) unauthorized();
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setO(await r.json()); setErr(null);
      }).catch((e) => setErr(String(e.message ?? e)));
    load();
    const a = window.setInterval(load, 60_000);
    const b = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => { window.clearInterval(a); window.clearInterval(b); };
  }, []);

  const live = useMemo(() => {
    if (!o) return null;
    const seg = o.segments.find((s) => s.start <= now && now < s.end);
    const next = o.events.find((e) => e.t > now) ?? null;
    const tr = o.track;
    let pos = { lat: o.lat, lon: o.lon };
    for (let i = 1; i < tr.length; i++) {
      if (tr[i].t >= now) {
        const a = tr[i - 1], b = tr[i], f = (now - a.t) / (b.t - a.t);
        const dl = Math.abs(b.lon - a.lon) > 180 ? 0 : f; // do not interpolate across the date line
        pos = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * dl };
        break;
      }
    }
    return { sunlit: seg?.sunlit ?? o.sunlit, next, pos };
  }, [o, now]);

  if (!o || !live) return <div className="notice subtle">{err ? `Orbit data not available (${err}).` : "Loading the live ISS orbit…"}</div>;

  // ground track split into same-colour runs, broken at the date line
  const runs: { sunlit: boolean; pts: string }[] = [];
  let cur: { sunlit: boolean; pts: string[] } | null = null;
  o.track.forEach((p, i) => {
    const prev = o.track[i - 1];
    const jump = prev && Math.abs(p.lon - prev.lon) > 180;
    if (!cur || cur.sunlit !== p.sunlit || jump) {
      if (cur) runs.push({ sunlit: cur.sunlit, pts: cur.pts.join(" ") });
      cur = { sunlit: p.sunlit, pts: jump || !prev ? [] : [`${px(prev.lon)},${py(prev.lat)}`] };
    }
    cur.pts.push(`${px(p.lon).toFixed(1)},${py(p.lat).toFixed(1)}`);
  });
  if (cur) runs.push({ sunlit: (cur as { sunlit: boolean }).sunlit, pts: (cur as { pts: string[] }).pts.join(" ") });

  const lo = o.now - 12 * 3600, span = 24 * 3600;
  const x = (t: number) => `${(((t - lo) / span) * 100).toFixed(3)}%`;
  const w = (a: number, b: number) => `${(((b - a) / span) * 100).toFixed(3)}%`;
  const hours: number[] = [];
  for (let t = Math.ceil(lo / 10800) * 10800; t < lo + span; t += 10800) hours.push(t);
  const sleeps: { a: number; b: number }[] = [];
  const day0 = Math.floor(lo / 86400) * 86400;
  for (let d = day0 - 86400; d < lo + span + 86400; d += 86400) {
    const a = Math.max(lo, d + SLEEP.from * 3600), b = Math.min(lo + span, d + 86400 + SLEEP.to * 3600);
    if (b > a) sleeps.push({ a, b });
  }
  const sunrisesNext12 = o.events.filter((e) => e.kind === "sunrise" && e.t > now).length;

  return (
    <>
      <section className="metric-grid">
        <div className={`metric-card ${live.sunlit ? "metric-accent" : "metric-night"}`}>
          <div className="metric-top">{live.sunlit ? <Sun /> : <Moon />}<span>ISS RIGHT NOW · LIVE</span></div>
          <div className="metric-value">{live.sunlit ? "SUNLIGHT" : "ORBITAL NIGHT"}</div>
          <div className="metric-note">{live.pos.lat.toFixed(1)}°, {live.pos.lon.toFixed(1)}° · {o.alt_km.toFixed(0)} km altitude</div>
        </div>
        <div className="metric-card">
          <div className="metric-top"><Sunrise /><span>NEXT {live.next?.kind.toUpperCase() ?? "CHANGE"} IN</span></div>
          <div className="metric-value">{live.next ? mmss(live.next.t - now) : "—"}</div>
          <div className="metric-note">{live.next ? `at ${hhmm(live.next.t)} GMT (station time)` : ""}</div>
        </div>
        <div className="metric-card">
          <div className="metric-top"><Sun /><span>SUNRISES IN THE LAST 24 H</span></div>
          <div className="metric-value">{o.sunrises_24h}<small>on Earth: 1</small></div>
          <div className="metric-note">NASA HRP: about 16 sunrises and sunsets a day</div>
        </div>
        <div className="metric-card">
          <div className="metric-top"><Satellite /><span>ONE ORBIT</span></div>
          <div className="metric-value">{o.period_min.toFixed(1)}<small>min</small></div>
          <div className="metric-note">{sunrisesNext12} more sunrises in the next 12 h</div>
        </div>
      </section>

      <section className="panel full-panel lab-panel">
        <div className="panel-title"><div><span className="panel-number">O1</span><strong>LIVE ISS GROUND TRACK</strong></div><span>ONE ORBIT BACK AND AHEAD · YELLOW = SUNLIT · BLUE = EARTH'S SHADOW</span></div>
        <div className="lab-body">
          <svg className="orbit-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="ISS ground track with day and night">
            <rect width={W} height={H} fill="#16465c" />
            <path d={nightPath(o.subsolar)} fill="#030b12" opacity={0.82} />
            {[-60, -30, 0, 30, 60].map((l) => <line key={`a${l}`} x1={0} x2={W} y1={py(l)} y2={py(l)} stroke="#1b3542" strokeWidth={l === 0 ? 1.2 : 0.6} />)}
            {[-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map((l) => <line key={`o${l}`} y1={0} y2={H} x1={px(l)} x2={px(l)} stroke="#1b3542" strokeWidth={0.6} />)}
            {runs.map((r, i) => <polyline key={i} points={r.pts} fill="none" stroke={r.sunlit ? "#f2d36b" : "#5b8cff"} strokeWidth={2.2} strokeLinecap="round" />)}
            <circle cx={px(o.subsolar.lon)} cy={py(o.subsolar.lat)} r={9} fill="#ffd34d" opacity={0.9} />
            <circle cx={px(o.subsolar.lon)} cy={py(o.subsolar.lat)} r={16} fill="none" stroke="#ffd34d" opacity={0.35} />
            <circle className="iss-pulse" cx={px(live.pos.lon)} cy={py(live.pos.lat)} r={10} fill="none" stroke={live.sunlit ? "#f2d36b" : "#8fb3ff"} />
            <circle cx={px(live.pos.lon)} cy={py(live.pos.lat)} r={5} fill="#ffffff" />
            <text x={px(live.pos.lon) + 9} y={py(live.pos.lat) - 9} fill="#ffffff" fontSize={11} fontWeight={700}>ISS</text>
          </svg>
          <p className="lab-help">Grid lines every 30° of latitude and longitude. The dark area is the night side of Earth; the yellow disc is the point under the Sun.</p>
        </div>
      </section>

      <section className="panel full-panel lab-panel">
        <div className="panel-title"><div><span className="panel-number">O2</span><strong>24-HOUR LIGHT-DARK CYCLE</strong></div><span>12 H BACK · NOW · 12 H AHEAD · GMT</span></div>
        <div className="lab-body">
          <div className="lightstrip">
            <div className="ls-row"><span>WINDOW LIGHT ON THE ISS</span>
              <div className="ls-bar">{o.segments.map((s, i) => <i key={i} className={s.sunlit ? "day" : "night"} style={{ left: x(s.start), width: w(s.start, s.end) }} />)}<b className="ls-now" style={{ left: x(now) }} /></div></div>
            <div className="ls-row"><span>CREW SLEEP (ASSUMED 21:30–06:00)</span>
              <div className="ls-bar">{sleeps.map((s, i) => <i key={i} className="sleep" style={{ left: x(s.a), width: w(s.a, s.b) }} />)}<b className="ls-now" style={{ left: x(now) }} /></div></div>
            <div className="ls-row"><span>WHAT THE BODY CLOCK EXPECTS</span>
              <div className="ls-bar earth">{sleeps.map((s, i) => <i key={i} className="night" style={{ left: x(s.a), width: w(s.a, s.b) }} />)}<b className="ls-now" style={{ left: x(now) }} /></div></div>
            <div className="ls-axis">{hours.map((t) => <span key={t} style={{ left: x(t) }}>{hhmm(t)}</span>)}</div>
          </div>
          <p className="lab-help">The window light switches about every 46 minutes, so it carries no 24-hour signal. The body clock then depends on the cabin lighting schedule and daily routine. When those cues are weak, the clock drifts, which NASA's Human Research Program lists as a risk (circadian desynchronization).</p>
        </div>
      </section>

      <section className="panel full-panel lab-panel">
        <div className="panel-title"><div><span className="panel-number">O3</span><strong>WHAT ORBITCLOCK SOLVES</strong></div><span>PROBLEM → MEASUREMENT → ACTION</span></div>
        <div className="lab-body">
          <div className="why-grid">
            <div><b>1 · Problem</b><span>{o.sunrises_24h} sunrises in the last 24 h: the light cue that sets the body clock is scrambled in orbit.</span></div>
            <div><b>2 · Measurement</b><span>Evening saliva melatonin (DPV aptasensor) gives each crew member's DLMO, compared with their own pre-flight baseline.</span></div>
            <div><b>3 · Action</b><span>{nGive === null ? "When the clock runs at least 1 h late, " : nGive > 0 ? `${nGive} simulated crew member(s) currently need melatonin: ` : "No simulated crew member currently needs melatonin; when a clock runs at least 1 h late, "}0.5 mg melatonin 4 h before DLMO plus light timing, for flight-surgeon approval.</span></div>
          </div>
          {children}
          <div className="lab-actions"><button className="lab-button primary" onClick={onOpenMission}>OPEN MISSION OVERVIEW</button></div>
          <p className="lab-meta">Orbit: {o.source}, epoch {new Date(o.tle_epoch * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC, propagated with SGP4; Sun position from the Astronomical Almanac low-precision formula; Earth's shadow as a cylinder (sunrise/sunset times to about a minute). Updates every minute.</p>
        </div>
      </section>
    </>
  );
}
