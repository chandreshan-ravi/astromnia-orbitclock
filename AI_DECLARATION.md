# AI use declaration

**Project:** Astromnia · OrbitClock, NASA Space Apps Challenge 2026: *Create Health Monitoring Software for Astronauts on Space Missions*
**Live app:** https://astromnia-melatonin.onrender.com/
**AI tool used:** Claude Code (Anthropic), an AI coding assistant, running the Claude Opus model. No other AI tools were used.
**AI-generated images, video or audio:** none. Claude Code writes code and text only.

## Made by the team without AI

| Part | Where it is |
|---|---|
| Concept, sensor work and lab measurements: the DPV aptasensor, the sample kit, the calibration standards and the saliva DPV scans | `backend/seed_data/`, `backend/sample_data/` |
| DPV result calculation: calibration fit, peak detection and baseline, LOD/LOQ, concentration, saliva dilution correction | `backend/orbitclock/analysis.py` |
| Mission simulation: the synthetic crew, mission phases and melatonin/cortisol data used to test the engine | `backend/orbitclock/simulator.py` |
| 3D brain: model and its interactive viewer | `frontend/public/models/Brain.glb`, `frontend/src/BrainModel.tsx` |
| ASTROMNIA interface design: layout, sidebar, mission pages and styling of the original front end | `frontend/src/App.tsx`, `frontend/src/App.css` (original version) |
| Astromnia logo | `frontend/public/astromnia-logo.png` |
| Earlier OrbitClock versions (Streamlit app, versions 1–5) | not in this repository |
| Requirements, design decisions, review and testing of everything below | — |

## Developed with Claude Code assistance

The team set the requirements and made the decisions. Claude Code wrote or changed the code, and the team reviewed and tested the results in the running app.

| Part | What Claude Code did |
|---|---|
| Body-clock engine | DLMO estimation, comparison with each crew member's pre-flight baseline, and the 0.5 mg melatonin plan rules, following the team's chosen protocol and published references (`backend/orbitclock/engine.py`, `countermeasure.py`, `records_bridge.py`, `sensitivity.py`) |
| Integration | Connected the OrbitClock engine to the ASTROMNIA interface: data API, dosage panel, charts and data-source switch (`backend/api.py`, `frontend/src/api.ts`, additions to `App.tsx`) |
| Laboratory pages | Web pages and API around the team's DPV calculation: Settings (calibration), Results, History and Trends, saving readings (`frontend/src/Lab.tsx`, `backend/orbitclock/lab_api.py`, `store.py`) |
| Results screen | Sample kit protocol with 1-minute timer, melatonin level, reference-range and melatonin-dose cards, built from the team's mock-ups |
| Live ISS light-dark page | ISS orbit from public TLE data (SGP4), sunlight or orbital night, sunrise count and 24-hour light strip (`backend/orbitclock/orbit.py`, `frontend/src/Orbit.tsx`) |
| Tester build | Sign-in with tester and coordinator codes, shared dataset, feedback, about/credits panel (`backend/server.py`, `frontend/src/Access.tsx`) |
| Submission compliance | Removed NASA logos; added the NASA Human Research Program sources, credits and this declaration |
| Testing and deployment | Automated tests, GitHub Actions CI, Dockerfile, Render configuration, README and tester guide |

Commits that Claude Code helped write are marked `Co-Authored-By: Claude` in the git history.

## Responsibility

The team is responsible for the scientific content, the measurements and how the results are used. OrbitClock is a research prototype, not a medical device. Melatonin plans are suggestions for flight-surgeon approval.
