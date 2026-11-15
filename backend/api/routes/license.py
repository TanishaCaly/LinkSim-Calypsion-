"""
License routes for the desktop build (see backend/licensing.py).

Open routes: they are what the activation page uses before LinkSim is
unlocked. The server only listens on 127.0.0.1 in the desktop build.
"""
import asyncio
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from backend import licensing as lic
from backend.engine.sim_core import (
    STATION_TYPE_CONNECTOR, STATION_TYPE_DRAIN, STATION_TYPE_SOURCE,
    STATION_TYPE_WORKER, STATION_TYPE_WORKER_CONTROLLER, STATION_TYPE_WORKPLACE,
)
from backend.licensing import ENABLED, LicenseError, manager

router = APIRouter(prefix="/api/license", tags=["license"])


class KeyRequest(BaseModel):
    key: str


class LicenseFileRequest(BaseModel):
    license_file: str


def _fail(err: LicenseError):
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"reason": err.reason, "msg": str(err)})


def require_license() -> None:
    """FastAPI dependency — 403 "License required" until this PC has a valid
    license. Runs before require_auth, so the page goes to activation first."""
    if not ENABLED:
        return
    manager.ensure_valid()
    if not manager.ok:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="License required")


@router.get("/status")
async def license_status():
    # Right after start the first check may still be talking to the server.
    if ENABLED:
        await asyncio.to_thread(manager.wait_ready)
        manager.ensure_valid()
    return manager.status()


@router.post("/activate")
async def activate(payload: KeyRequest):
    if not payload.key.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Enter a license key")
    try:
        await asyncio.to_thread(manager.activate, payload.key)
    except LicenseError as e:
        _fail(e)
    return manager.status()


@router.post("/refresh")
async def refresh():
    """The activation page's Retry button."""
    await asyncio.to_thread(manager.refresh)
    return manager.status()


@router.post("/deactivate")
async def deactivate():
    try:
        await asyncio.to_thread(manager.deactivate)
    except LicenseError as e:
        _fail(e)
    return manager.status()


@router.post("/offline-request")
def offline_request(payload: KeyRequest):
    if not payload.key.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Enter a license key")
    return {"request": manager.offline_request(payload.key)}


@router.post("/offline-license")
def offline_license(payload: LicenseFileRequest):
    try:
        manager.import_license_file(payload.license_file)
    except LicenseError as e:
        _fail(e)
    return manager.status()


# ── Feature checks, used by the other routes ──

_FEATURE_MESSAGES = {
    lic.SIM_RUN: "Running simulations is not included in your LinkSim license.",
    lic.IMPORT_FILES: "Importing files is not included in your LinkSim license.",
    lic.INSIGHTS_AI: "AI insights are not included in your LinkSim license.",
    lic.VIEW_3D: "The 3D view is not included in your LinkSim license.",
}

# Start/End and canvas-only annotations don't count towards limit.stations.
_UNCOUNTED_TYPES = {
    STATION_TYPE_SOURCE, STATION_TYPE_DRAIN, STATION_TYPE_CONNECTOR,
    STATION_TYPE_WORKER, STATION_TYPE_WORKER_CONTROLLER, STATION_TYPE_WORKPLACE,
}


def _not_licensed(code: str, msg: str):
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                        detail={"reason": "feature", "feature": code, "msg": msg})


def require_feature(code: str):
    """FastAPI dependency: 403 unless the license includes this feature."""
    def check() -> None:
        if not lic.allows(code):
            _not_licensed(code, _FEATURE_MESSAGES.get(code, f"{code} is not included in your LinkSim license."))
    return check


def count_stations(stations_data: Optional[Dict[str, Any]]) -> int:
    return sum(
        1 for cfg in (stations_data or {}).values()
        if str((cfg or {}).get("Station Type") or "").strip() not in _UNCOUNTED_TYPES
    )


def check_station_limit(stations_data: Optional[Dict[str, Any]]) -> None:
    cap = lic.limit(lic.LIMIT_STATIONS)
    n = count_stations(stations_data)
    if cap is not None and n > cap:
        _not_licensed(lic.LIMIT_STATIONS,
                      f"This scenario has {n} stations; your LinkSim license allows up to {cap}.")


def check_scenario_limit(current_count: int) -> None:
    cap = lic.limit(lic.LIMIT_SCENARIOS)
    if cap is not None and current_count >= cap:
        _not_licensed(lic.LIMIT_SCENARIOS,
                      f"Your LinkSim license allows up to {cap} saved scenarios. Delete one to save a new one.")
