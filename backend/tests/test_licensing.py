"""
Tests for the desktop license check (backend/licensing.py), with a local
signing key standing in for the licensing server.
"""
import base64
import json
import time

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from backend import licensing as lic

KID = "test-key"
FP = "fp-test-machine"
KEY = "LNK-AAAA-BBBB-CCCC"


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


@pytest.fixture
def signer(monkeypatch, tmp_path):
    sk = Ed25519PrivateKey.generate()
    pub = sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    monkeypatch.setitem(lic.PUBLIC_KEYS, KID, b64(pub))
    monkeypatch.setenv("LINKSIM_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LINKSIM_LICENSE_API_KEY", "lsk_test")
    monkeypatch.setattr(lic, "machine_fingerprint", lambda: FP)

    def sign(nonce=None, valid=True, reason="valid", typ="validation", fingerprint=FP, product="LINKSIM",
             iat=None, offline_until=..., revalidate_after=None, key=sk):
        now = int(time.time())
        payload = {
            "typ": typ, "valid": valid, "reason": reason, "nonce": nonce,
            "fingerprint": lic._hash_fingerprint(fingerprint) if fingerprint else None,
            "activation_id": None, "iat": iat or now,
            "offline_until": now + 7 * 86400 if offline_until is ... else offline_until,
            "revalidate_after": revalidate_after or now + 86400,
            "license": {"id": "l1", "key": KEY, "product": product, "edition": "STANDARD",
                        "customer": {"id": "c1", "name": "Acme"}, "status": "active",
                        "term_type": "subscription", "enforcement": "node_locked", "starts_at": now,
                        "expires_at": now + 365 * 86400, "grace_days": 14, "maintenance_until": None,
                        "max_activations": 1, "features": {"view.3d": True}},
        }
        data = json.dumps(payload).encode()
        return {"v": 1, "alg": "EdDSA", "kid": KID, "payload": b64(data), "sig": b64(key.sign(data))}

    return sign


def fake_server(monkeypatch, handler):
    """Route licensing._post through handler(path, body)."""
    calls = []

    def post(path, body):
        calls.append((path, body))
        return handler(path, body)

    monkeypatch.setattr(lic, "_post", post)
    return calls


# ── Token verification ──

def test_verify_online_accepts_good_token(signer):
    token = lic.verify_online(signer(nonce="n1"), "n1", FP)
    assert token["license"]["customer"]["name"] == "Acme"


@pytest.mark.parametrize("change, reason", [
    (dict(nonce="other"), "bad_response"),              # replayed answer
    (dict(fingerprint="another-pc"), "wrong_machine"),
    (dict(product="OTHER"), "bad_response"),
    (dict(valid=False, reason="revoked"), "revoked"),
    (dict(iat=int(time.time()) + 3600), "clock_tampered"),
    (dict(key=Ed25519PrivateKey.generate()), "bad_response"),  # forged signature
])
def test_verify_online_rejects(signer, change, reason):
    kwargs = {"nonce": "n1", **change}
    with pytest.raises(lic.LicenseError) as e:
        lic.verify_online(signer(**kwargs), "n1", FP)
    assert e.value.reason == reason


def test_tampered_payload_is_rejected(signer):
    env = signer(nonce="n1")
    payload = json.loads(base64.urlsafe_b64decode(env["payload"] + "=="))
    payload["license"]["edition"] = "PRO"
    env["payload"] = b64(json.dumps(payload).encode())
    with pytest.raises(lic.LicenseError):
        lic.verify_online(env, "n1", FP)


def test_verify_offline_window(signer):
    lic.verify_offline(signer(), FP)
    with pytest.raises(lic.LicenseError) as e:
        lic.verify_offline(signer(offline_until=int(time.time()) - 1), FP)
    assert e.value.reason == "offline_expired"
    with pytest.raises(lic.LicenseError) as e:
        lic.verify_offline(signer(offline_until=None), FP)
    assert e.value.reason == "offline_expired"
    # Clock turned back before the last time LinkSim ran.
    with pytest.raises(lic.LicenseError) as e:
        lic.verify_offline(signer(), FP, last_seen=time.time() + 86400)
    assert e.value.reason == "clock_tampered"


# ── Manager flows ──

def test_activate_then_validate(monkeypatch, signer):
    calls = fake_server(monkeypatch, lambda path, body: signer(nonce=body["nonce"], typ="activation"
                                                                if path == "/v1/activations" else "validation"))
    m = lic.LicenseManager()
    m.refresh()
    assert m.state == "unlicensed"

    m.activate(" lnk-aaaa-bbbb-cccc ")
    assert m.ok and m.key == KEY
    assert calls[-1][0] == "/v1/activations" and calls[-1][1]["fingerprint"] == FP

    # A fresh start validates the saved key.
    m2 = lic.LicenseManager()
    m2.refresh()
    assert m2.state == "valid"
    assert calls[-1][0] == "/v1/licenses/validate"


def test_offline_uses_saved_token_then_signed_denial_locks(monkeypatch, signer):
    fake_server(monkeypatch, lambda path, body: signer(nonce=body["nonce"]))
    m = lic.LicenseManager()
    m.activate(KEY)

    def down(path, body):
        raise lic._Unreachable("no network")
    fake_server(monkeypatch, down)
    m.refresh()
    assert m.state == "offline"

    fake_server(monkeypatch, lambda path, body: signer(nonce=body["nonce"], valid=False, reason="suspended"))
    m.refresh()
    assert m.state == "invalid" and m.reason == "suspended"

    # The saved token is gone: offline no longer unlocks, but the key is kept.
    fake_server(monkeypatch, down)
    m.refresh()
    assert m.state == "invalid" and m.key == KEY


def test_seat_limit(monkeypatch, signer):
    def full(path, body):
        raise lic.LicenseError("seat_limit")
    fake_server(monkeypatch, full)
    m = lic.LicenseManager()
    with pytest.raises(lic.LicenseError) as e:
        m.activate(KEY)
    assert e.value.reason == "seat_limit"
    assert not m.ok


def test_deactivate_clears(monkeypatch, signer, tmp_path):
    calls = fake_server(monkeypatch, lambda path, body: None if path.endswith("deactivate")
                        else signer(nonce=body["nonce"]))
    m = lic.LicenseManager()
    m.activate(KEY)
    m.deactivate()
    assert m.state == "unlicensed"
    assert calls[-1] == ("/v1/activations/deactivate", {"key": KEY, "fingerprint": FP})
    assert not (tmp_path / "license.json").exists()


def test_air_gapped_license_file(monkeypatch, signer):
    calls = fake_server(monkeypatch, lambda path, body: pytest.fail("air-gapped must not go online"))
    m = lic.LicenseManager()
    req = json.loads(base64.urlsafe_b64decode(m.offline_request(KEY) + "=="))
    assert req["v"] == 1 and req["key"] == KEY and req["fingerprint"] == FP

    m.import_license_file(json.dumps(signer(typ="license")))
    assert m.ok and m.status()["air_gapped"]
    m.refresh()
    assert m.state == "valid" and not calls

    # A .lic made for another PC is refused.
    with pytest.raises(lic.LicenseError) as e:
        m.import_license_file(json.dumps(signer(typ="license", fingerprint="another-pc")))
    assert e.value.reason == "wrong_machine"


# ── Features ──

@pytest.fixture
def licensed(monkeypatch, signer):
    """A valid license with the given features."""
    def make(features):
        m = lic.LicenseManager()
        m.state = "valid"
        m.token = {"license": {"features": features}}
        monkeypatch.setattr(lic, "manager", m)
        monkeypatch.setattr(lic, "ENABLED", True)
    return make


def test_feature_values(licensed):
    licensed({"sim.run": True, "view.3d": False, "limit.stations": 50, "limit.scenarios": 0})
    assert lic.allows("sim.run") and not lic.allows("view.3d")
    assert lic.allows("insights.ai")                 # not in the license → not restricted
    assert lic.limit("limit.stations") == 50
    assert lic.limit("limit.scenarios") == 0          # switched off in the edition
    assert lic.limit("limit.other") is None
    assert lic.limit("sim.run") is None               # a boolean is not a limit


def test_features_unrestricted_when_licensing_off(monkeypatch):
    monkeypatch.setattr(lic, "ENABLED", False)
    assert lic.allows("view.3d") and lic.limit("limit.stations") is None


def test_feature_checks(licensed):
    from fastapi import HTTPException
    from backend.api.routes import license as routes

    licensed({"insights.ai": False, "limit.stations": 2, "limit.scenarios": 3})
    with pytest.raises(HTTPException) as e:
        routes.require_feature("insights.ai")()
    assert e.value.status_code == 403 and e.value.detail["feature"] == "insights.ai"
    routes.require_feature("sim.run")()

    stations = {
        "Start": {"Station Type": "Source"}, "End": {"Station Type": "Drain"},
        "Op1": {}, "Op2": {"Station Type": "Station"}, "Link": {"Station Type": "Connector"},
    }
    assert routes.count_stations(stations) == 2
    routes.check_station_limit(stations)
    with pytest.raises(HTTPException):
        routes.check_station_limit({**stations, "Op3": {"Station Type": "Buffer"}})

    routes.check_scenario_limit(2)
    with pytest.raises(HTTPException) as e:
        routes.check_scenario_limit(3)
    assert "up to 3" in e.value.detail["msg"]
