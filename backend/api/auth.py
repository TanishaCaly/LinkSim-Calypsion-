"""
Per-user auth for LinkSim (demo scope).

Real accounts backed by the User table — signup + login, passwords hashed
with PBKDF2 (stdlib hashlib, no extra dependency needed for a demo). Session
tokens are held in memory only (token -> user_id), same as before: they
vanish on server restart, and the frontend keeps the token in
sessionStorage, so a session naturally ends when the browser tab closes.

Full role-based / admin access is a later phase — for now every user simply
owns their own scenarios and cannot see anyone else's (enforced in the
scenarios routes via require_auth below).
"""
import hashlib
import os
import secrets
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.storage import get_db
from backend.storage.models import User

# New signups get this many days of access before subscription_end_date blocks them.
_TRIAL_DAYS = 30

# Subscription/active-account enforcement is off by default (LinkSim is still
# in development — teammates should be able to register/login freely). Flip
# to "on" once the app is ready to actually gate access.
_SUBSCRIPTION_ENFORCEMENT = os.getenv("SUBSCRIPTION_ENFORCEMENT", "off").strip().lower() == "on"

# Tester build (desktop_launcher.py sets LINKSIM_DESKTOP=1): no login screen —
# /auto signs in as one local user. Off in development.
_DESKTOP = os.getenv("LINKSIM_DESKTOP", "").strip() == "1"
_DESKTOP_USER = "local"

# token -> user_id. In-memory by design (see module docstring).
_active_sessions: dict[str, int] = {}

router = APIRouter(prefix="/api/auth", tags=["auth"])
_bearer = HTTPBearer(auto_error=False)

_PBKDF2_ITERATIONS = 260_000


def _hash_password(password: str, salt: Optional[bytes] = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"{salt.hex()}${digest.hex()}"


def _verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt_hex, _ = stored_hash.split("$", 1)
    except ValueError:
        return False
    salt = bytes.fromhex(salt_hex)
    return secrets.compare_digest(_hash_password(password, salt), stored_hash)


class SignupRequest(BaseModel):
    username: str
    password: str
    email: Optional[str] = None


class LoginRequest(BaseModel):
    username: str
    password: str


class AuthResponse(BaseModel):
    token: str
    username: str
    user_id: int


@router.post("/signup", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def signup(payload: SignupRequest, db: Session = Depends(get_db)):
    username = payload.username.strip()
    if not username or not payload.password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username and password are required")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already taken")

    user = User(
        username=username,
        email=payload.email.strip() if payload.email else None,
        password_hash=_hash_password(payload.password),
        subscription_end_date=datetime.utcnow() + timedelta(days=_TRIAL_DAYS),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = secrets.token_urlsafe(32)
    _active_sessions[token] = user.id
    return AuthResponse(token=token, username=user.username, user_id=user.id)


@router.post("/login", response_model=AuthResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == payload.username.strip()).first()
    if not user or not _verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

    token = secrets.token_urlsafe(32)
    _active_sessions[token] = user.id
    return AuthResponse(token=token, username=user.username, user_id=user.id)


@router.post("/auto", response_model=AuthResponse)
def auto_login(db: Session = Depends(get_db)):
    """Tester build only: sign in as the local user (created on first use)."""
    if not _DESKTOP:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")
    user = db.query(User).filter(User.username == _DESKTOP_USER).first()
    if user is None:
        # A random password nobody knows — this user only signs in via /auto.
        user = User(username=_DESKTOP_USER, password_hash=_hash_password(secrets.token_urlsafe(32)))
        db.add(user)
        db.commit()
        db.refresh(user)

    token = secrets.token_urlsafe(32)
    _active_sessions[token] = user.id
    return AuthResponse(token=token, username=user.username, user_id=user.id)


@router.post("/logout")
def logout(creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)):
    if creds is not None:
        _active_sessions.pop(creds.credentials, None)
    return {"status": "ok"}


def session_user_id(request: Request, creds: Optional[HTTPAuthorizationCredentials]) -> Optional[int]:
    """The signed-in user's id, or None. Shared with the license check."""
    token = creds.credentials if creds is not None else None
    # The live-progress stream (browser EventSource) can't send headers, so it
    # passes the token as ?token=… — accepted on that route only.
    if token is None and request.url.path.endswith("/stream"):
        token = request.query_params.get("token")
    return _active_sessions.get(token) if token is not None else None


def require_auth(
    request: Request,
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
    db: Session = Depends(get_db),
) -> int:
    """FastAPI dependency — raise 401 unless a valid session token is presented,
    or 403 if the token is valid but the account is deactivated / its
    subscription has expired. Returns the current user's id (not username) so
    route handlers can filter their queries by owner."""
    user_id = session_user_id(request, creds)
    if user_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    if not _SUBSCRIPTION_ENFORCEMENT:
        return user_id

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account deactivated")
    if user.subscription_end_date is not None and user.subscription_end_date < datetime.utcnow():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Subscription expired")

    return user_id
