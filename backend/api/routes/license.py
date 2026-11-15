"""
License routes (see backend/licensing.py).

Desktop (machine mode): open routes — the activation page runs before login.
The server only listens on 127.0.0.1 in the desktop build.
Web (user mode): each signed-in user manages their own account's license.
"""
import asyncio
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from backend import licensing as lic
from backend.api.auth import session_user_id
from backend.engine.sim_core import (
    STATION_TYPE_CONNECTOR, STATION_TYPE_DRAIN, STATION_TYPE_SOURCE,
    STATION_TYPE_WORKER, STATION_TYPE_WORKER_CONTROLLER, STATION_TYPE_WORKPLACE,
)
from backend.licensing import LicenseError, LicenseManager

router = APIRouter(prefix="/api/license", tags=["license"])
_bearer = HTTPBearer(auto_error=False)


class KeyRequest(BaseModel):
    key: str


class LicenseFileRequest(BaseModel):
    license_file: str


def _fail(err: LicenseError):
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"reason": err.reason, "msg": str(err)})


def current_license(
    request: Request,
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[LicenseManager]:
    """FastAPI dependency — the license this request runs under: the PC's
    (desktop), the signed-in user's (web), or None when licensing is off."""
    if lic.MODE == "off":
        return None
    if lic.MODE == "machine":
        return lic.manager
    user_id = session_user_id(request, creds)
    if user_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return lic.for_user(user_id)


def _check(m: Optional[LicenseManager]) -> None:
    if m is None:
        return
    m.ensure_valid()
    if not m.ok:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="License required")


def require_license(m: Optional[LicenseManager] = Depends(current_license)) -> None:
    """FastAPI dependency for the app's routes — 403 "License required" until
    the PC / the signed-in user has a valid license."""
    _check(m)


def require_license_before_login() -> None:
    """For the auth routes: the desktop needs the PC's license before anyone
    signs in; on the web you sign in first and enter your key after."""
    if lic.MODE == "machine":
        _check(lic.manager)


def _desktop_only() -> None:
    if lic.MODE != "machine":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")


@router.get("/status")
async def license_status(request: Request, creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)):
    if lic.MODE == "user":
        user_id = session_user_id(request, creds)
        if user_id is None:
            return lic.status_signed_out()
        m = await asyncio.to_thread(lic.for_user, user_id)
    else:
        m = lic.manager
        # Right after start the first check may still be talking to the server.
        if lic.ENABLED:
            await asyncio.to_thread(m.wait_ready)
    if lic.ENABLED:
        m.ensure_valid()
    return m.status()


@router.post("/activate")
async def activate(payload: KeyRequest, m: Optional[LicenseManager] = Depends(current_license)):
    if m is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Licensing is off")
    if not payload.key.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Enter a license key")
    try:
        await asyncio.to_thread(m.activate, payload.key)
    except LicenseError as e:
        _fail(e)
    return m.status()


@router.post("/refresh")
async def refresh(m: Optional[LicenseManager] = Depends(current_license)):
    """The activation page's Retry button."""
    m = m or lic.manager
    await asyncio.to_thread(m.refresh)
    return m.status()


@router.post("/deactivate")
async def deactivate(m: Optional[LicenseManager] = Depends(current_license)):
    m = m or lic.manager
    try:
        await asyncio.to_thread(m.deactivate)
    except LicenseError as e:
        _fail(e)
    return m.status()


# Air-gapped PCs: desktop only.

@router.post("/offline-request", dependencies=[Depends(_desktop_only)])
def offline_request(payload: KeyRequest):
    if not payload.key.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Enter a license key")
    return {"request": lic.manager.offline_request(payload.key)}


@router.post("/offline-license", dependencies=[Depends(_desktop_only)])
def offline_license(payload: LicenseFileRequest):
    try:
        lic.manager.import_license_file(payload.license_file)
    except LicenseError as e:
        _fail(e)
    return lic.manager.status()

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
    def check(m: Optional[LicenseManager] = Depends(current_license)) -> None:
        if not lic.allows(m, code):
            _not_licensed(code, _FEATURE_MESSAGES.get(code, f"{code} is not included in your LinkSim license."))
    return check


def count_stations(stations_data: Optional[Dict[str, Any]]) -> int:
    return sum(
        1 for cfg in (stations_data or {}).values()
        if str((cfg or {}).get("Station Type") or "").strip() not in _UNCOUNTED_TYPES
    )


def check_station_limit(m: Optional[LicenseManager], stations_data: Optional[Dict[str, Any]]) -> None:
    cap = lic.limit(m, lic.LIMIT_STATIONS)
    n = count_stations(stations_data)
    if cap is not None and n > cap:
        _not_licensed(lic.LIMIT_STATIONS,
                      f"This scenario has {n} stations; your LinkSim license allows up to {cap}.")


def check_scenario_limit(m: Optional[LicenseManager], current_count: int) -> None:
    cap = lic.limit(m, lic.LIMIT_SCENARIOS)
    if cap is not None and current_count >= cap:
        _not_licensed(lic.LIMIT_SCENARIOS,
                      f"Your LinkSim license allows up to {cap} saved scenarios. Delete one to save a new one.")
