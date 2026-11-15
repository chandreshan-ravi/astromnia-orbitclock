"""OrbitClock production server: the built ASTROMNIA front end + the OrbitClock API in one process.

Environment variables
  PORT                  port to listen on (default 8510)
  ORBITCLOCK_DATA_DIR   folder for calibration, settings, readings and feedback (default backend/data).
                        On a host, point this at a persistent disk.
  ACCESS_CODE           code testers enter to sign in. If unset, no sign-in is required (local use only).
  ADMIN_CODE            code for the study coordinator: can change Setup, delete any reading, download feedback.
  SESSION_SECRET        random string used to sign session cookies (required when ACCESS_CODE is set).
  FRONTEND_DIST         built front end (default ../frontend/dist)

Run locally:   .venv/bin/python server.py
"""
from __future__ import annotations

import csv
import hmac
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from itsdangerous import BadSignature, URLSafeTimedSerializer
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

HERE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("ORBITCLOCK_DATA_DIR", HERE / "data"))
SEED_DIR = HERE / "seed_data"
DIST = Path(os.environ.get("FRONTEND_DIST", HERE.parent / "frontend" / "dist"))
ACCESS_CODE = os.environ.get("ACCESS_CODE", "").strip()
ADMIN_CODE = os.environ.get("ADMIN_CODE", "").strip()
SECRET = os.environ.get("SESSION_SECRET", "").strip()
COOKIE = "oc_session"
MAX_AGE = 30 * 24 * 3600
AUTH_REQUIRED = bool(ACCESS_CODE or ADMIN_CODE)
if AUTH_REQUIRED and not SECRET:
    raise SystemExit("SESSION_SECRET must be set when ACCESS_CODE or ADMIN_CODE is set.")

# ----------------------------------------------------------------------------- data folder (seed on first run)
DATA_DIR.mkdir(parents=True, exist_ok=True)
if not (DATA_DIR / "readings.csv").exists() and not (DATA_DIR / "settings.json").exists() and SEED_DIR.exists():
    for f in SEED_DIR.iterdir():
        if f.is_file():
            shutil.copy2(f, DATA_DIR / f.name)

from orbitclock import store  # noqa: E402

store.DATA_DIR = DATA_DIR
import api  # noqa: E402  (routes for options / mission / sensitivity / setup / measure / records)

signer = URLSafeTimedSerializer(SECRET or "local-dev", salt="orbitclock-session")


def session_of(scope) -> dict | None:
    if not AUTH_REQUIRED:
        return {"role": "admin", "tester": "Local user"}
    raw = Request(scope).cookies.get(COOKIE)
    if not raw:
        return None
    try:
        return signer.loads(raw, max_age=MAX_AGE)
    except BadSignature:
        return None


PUBLIC = {"/api/session", "/api/login", "/api/logout", "/api/health"}
ADMIN_ONLY = {("POST", "/api/setup/calibration"), ("DELETE", "/api/setup/calibration"),
              ("POST", "/api/setup/calibration/example"), ("POST", "/api/setup/settings"),
              ("GET", "/api/feedback.csv")}


class AuthMiddleware:
    """Every /api/* call except the public ones needs a valid session; some need the admin role."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"].startswith("/api/") and scope["path"] not in PUBLIC:
            sess = session_of(scope)
            if sess is None:
                return await JSONResponse({"error": "Sign in required."}, status_code=401)(scope, receive, send)
            if (scope["method"], scope["path"]) in ADMIN_ONLY and sess.get("role") != "admin":
                return await JSONResponse({"error": "Only the study coordinator can change this."},
                                          status_code=403)(scope, receive, send)
            scope.setdefault("state", {})
            scope["state"]["tester"] = sess.get("tester") or "tester"
            scope["state"]["role"] = sess.get("role", "tester")
        await self.app(scope, receive, send)


# ----------------------------------------------------------------------------- session routes
_fails: dict[str, list[float]] = {}


async def session(request):
    sess = session_of(request.scope)
    return JSONResponse(dict(required=AUTH_REQUIRED, authed=sess is not None,
                             role=(sess or {}).get("role"), tester=(sess or {}).get("tester")))


async def login(request):
    ip = request.client.host if request.client else "?"
    now = time.time()
    recent = [t for t in _fails.get(ip, []) if now - t < 600]
    if len(recent) >= 8:
        return JSONResponse({"error": "Too many attempts. Try again in 10 minutes."}, status_code=429)
    body = await request.json()
    code = str(body.get("code", "")).strip()
    tester = str(body.get("name", "")).strip()[:60]
    if not tester:
        return JSONResponse({"error": "Enter your name or tester ID."}, status_code=400)
    if not body.get("accepted"):
        return JSONResponse({"error": "Please confirm the research-prototype notice."}, status_code=400)
    role = None
    if ADMIN_CODE and hmac.compare_digest(code, ADMIN_CODE):
        role = "admin"
    elif ACCESS_CODE and hmac.compare_digest(code, ACCESS_CODE):
        role = "tester"
    if role is None:
        _fails[ip] = recent + [now]
        return JSONResponse({"error": "That access code is not right."}, status_code=401)
    _fails.pop(ip, None)
    resp = JSONResponse(dict(required=True, authed=True, role=role, tester=tester))
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(COOKIE, signer.dumps({"role": role, "tester": tester}), max_age=MAX_AGE, httponly=True,
                    samesite="lax", secure=secure)
    return resp


async def logout(request):
    resp = JSONResponse(dict(required=AUTH_REQUIRED, authed=False))
    resp.delete_cookie(COOKIE)
    return resp


async def health(request):
    return PlainTextResponse("ok")


# ----------------------------------------------------------------------------- tester feedback
FEEDBACK_COLS = ["submitted_at", "tester", "role", "page", "kind", "message", "user_agent"]


async def feedback(request):
    body = await request.json()
    msg = str(body.get("message", "")).strip()
    if not msg:
        return JSONResponse({"error": "Write a message first."}, status_code=400)
    f = DATA_DIR / "feedback.csv"
    new = not f.exists()
    with f.open("a", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, FEEDBACK_COLS)
        if new:
            w.writeheader()
        w.writerow(dict(submitted_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        tester=request.state.tester, role=request.state.role, page=str(body.get("page", ""))[:80],
                        kind=str(body.get("kind", ""))[:40], message=msg[:5000],
                        user_agent=request.headers.get("user-agent", "")[:200]))
    return JSONResponse({"ok": True})


async def feedback_csv(request):
    f = DATA_DIR / "feedback.csv"
    text = f.read_text(encoding="utf-8") if f.exists() else ",".join(FEEDBACK_COLS) + "\n"
    return Response(text, media_type="text/csv",
                    headers={"Content-Disposition": "attachment; filename=orbitclock_feedback.csv"})


# ----------------------------------------------------------------------------- app
routes = [
    Route("/api/session", session), Route("/api/login", login, methods=["POST"]),
    Route("/api/logout", logout, methods=["POST"]), Route("/api/health", health),
    Route("/api/feedback", feedback, methods=["POST"]), Route("/api/feedback.csv", feedback_csv),
    *api.app.router.routes,
]
if DIST.exists():
    routes.append(Mount("/", StaticFiles(directory=DIST, html=True), name="frontend"))
else:
    routes.append(Route("/", lambda r: PlainTextResponse(f"Front end not built. Run `npm run build` in {DIST.parent}.")))

app = Starlette(routes=routes)
app.add_middleware(AuthMiddleware)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 8510)),
                log_level="warning", proxy_headers=True, forwarded_allow_ips="*")
