"""
License check for the desktop build, against the Calypsion licensing server
(https://license.calypsion.com, product LINKSIM).

How it works:
  - Each PC gets a stable machine fingerprint. Activating a key on it takes
    one seat on the server (POST /v1/activations).
  - The server answers with a signed token (Ed25519). Every token is checked
    here — signature, our nonce, our fingerprint, product — before it is
    trusted, so a faked or replayed answer can never unlock LinkSim.
  - The last good token is kept in <data dir>/license.json. LinkSim checks in
    again after the token's revalidate_after; if the server can't be reached
    it keeps working from the saved token until offline_until.
  - A signed "not valid" answer (revoked, suspended, expired, ...) drops the
    saved token at once. Unsigned errors can only ever lock, never unlock.
  - Air-gapped PCs: write an activation request, support turns it into a
    .lic file on the backoffice, and the .lic is imported here.

On by default in the desktop build (LINKSIM_DESKTOP=1), off in development;
LINKSIM_LICENSE=on/off overrides either way. The API key is put into the
build by packaging/build.ps1 (LINKSIM_LICENSE_API_KEY), never into git.
"""
import base64
import hashlib
import json
import logging
import os
import platform
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

logger = logging.getLogger("linksim.license")

PRODUCT = "LINKSIM"
APP_VERSION = "0.1.0"
SERVER_URL = os.getenv("LINKSIM_LICENSE_URL", "https://license.calypsion.com").rstrip("/")

# kid -> base64url Ed25519 public key, from GET /v1/public-keys. Retired keys
# stay here so tokens signed before a rotation still verify. Add the new key
# here (and ship a build) before a rotated key starts signing.
PUBLIC_KEYS = {
    "lnk-20261115-9f78b4": "G3OCSVVFcjAaIDEmAmYXh9zPLgGiYERg-rjsGn5r9jc",
}
# Extra keys for testing against another server: "kid=key,kid=key".
for _pair in filter(None, os.getenv("LINKSIM_LICENSE_PUBLIC_KEYS", "").split(",")):
    _kid, _, _key = _pair.partition("=")
    PUBLIC_KEYS[_kid.strip()] = _key.strip()

# Same tolerance as the server's verifier SDK.
CLOCK_SKEW_SECONDS = 300
HTTP_TIMEOUT_SECONDS = 10

_DESKTOP = os.getenv("LINKSIM_DESKTOP", "").strip() == "1"
_SWITCH = os.getenv("LINKSIM_LICENSE", "").strip().lower()
ENABLED = _SWITCH == "on" or (_DESKTOP and _SWITCH != "off")

# Shown on the activation page, keyed by the server's reason codes plus our own.
MESSAGES = {
    "unlicensed": "Enter your license key to start using LinkSim.",
    "expired": "This license has expired. Please contact Calypsion to renew it.",
    "revoked": "This license has been revoked. Please contact Calypsion.",
    "suspended": "This license is suspended. Please contact Calypsion.",
    "not_started": "This license is not active yet.",
    "draft": "This license has not been issued yet. Please contact Calypsion.",
    "seat_limit": "This license is already in use on the maximum number of PCs. "
                  "Deactivate it on another PC, or contact Calypsion.",
    "not_activated": "This PC is no longer activated for this license. Activate it again.",
    "fingerprint_required": "This license must be activated on this PC.",
    "unknown_key": "This license key was not recognised. Check it and try again.",
    "offline_expired": "LinkSim could not reach the license server for too long. "
                       "Connect to the internet and retry.",
    "clock_tampered": "Your PC's date and time look wrong. Correct them and retry.",
    "unreachable": "Could not reach the license server. Check your internet connection and retry.",
    "bad_response": "The license server's answer could not be verified. Please contact Calypsion.",
    "wrong_machine": "This license file was made for a different PC.",
    "server_error": "The license server reported an error. Please try again later.",
}


class LicenseError(Exception):
    def __init__(self, reason: str, detail: str = ""):
        super().__init__(detail or MESSAGES.get(reason, reason))
        self.reason = reason


class _Unreachable(Exception):
    """Network failure or 5xx: the saved token may be used instead."""


# ── Machine fingerprint ──────────────────────────────────────────────

def _os_machine_id() -> Optional[str]:
    """The OS's own install ID: survives app reinstalls and LinkSim updates."""
    try:
        if sys.platform == "win32":
            import winreg

            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography", 0,
                                winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
                return str(winreg.QueryValueEx(k, "MachineGuid")[0])
        if sys.platform == "darwin":
            out = subprocess.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                                 capture_output=True, text=True, timeout=5).stdout
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    return line.split("=", 1)[1].strip().strip('"')
        for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):  # Linux
            if os.path.isfile(path):
                with open(path, encoding="utf-8") as f:
                    value = f.read().strip()
                if value:
                    return value
    except Exception:
        logger.warning("Could not read the OS machine ID", exc_info=True)
    return None


def _data_dir() -> str:
    return os.environ.get("LINKSIM_DATA_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def machine_fingerprint() -> str:
    """Hashed (the raw OS ID never leaves the PC) and tied to this product.
    Falls back to a random ID kept in the data folder."""
    raw = _os_machine_id()
    if not raw:
        path = os.path.join(_data_dir(), "machine_id")
        try:
            with open(path, encoding="utf-8") as f:
                raw = f.read().strip()
        except OSError:
            raw = ""
        if not raw:
            raw = str(uuid.uuid4())
            with open(path, "w", encoding="utf-8") as f:
                f.write(raw)
    return hashlib.sha256(f"linksim:{raw}".encode()).hexdigest()


def _hash_fingerprint(raw: str) -> str:
    """What the server stores and binds tokens to (license_format::hash_fingerprint)."""
    return hashlib.sha256(raw.strip().encode()).hexdigest()


def _platform() -> str:
    return f"{platform.system()} {platform.release()} {platform.machine()}".strip()


# ── Signed tokens ─────────────────────────────────────────────────────

def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _verify_signature(envelope: dict) -> dict:
    """Check the envelope's Ed25519 signature; return the decoded payload."""
    try:
        if envelope.get("v") != 1 or envelope.get("alg") != "EdDSA":
            raise ValueError("unsupported envelope")
        key = PUBLIC_KEYS.get(envelope["kid"])
        if key is None:
            raise ValueError(f"unknown signing key {envelope['kid']}")
        payload = _b64url_decode(envelope["payload"])
        Ed25519PublicKey.from_public_bytes(_b64url_decode(key)).verify(_b64url_decode(envelope["sig"]), payload)
        token = json.loads(payload)
    except (InvalidSignature, KeyError, TypeError, ValueError) as e:
        raise LicenseError("bad_response", f"License token rejected: {e or 'bad signature'}") from e
    if (token.get("license") or {}).get("product") != PRODUCT:
        raise LicenseError("bad_response", "License token is for a different product")
    return token


def _check_common(token: dict, fingerprint: str) -> None:
    # Tokens bound to a machine must be bound to this one.
    bound = token.get("fingerprint")
    if bound is not None and bound != _hash_fingerprint(fingerprint):
        raise LicenseError("wrong_machine")
    if token.get("iat", 0) > time.time() + CLOCK_SKEW_SECONDS:
        raise LicenseError("clock_tampered")


def verify_online(envelope: dict, nonce: str, fingerprint: str) -> dict:
    """A token the server just sent for a request made with `nonce`."""
    token = _verify_signature(envelope)
    if token.get("typ") not in ("validation", "activation"):
        raise LicenseError("bad_response", "Unexpected license token type")
    if token.get("nonce") != nonce:
        raise LicenseError("bad_response", "License token does not match the request (replayed?)")
    _check_common(token, fingerprint)
    if not token.get("valid"):
        raise LicenseError(token.get("reason") or "unknown_key")
    return token


def verify_offline(envelope: dict, fingerprint: str, last_seen: float = 0) -> dict:
    """A saved token or an imported .lic file, without the network."""
    token = _verify_signature(envelope)
    _check_common(token, fingerprint)
    if token.get("typ") == "license" and token.get("fingerprint") is None:
        raise LicenseError("wrong_machine")
    if not token.get("valid"):
        raise LicenseError(token.get("reason") or "unknown_key")
    now = time.time()
    # A clock set back before the token was issued (or before the last time
    # LinkSim ran) would stretch the offline period.
    if now + CLOCK_SKEW_SECONDS < max(token.get("iat", 0), last_seen):
        raise LicenseError("clock_tampered")
    until = token.get("offline_until")
    if until is None or now > until:
        raise LicenseError("offline_expired")
    return token


# ── Licensing server API ──────────────────────────────────────────────

def _api_key() -> str:
    return os.getenv("LINKSIM_LICENSE_API_KEY", "").strip()


def _post(path: str, body: dict) -> Optional[dict]:
    """POST to the /v1 API. Returns the JSON body (None for 204), raises
    LicenseError for a 4xx and _Unreachable for network errors and 5xx."""
    if not _api_key():
        raise LicenseError("server_error", "This LinkSim build has no license API key (see packaging/build.ps1).")
    req = urllib.request.Request(
        SERVER_URL + path,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json",
                 "User-Agent": f"LinkSim/{APP_VERSION}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as r:
            data = r.read()
            return json.loads(data) if data else None
    except urllib.error.HTTPError as e:
        if e.code >= 500:
            raise _Unreachable(f"server error {e.code}") from e
        try:
            problem = json.loads(e.read() or b"{}")
        except ValueError:
            problem = {}
        code = problem.get("code") or ""
        # 404 not_found = unknown key; 409 seat_limit; 401/403 = bad API key.
        if e.code == 404:
            raise LicenseError("unknown_key") from e
        if code in MESSAGES:
            raise LicenseError(code) from e
        logger.warning("License server answered %s: %s", e.code, problem)
        raise LicenseError("server_error", problem.get("detail") or f"License server error {e.code}") from e
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise _Unreachable(str(e)) from e


def _request_body(key: str, fingerprint: str, nonce: str) -> dict:
    return {"key": key, "fingerprint": fingerprint, "nonce": nonce, "app_version": APP_VERSION,
            "hostname": socket.gethostname(), "platform": _platform()}


# ── Saved state ───────────────────────────────────────────────────────

def _cache_path() -> str:
    return os.path.join(_data_dir(), "license.json")


def _read_cache() -> dict:
    try:
        with open(_cache_path(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_cache(key: Optional[str], envelope: Optional[dict]) -> None:
    """key is kept even when the token is dropped, so the activation page can
    offer it again (e.g. after a suspension is lifted). last_seen only moves
    forward, for clock rollback detection."""
    old = _read_cache()
    data = {"key": key, "envelope": envelope, "last_seen": max(old.get("last_seen", 0), time.time())}
    tmp = _cache_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, _cache_path())


def _clear_cache() -> None:
    try:
        os.remove(_cache_path())
    except FileNotFoundError:
        pass


class LicenseManager:
    """The license state of this PC, shared by the API routes."""

    def __init__(self):
        self._lock = threading.Lock()
        self._refreshing = False
        self._ready = threading.Event()
        self.state = "unlicensed"     # unlicensed | valid | offline | invalid
        self.reason = "unlicensed"
        self.detail = ""
        self.token: Optional[dict] = None
        self.key: Optional[str] = None
        self._fingerprint: Optional[str] = None
        self._last_attempt = 0.0

    @property
    def fingerprint(self) -> str:
        if self._fingerprint is None:
            self._fingerprint = machine_fingerprint()
        return self._fingerprint

    @property
    def ok(self) -> bool:
        return self.state in ("valid", "offline")

    def _set(self, state: str, reason: str, token: Optional[dict] = None, detail: str = "") -> None:
        self.state, self.reason, self.token = state, reason, token
        self.detail = detail or MESSAGES.get(reason, "")
        if state == "invalid":
            logger.warning("License not valid: %s (%s)", reason, self.detail)

    def _deny(self, err: LicenseError, drop_token: bool) -> None:
        if drop_token:
            _write_cache(self.key, None)
        self._set("invalid", err.reason, detail=str(err))

    # The startup check and the periodic check-in.
    def refresh(self) -> None:
        with self._lock:
            self._last_attempt = time.time()
            try:
                self._refresh()
            except Exception:
                logger.exception("License check failed")
                self._set("invalid", "server_error")
            finally:
                self._refreshing = False
                self._ready.set()

    def _refresh(self) -> None:
        cache = _read_cache()
        self.key = cache.get("key")
        envelope = cache.get("envelope")
        if not self.key:
            self._set("unlicensed", "unlicensed")
            return

        # Air-gapped .lic files are never validated online.
        if envelope and self._typ(envelope) == "license":
            self._use_saved(envelope, cache, network="")
            return

        nonce = secrets.token_hex(16)
        try:
            env = _post("/v1/licenses/validate", _request_body(self.key, self.fingerprint, nonce))
            token = verify_online(env, nonce, self.fingerprint)
        except (_Unreachable, LicenseError) as e:
            # A server that is down, misconfigured or answering garbage is
            # treated like no network: the saved token keeps working until
            # offline_until. Signed denials and 4xx answers end it at once.
            if isinstance(e, LicenseError) and e.reason not in ("bad_response", "server_error"):
                self._deny(e, drop_token=True)
            elif envelope:
                self._use_saved(envelope, cache, network=str(e))
            elif isinstance(e, LicenseError):
                self._set("invalid", e.reason, detail=str(e))
            else:
                self._set("invalid", "unreachable")
            return
        _write_cache(self.key, env)
        self._set("valid", "valid", token)

    def _use_saved(self, envelope: dict, cache: dict, network: str) -> None:
        try:
            token = verify_offline(envelope, self.fingerprint, cache.get("last_seen", 0))
        except LicenseError as e:
            self._deny(e, drop_token=e.reason not in ("clock_tampered", "offline_expired"))
            return
        _write_cache(self.key, envelope)   # moves last_seen forward
        if network:
            logger.info("License server unreachable (%s) — using the saved license", network)
        self._set("offline" if network else "valid", "valid", token)

    @staticmethod
    def _typ(envelope: dict) -> Optional[str]:
        try:
            return json.loads(_b64url_decode(envelope["payload"])).get("typ")
        except Exception:
            return None

    def wait_ready(self, timeout: float = HTTP_TIMEOUT_SECONDS + 5) -> None:
        self._ready.wait(timeout)

    def check_in_if_due(self) -> None:
        """Called on every request: starts a background check-in once the
        token says so. Never blocks the request."""
        if not self.ok or self._refreshing:
            return
        due = (self.token or {}).get("revalidate_after") or 0
        # Offline: retry the server every 15 minutes.
        if self.state == "offline":
            due = max(due, self._last_attempt + 15 * 60)
        if time.time() >= due:
            self._refreshing = True
            threading.Thread(target=self.refresh, daemon=True).start()

    def ensure_valid(self) -> None:
        """For the request gate. Also catches a token whose offline window
        ran out while LinkSim was open."""
        until = (self.token or {}).get("offline_until")
        if self.state == "offline" and until is not None and time.time() > until:
            self._set("invalid", "offline_expired")
        self.check_in_if_due()

    # ── User actions ──

    def activate(self, key: str) -> None:
        key = key.strip().upper()
        with self._lock:
            nonce = secrets.token_hex(16)
            try:
                env = _post("/v1/activations", _request_body(key, self.fingerprint, nonce))
                token = verify_online(env, nonce, self.fingerprint)
            except _Unreachable:
                raise LicenseError("unreachable")
            self.key = key
            _write_cache(key, env)
            self._set("valid", "valid", token)

    def deactivate(self) -> None:
        """Free this PC's seat so the key can be used on another PC."""
        with self._lock:
            if self.key and self.state != "unlicensed":
                try:
                    _post("/v1/activations/deactivate", {"key": self.key, "fingerprint": self.fingerprint})
                except _Unreachable:
                    raise LicenseError("unreachable")
                except LicenseError as e:
                    # Already gone on the server (unknown key, not activated): just forget it here.
                    if e.reason == "server_error":
                        raise
            _clear_cache()
            self.key = None
            self._set("unlicensed", "unlicensed")

    def offline_request(self, key: str) -> str:
        """Contents of the activation request file for an air-gapped PC
        (license_format::ActivationRequest)."""
        req = {"v": 1, "key": key.strip().upper(), "fingerprint": self.fingerprint, "nonce": secrets.token_hex(16),
               "hostname": socket.gethostname(), "platform": _platform(), "created_at": int(time.time())}
        return _b64url_encode(json.dumps(req, separators=(",", ":")).encode())

    def import_license_file(self, contents: str) -> None:
        try:
            envelope = json.loads(contents)
        except ValueError:
            raise LicenseError("bad_response", "This is not a LinkSim license file.")
        with self._lock:
            token = verify_offline(envelope, self.fingerprint, _read_cache().get("last_seen", 0))
            self.key = token["license"]["key"]
            _write_cache(self.key, envelope)
            self._set("valid", "valid", token)

    def status(self) -> dict[str, Any]:
        lic = (self.token or {}).get("license") or {}
        return {
            "enabled": ENABLED,
            "state": self.state,
            "reason": self.reason,
            "message": self.detail,
            "key": self.key,
            "offline_until": (self.token or {}).get("offline_until") if self.state == "offline" else None,
            "air_gapped": (self.token or {}).get("typ") == "license",
            "license": {
                "customer": (lic.get("customer") or {}).get("name"),
                "edition": lic.get("edition"),
                "term_type": lic.get("term_type"),
                "expires_at": lic.get("expires_at"),
                "features": lic.get("features") or {},
            } if lic else None,
        }


manager = LicenseManager()


# ── Features ──────────────────────────────────────────────────────────
# Codes defined on the LINKSIM product in the backoffice (Product → Features);
# each edition sets which are on and the limit values. A feature the license
# doesn't mention is not restricted, so older licenses keep working when a
# new code is added.

SIM_RUN = "sim.run"
IMPORT_FILES = "import.excel"
INSIGHTS_AI = "insights.ai"
VIEW_3D = "view.3d"
LIMIT_STATIONS = "limit.stations"
LIMIT_SCENARIOS = "limit.scenarios"


def feature(code: str):
    """The license's value for a feature (bool, or int for limits); None when
    the license doesn't say or licensing is off."""
    if not ENABLED or not manager.ok:
        return None
    return (((manager.token or {}).get("license") or {}).get("features") or {}).get(code)


def allows(code: str) -> bool:
    value = feature(code)
    return value is None or bool(value)   # false, or a limit of 0, means no


def limit(code: str) -> Optional[int]:
    """None = unlimited. The server sends a limit that is switched off in the
    edition as 0."""
    value = feature(code)
    return value if isinstance(value, int) and not isinstance(value, bool) else None
