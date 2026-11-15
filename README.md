# Astromnia · OrbitClock

**Health monitoring software for astronauts: the body clock, measured from saliva.**
NASA Space Apps Challenge 2026 · *Create Health Monitoring Software for Astronauts on Space Missions*

Aboard the space station the crew sees about 16 sunrises and sunsets a day (NASA Human Research Program), so the light cue that sets the human body clock is scrambled. OrbitClock shows that problem live, measures its effect and suggests an action:

1. **Problem, live**: the real-time ISS orbit (CelesTrak TLE, SGP4) with sunlight / orbital night, a countdown to the next sunrise and the sunrises in the last 24 h.
2. **Measurement**: saliva melatonin from a DPV aptasensor (sample kit → screen-printed carbon electrode → portable potentiostat), quantified against the lab's calibration line.
3. **Assessment**: each crew member's dim-light melatonin onset (DLMO) compared with their own pre-flight baseline.
4. **Action**: when the clock runs ≥ 1 h late, 0.5 mg melatonin 4 h before DLMO plus light timing, for flight-surgeon approval.

React + TypeScript front end (`frontend/`) and a Python engine and API (`backend/`), served together by `backend/server.py`.

> Research prototype, not a medical device. Melatonin plans are suggestions for flight-surgeon approval. Not affiliated with or endorsed by NASA or any space agency.

**Live app:** _(add the deployed link)_

[![CI](https://github.com/chandreshan-ravi/astromnia-orbitclock/actions/workflows/ci.yml/badge.svg)](https://github.com/chandreshan-ravi/astromnia-orbitclock/actions/workflows/ci.yml)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/chandreshan-ravi/astromnia-orbitclock)

## Features

| Page | Who | What |
|---|---|---|
| Live ISS light-dark | everyone | real-time ISS position, sunlight or orbital night, next sunrise/sunset, sunrises in the last 24 h, 24-hour light strip, and the simulated crew's body-clock drift |
| Results | everyone | sample-kit protocol (tube with buffer → saliva to the fill line → shake 1 min → SPCE + portable potentiostat), upload a DPV scan → peak → saliva melatonin level, reference range and the crew member's melatonin dose → save the reading |
| History / Trends | everyone views; testers delete only their own readings, the coordinator any | all readings with CSV download / saliva melatonin over time |
| Settings | everyone views, coordinator edits | calibration line, LOD/LOQ, saliva dilution, launch date, reference range |
| Mission overview, Crew monitoring, Biological clock, Melatonin laboratory | everyone | body clock and melatonin plan per crew member, from the simulated mission or the saved records |
| Sensor laboratory | everyone | re-run the simulated mission with another sensor, sampling interval or seed |
| Send feedback | everyone | stored on the server; the coordinator downloads it from the sidebar |
| About, sources & credits | everyone | method, data sources, references, use of AI |

## Submission compliance (Space Apps / Sarawak Space Challenge)

- No NASA logos, flags or mission identifiers anywhere in the app (the NASA logo background and an unused astronaut model were removed).
- Challenge: *Create Health Monitoring Software for Astronauts on Space Missions* (Space Apps 2026). NASA resources used, from the challenge's Resources tab: NASA Human Research Program, Risk from Inadequate Sleep and Irregular Schedules (and its Human Research Roadmap entry), and Risks / 5 Hazards of Human Spaceflight. They are shown on **Results** ("Why monitor the body clock") and in **About, sources & credits**; edit them in `frontend/src/Access.tsx` (`NASA_RESOURCES`). Image/model credits go in `ASSET_CREDITS` in the same file.
- Use of AI is stated in the app (About panel, sign-in screen, sidebar).
- Judges need the deployed link (see below), not the GitHub repository.

Everyone shares one dataset. On the first start the server copies `backend/seed_data/` (the calibration and readings collected so far) into its data folder; after that it never overwrites it.

## Publish from this computer

Needs the GitHub CLI (`gh`) signed in once (`gh auth login --web`). From this folder:

    git add -A && git commit -m "Describe the change"
    git push                                                           # afterwards

Every push runs the tests and the front-end build on GitHub Actions (`.github/workflows/ci.yml`) and, once Render is connected, redeploys the live app.

## Put it online (Render)

1. The code is on GitHub: https://github.com/chandreshan-ravi/astromnia-orbitclock (push changes as described below).
2. Click **Deploy to Render** at the top of this README (or on render.com: **New → Blueprint**, pick the repository). `render.yaml` creates one web service from the `Dockerfile` with a 1 GB persistent disk at `/var/data`.
3. When asked, set:
   - `ACCESS_CODE`: the code you give testers
   - `ADMIN_CODE`: your own coordinator code, kept private
   - `SESSION_SECRET` is generated automatically.
4. Deploy. When `/api/health` answers `ok`, send testers the `https://….onrender.com` link and the access code (see `TESTERS.md`).

The disk needs a paid instance (Render "Starter"). On a free instance every restart or deploy would erase saved readings and feedback.

Any other Docker host works the same way: build the `Dockerfile`, mount a persistent volume at `/var/data`, and set the three variables. The container listens on `$PORT` (default 10000).

## Run on this computer

    cd backend
    .venv/bin/python server.py          # http://127.0.0.1:8510  (no sign-in when ACCESS_CODE is unset)

Front-end development with live reload (needs the server above running):

    cd frontend
    PATH="$PWD/../../.node/bin:$PATH" npm run dev     # http://127.0.0.1:5180

After changing the front end, run `npm run build` so `server.py` serves the new version.

First-time setup of the Python environment: `python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements-dev.txt`.
Tests: `cd backend && .venv/bin/python -m pytest -q tests`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ACCESS_CODE` | unset | tester code; when neither code is set, nobody needs to sign in |
| `ADMIN_CODE` | unset | coordinator code: edit Setup, delete any reading, download feedback |
| `SESSION_SECRET` | — | required when a code is set; signs the 30-day sign-in cookie |
| `ORBITCLOCK_DATA_DIR` | `backend/data` (`/var/data` in Docker) | calibration, settings, readings, feedback |
| `PORT` / `HOST` | 8510 / 127.0.0.1 (10000 / 0.0.0.0 in Docker) | where the server listens |

## Melatonin plan rules

0.5 mg melatonin once daily, 4 h before the current estimated DLMO (window 3–5 h before), only when the clock runs at least 1 h later than the crew member's own pre-flight baseline (≥ 2 h = high priority). No dose when the clock is early, within ±1 h, or cannot be read (re-sample first). Each crew member needs at least two pre-flight evening series for a baseline. Basis: low-dose phase-advance protocols (Lewy et al. 1998; Burgess et al. 2010).
