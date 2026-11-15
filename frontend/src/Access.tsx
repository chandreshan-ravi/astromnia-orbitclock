// Tester sign-in, feedback and about panels.
import { createContext, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CircleCheck, LogIn } from "lucide-react";

export type Session = { required: boolean; authed: boolean; role: string | null; tester: string | null };
const SessionCtx = createContext<{ session: Session; signOut: () => void } | null>(null);
export const useSession = () => useContext(SessionCtx)!;
export const VERSION = "Astromnia Analysis Software · tester build 1.1";

export function unauthorized() {
  window.dispatchEvent(new Event("oc-unauthorized"));
}

export function Gate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const check = () =>
    fetch("/api/session").then((r) => r.json()).then(setSession).catch(() => setErr("The OrbitClock server is not reachable. Try again in a minute."));
  useEffect(() => {
    check();
    const h = () => check();
    window.addEventListener("oc-unauthorized", h);
    return () => window.removeEventListener("oc-unauthorized", h);
  }, []);
  const signOut = () => fetch("/api/logout", { method: "POST" }).then(check);

  if (!session) return <div className="login-shell"><div className="login-card"><p>{err ?? "Connecting…"}</p></div></div>;
  if (session.required && !session.authed) return <Login onDone={setSession} />;
  return <SessionCtx.Provider value={{ session, signOut }}>{children}</SessionCtx.Provider>;
}

function Login({ onDone }: { onDone: (s: Session) => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, code, accepted }) })
      .then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.error); onDone(b); })
      .catch((e) => setErr(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand"><img src="/astromnia-logo.png" alt="" /><div><b>ASTROMNIA</b><span>ANALYSIS SOFTWARE · ORBITCLOCK ENGINE</span></div></div>
        <h1>Tester sign-in</h1>
        <p>OrbitClock measures saliva melatonin from DPV scans, estimates each crew member's body clock and suggests a melatonin plan.</p>
        <label className="lab-field">YOUR NAME OR TESTER ID<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="e.g. Tester 3" /></label>
        <label className="lab-field">ACCESS CODE<input type="password" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="current-password" /></label>
        <label className="login-check">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>I understand this is a <b>research prototype, not a medical device</b>. Melatonin plans are suggestions for flight-surgeon approval and must not be used for treatment. Data entered here is shared with all testers, so I will use crew codes, not real names.</span>
        </label>
        {err && <div className="notice error">{err}</div>}
        <button className="lab-button primary wide" disabled={busy || !name.trim() || !code || !accepted}><LogIn size={14} /> SIGN IN</button>
        <small className="login-foot">{VERSION} · AI-assisted software (Claude Code), see About</small>
      </form>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{title}</h2><button className="dosage-close" onClick={onClose}>×</button></div>
        {children}
      </div>
    </div>,
    document.body
  );
}

export function FeedbackModal({ page, onClose }: { page: string; onClose: () => void }) {
  const [kind, setKind] = useState("Bug");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [err, setErr] = useState<string | null>(null);
  const send = () => {
    setState("sending");
    fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, message, page }) })
      .then(async (r) => { if (r.status === 401) unauthorized(); const b = await r.json(); if (!r.ok) throw new Error(b.error); setState("sent"); })
      .catch((e) => { setErr(String(e.message ?? e)); setState("idle"); });
  };
  return (
    <Modal title="SEND FEEDBACK" onClose={onClose}>
      {state === "sent" ? (
        <div className="modal-body"><p className="lab-ok"><CircleCheck size={15} /> Thank you, your feedback was sent.</p>
          <button className="lab-button" onClick={onClose}>CLOSE</button></div>
      ) : (
        <div className="modal-body">
          <p className="lab-help">Page: <b>{page}</b>. Say what you did, what you expected and what happened.</p>
          <label className="lab-field">TYPE
            <select value={kind} onChange={(e) => setKind(e.target.value)}>{["Bug", "Confusing", "Suggestion", "Question", "Other"].map((k) => <option key={k}>{k}</option>)}</select>
          </label>
          <label className="lab-field">MESSAGE<textarea rows={6} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
          {err && <div className="notice error">{err}</div>}
          <div className="lab-actions"><button className="lab-button primary" disabled={!message.trim() || state === "sending"} onClick={send}>SEND</button></div>
        </div>
      )}
    </Modal>
  );
}

// Fill these in for the submission: each NASA resource used (from the challenge's Resources tab) and the
// origin of every third-party or AI-generated image/model. Sections appear in the app only when non-empty.
export const NASA_RESOURCES: { name: string; use: string; url?: string }[] = [
  {
    name: "NASA Human Research Program: Risk from Inadequate Sleep and Irregular Schedules",
    url: "https://www.nasa.gov/reference/risk-from-inadequate-sleep-and-irregular-schedules/",
    use: "The health risk OrbitClock addresses: irregular light-dark cycles (16 sunrises and sunsets a day on the space station) and sleep disruption. It is why the body clock is the indicator we monitor.",
  },
  {
    name: "NASA Human Research Roadmap: Risk of performance decrements and adverse health outcomes resulting from sleep loss, circadian desynchronization, and work overload",
    url: "https://humanresearchroadmap.nasa.gov/Risks/risk.aspx?i=100",
    use: "Formal risk description and evidence base behind the risk above.",
  },
  {
    name: "NASA Human Research Program: Risks of Human Spaceflight and 5 Hazards of Human Spaceflight",
    url: "https://www.nasa.gov/hrp/risks/",
    use: "Context for the hazards (isolation and confinement, distance from Earth, closed environments) that make crew self-assessment and flight-surgeon review necessary.",
  },
];
export const ASSET_CREDITS: { asset: string; credit: string }[] = [];

export function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="ABOUT, SOURCES & CREDITS" onClose={onClose}>
      <div className="modal-body about">
        <p><b>Astromnia</b> analysis software tracks astronauts' body clocks from saliva melatonin measured with a DPV aptasensor.</p>
        <ol>
          <li><b>Sample kit</b>: saliva is added to a buffer-filled tube up to the fill line, shaken for 1 minute and measured on a screen-printed carbon electrode (SPCE) with a portable potentiostat.</li>
          <li><b>Settings & calibration</b>: the sensor's calibration line, detection limits and saliva dilution.</li>
          <li><b>Results</b>: each DPV peak is converted to a saliva melatonin level with the calibration line, compared with the reference range and saved.</li>
          <li><b>Body clock</b>: each crew member's evening series gives the dim-light melatonin onset (DLMO), compared with their own pre-flight baseline.</li>
          <li><b>Melatonin dose</b>: if the clock runs at least 1 h late, 0.5 mg melatonin 4 h before the current DLMO (low-dose phase-advance protocol). Otherwise no dose, or re-sample first.</li>
        </ol>

        <h3>DATA SOURCES</h3>
        <ul>
          <li><b>Measured data</b>: the calibration standards and DPV saliva readings recorded by the team (marked "measured" in History).</li>
          <li><b>Simulated data</b>: the "Simulated mission" data source and any file marked SIMULATED are synthetic, generated by the OrbitClock simulator to test the engine.</li>
          <li><b>Live orbit data</b>: the ISS orbit (two-line elements published by CelesTrak from US Space Force tracking), refreshed every 6 h and propagated with SGP4 to show the station's real-time sunlight and orbital night ("Live ISS light-dark").</li>
          {NASA_RESOURCES.map((r) => <li key={r.name}><b>NASA</b>: {r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.name}</a> : r.name}. {r.use}</li>)}
        </ul>

        <h3>REFERENCES</h3>
        <ul>
          <li>Lewy AJ et al. (1998). The human phase response curve to melatonin is about 12 hours out of phase with the PRC to light. <i>Chronobiology International</i> 15(1):71–83.</li>
          <li>Burgess HJ et al. (2010). Human phase response curves to three days of daily melatonin: 0.5 mg versus 3.0 mg. <i>J Clin Endocrinol Metab</i> 95(7):3325–3331.</li>
          <li>Electrode detection limits used in the sensor comparison are published values listed in the project README.</li>
        </ul>

        {ASSET_CREDITS.length > 0 && <>
          <h3>IMAGE & MODEL CREDITS</h3>
          <ul>{ASSET_CREDITS.map((c) => <li key={c.asset}><b>{c.asset}</b>: {c.credit}</li>)}</ul>
        </>}

        <h3>AI DECLARATION</h3>
        <ul>
          <li><b>AI tool used</b>: Claude Code (Anthropic), an AI coding assistant. No other AI tools; no AI-generated images, video or audio.</li>
          <li><b>Made by the team without AI</b>: the DPV sensor work and lab measurements, the DPV result calculation (calibration, peak, LOD/LOQ, concentration), the mission simulation, the 3D brain, the ASTROMNIA interface design and logo.</li>
          <li><b>Developed with Claude Code</b>: the body-clock engine and melatonin plan rules (to the team's protocol), connecting the engine to the interface, the laboratory pages around the team's calculation, the Results screen, the live ISS light-dark page, the tester sign-in, tests and deployment. The team reviewed and tested all of it.</li>
          <li>Full declaration: <a href="https://github.com/chandreshan-ravi/astromnia-orbitclock/blob/main/AI_DECLARATION.md" target="_blank" rel="noreferrer">AI_DECLARATION.md</a>.</li>
        </ul>

        <p className="lab-help">Research prototype, not a medical device. Melatonin doses are suggestions for flight-surgeon approval and must not be used for treatment. Not affiliated with or endorsed by any space agency.</p>
        <p className="lab-help">{VERSION}</p>
      </div>
    </Modal>
  );
}
