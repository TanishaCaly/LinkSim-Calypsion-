"""
LinkSim — FastAPI application entry point.

Run with:
    uvicorn main:app --reload --port 8000
"""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# ── File logger (writes next to the DB so user can always find it) ──
_LOG_PATH = os.path.join(os.path.dirname(__file__), "linksim.log")
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)-8s %(name)s | %(message)s",
    handlers=[
        logging.FileHandler(_LOG_PATH, encoding="utf-8"),
        logging.StreamHandler(),          # also keep console output
    ],
)
logger = logging.getLogger("linksim")
logger.info(f"LinkSim starting — log file: {_LOG_PATH}")

from backend.storage.database import init_db
from backend.api.routes import (
    scenarios_router,
    simulations_router,
    upload_router,
    insights_router,
    debug_router,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create DB tables on startup (idempotent)
    init_db()
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

# Register routers
app.include_router(scenarios_router)
app.include_router(simulations_router)
app.include_router(upload_router)
app.include_router(insights_router)
app.include_router(debug_router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "linksim"}
