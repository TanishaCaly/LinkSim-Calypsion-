"""
Basic shared-credential auth for LinkSim.

Single username/password (configurable via LINKSIM_USERNAME / LINKSIM_PASSWORD
env vars, defaulting to admin/linksim123 for local dev) gates the whole API.
Session tokens are held in memory only — they vanish on server restart and
there is no persistent "remember me"; the frontend stores the token in
sessionStorage, so a session naturally ends when the browser tab closes.
"""
import os
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

LINKSIM_USERNAME = os.environ.get("LINKSIM_USERNAME", "admin")
LINKSIM_PASSWORD = os.environ.get("LINKSIM_PASSWORD", "linksim123")

# token -> username. In-memory by design (see module docstring).
_active_sessions: dict[str, str] = {}

router = APIRouter(prefix="/api/auth", tags=["auth"])
_bearer = HTTPBearer(auto_error=False)


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    username: str


@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest):
    if payload.username != LINKSIM_USERNAME or payload.password != LINKSIM_PASSWORD:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")
    token = secrets.token_urlsafe(32)
    _active_sessions[token] = payload.username
    return LoginResponse(token=token, username=payload.username)


@router.post("/logout")
def logout(creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)):
    if creds is not None:
        _active_sessions.pop(creds.credentials, None)
    return {"status": "ok"}


def require_auth(creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> str:
    """FastAPI dependency — raise 401 unless a valid session token is presented."""
    if creds is None or creds.credentials not in _active_sessions:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return _active_sessions[creds.credentials]
