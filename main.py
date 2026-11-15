"""
LinkSim — FastAPI application entry point.

Run with:
    uvicorn main:app --reload --port 8000
"""
import logging
import os
import threading
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# ── File logger (writes next to the DB so user can always find it) ──
# LINKSIM_DATA_DIR is set by the tester build (desktop_launcher.py); in
# development the log stays next to this file.
_LOG_PATH = os.path.join(os.environ.get("LINKSIM_DATA_DIR") or os.path.dirname(__file__), "linksim.log")
# Tester build: INFO to the file only, and just warnings/errors in the console
# window (printing every engine line there slows runs down).
_DESKTOP = os.environ.get("LINKSIM_DESKTOP") == "1"
_console = logging.StreamHandler()          # also keep console output
if _DESKTOP:
    _console.setLevel(logging.WARNING)
logging.basicConfig(
    level=logging.INFO if _DESKTOP else logging.DEBUG,
    format="%(asctime)s %(levelname)-8s %(name)s | %(message)s",
    handlers=[
        # Tester build: keep the log from growing without limit (20 MB x 3).
        RotatingFileHandler(_LOG_PATH, maxBytes=20_000_000, backupCount=2, encoding="utf-8")
        if _DESKTOP else logging.FileHandler(_LOG_PATH, encoding="utf-8"),
        _console,
    ],
)
logger = logging.getLogger("linksim")
logger.info(f"LinkSim starting — log file: {_LOG_PATH}")

from fastapi import Depends

from backend.storage.crud import fail_unfinished_runs
from backend.storage.database import SessionLocal, init_db
from backend.api.auth import router as auth_router, require_auth
from backend.api.routes import (
    scenarios_router,
    simulations_router,
    upload_router,
    insights_router,
    debug_router,
    license_router,
    require_license,
)
from backend.licensing import ENABLED as LICENSE_ENABLED, manager as license_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create DB tables on startup (idempotent)
    init_db()
    # Runs cut off when the server last stopped can never finish now.
    with SessionLocal() as db:
        n = fail_unfinished_runs(db)
    if n:
        logger.info(f"Marked {n} unfinished run(s) from before the restart as failed")
    # Desktop build: check the license in the background (it may wait on the
    # network); the activation page waits for the result.
    if LICENSE_ENABLED:
        threading.Thread(target=license_manager.refresh, daemon=True).start()
    yield


app = FastAPI(
    title="LinkSim API",
    description="Manufacturing Discrete Event Simulation — REST backend",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS: a wildcard origin combined with allow_credentials=True is rejected by
# browsers (and invalid per the CORS spec). Allow the local dev front-ends by
# explicit origin/regex and keep credentials working. Override via the
# LINKSIM_CORS_ORIGINS env var (comma-separated) for other deployments.
_default_origins = [
    "http://localhost:5173", "http://127.0.0.1:5173",   # Vite dev server
    "http://localhost:3000", "http://127.0.0.1:3000",
    "http://localhost:8000", "http://127.0.0.1:8000",
]
_cors_origins = [
    o.strip() for o in os.environ.get("LINKSIM_CORS_ORIGINS", "").split(",") if o.strip()
] or _default_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# License routes are open (the activation page runs before anything else).
# Everything else needs a valid license first (desktop build only, see
# backend/licensing.py); auth routes are open past that so you can log in,
# every other router also requires a valid session token.
app.include_router(license_router)
app.include_router(auth_router, dependencies=[Depends(require_license)])

_auth_dep = [Depends(require_license), Depends(require_auth)]
app.include_router(scenarios_router, dependencies=_auth_dep)
app.include_router(simulations_router, dependencies=_auth_dep)
app.include_router(upload_router, dependencies=_auth_dep)
app.include_router(insights_router, dependencies=_auth_dep)
app.include_router(debug_router, dependencies=_auth_dep)


@app.get("/health")
def health():
    return {"status": "ok", "service": "linksim"}


# Tester build: serve the built web page (frontend/dist) from this server too,
# so one program runs everything. LINKSIM_STATIC_DIR is set only by
# desktop_launcher.py; in development Vite serves the page.
_STATIC_DIR = os.environ.get("LINKSIM_STATIC_DIR")
if _STATIC_DIR and os.path.isdir(_STATIC_DIR):
    import mimetypes

    from fastapi import HTTPException
    from fastapi.responses import FileResponse

    # Python takes file types from the Windows registry, where some PCs list
    # .js as text/plain — the browser then refuses the page's script (blank
    # page) — and knows no type at all for fonts and 3D models. Set the types
    # the page needs explicitly.
    for _type, _ext in (("text/javascript", ".js"), ("text/css", ".css"), ("text/html", ".html"),
                        ("image/svg+xml", ".svg"), ("application/json", ".json"),
                        ("font/woff2", ".woff2"), ("font/woff", ".woff"), ("model/gltf-binary", ".glb"),
                        ("image/png", ".png"), ("image/jpeg", ".jpg")):
        mimetypes.add_type(_type, _ext)

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        root = os.path.realpath(_STATIC_DIR)
        file = os.path.realpath(os.path.join(root, path))
        if path and file.startswith(root + os.sep) and os.path.isfile(file):
            return FileResponse(file)
        # Page routes (/canvas, /run, ...) are handled by the React router.
        return FileResponse(os.path.join(root, "index.html"))
