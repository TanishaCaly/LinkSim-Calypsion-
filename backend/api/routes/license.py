"""
License routes for the desktop build (see backend/licensing.py).

Open routes: they are what the activation page uses before LinkSim is
unlocked. The server only listens on 127.0.0.1 in the desktop build.
"""
import asyncio

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

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
