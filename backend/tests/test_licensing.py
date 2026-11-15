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
             iat=None, offline_until=..., revalidate_after=None, key=sk, features=None):
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
                        "max_activations": 1, "features": features or {"view.3d": True}},
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

def licensed_manager(features):
    """A valid license with the given features."""
    m = lic.LicenseManager()
    m.state = "valid"
    m.token = {"license": {"features": features}}
    return m


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(lic, "ENABLED", True)


def test_feature_values(enabled):
    m = licensed_manager({"sim.run": True, "view.3d": False, "limit.stations": 50, "limit.scenarios": 0})
    assert lic.allows(m, "sim.run") and not lic.allows(m, "view.3d")
    assert lic.allows(m, "insights.ai")                 # not in the license → not restricted
    assert lic.limit(m, "limit.stations") == 50
    assert lic.limit(m, "limit.scenarios") == 0          # switched off in the edition
    assert lic.limit(m, "limit.other") is None
    assert lic.limit(m, "sim.run") is None               # a boolean is not a limit


def test_features_unrestricted_when_licensing_off(monkeypatch):
    monkeypatch.setattr(lic, "ENABLED", False)
    m = licensed_manager({"view.3d": False, "limit.stations": 1})
    assert lic.allows(m, "view.3d") and lic.limit(m, "limit.stations") is None
    assert lic.allows(None, "view.3d")


def test_feature_checks(enabled):
    from fastapi import HTTPException
    from backend.api.routes import license as routes

    m = licensed_manager({"insights.ai": False, "limit.stations": 2, "limit.scenarios": 3})
    with pytest.raises(HTTPException) as e:
        routes.require_feature("insights.ai")(m)
    assert e.value.status_code == 403 and e.value.detail["feature"] == "insights.ai"
    routes.require_feature("sim.run")(m)

    stations = {
        "Start": {"Station Type": "Source"}, "End": {"Station Type": "Drain"},
        "Op1": {}, "Op2": {"Station Type": "Station"}, "Link": {"Station Type": "Connector"},
    }
    assert routes.count_stations(stations) == 2
    routes.check_station_limit(m, stations)
    with pytest.raises(HTTPException):
        routes.check_station_limit(m, {**stations, "Op3": {"Station Type": "Buffer"}})

    routes.check_scenario_limit(m, 2)
    with pytest.raises(HTTPException) as e:
        routes.check_scenario_limit(m, 3)
    assert "up to 3" in e.value.detail["msg"]


# ── Web version (LINKSIM_LICENSE=user) ──

@pytest.fixture
def web(monkeypatch, signer, tmp_path):
    """User mode on a throwaway database, with a fake licensing server that
    gives every key the features in `features`."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from backend.storage import database
    from backend.storage.models import Base

    engine = create_engine(f"sqlite:///{tmp_path / 'web.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=engine, autoflush=False))
    monkeypatch.setattr(lic, "MODE", "user")
    monkeypatch.setattr(lic, "ENABLED", True)
    monkeypatch.setattr(lic, "_user_managers", {})

    features = {}
    calls = fake_server(monkeypatch, lambda path, body: None if path.endswith("deactivate") else
                        signer(nonce=body["nonce"], fingerprint=body["fingerprint"], features=dict(features)))
    return features, calls


def test_each_user_has_own_license(web):
    from backend.storage import database
    from backend.storage.models import User

    features, calls = web
    with database.SessionLocal() as db:
        db.add_all([User(id=1, username="ann", password_hash="x"), User(id=2, username="bob", password_hash="x")])
        db.commit()

    ann, bob = lic.for_user(1), lic.for_user(2)
    assert ann.state == bob.state == "unlicensed"
    ann.activate(KEY)
    assert ann.ok and not bob.ok
    assert ann.fingerprint != bob.fingerprint
    assert calls[-1][1]["hostname"] == "web: ann" and calls[-1][1]["platform"] == "LinkSim Web"

    # Survives a restart: the token comes back from the database.
    lic._user_managers.clear()
    assert lic.for_user(1).state == "valid" and lic.for_user(1).key == KEY

    lic.for_user(1).deactivate()
    assert lic.for_user(1).state == "unlicensed"


def test_web_flow_over_http(web, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.storage import database
    import main

    monkeypatch.setattr(main, "SessionLocal", database.SessionLocal)   # main imported its own reference
    features, _ = web
    features.update({"limit.scenarios": 1})
    with TestClient(main.app) as c:
        assert c.get("/api/license/status").json()["signed_in"] is False
        # Signup only creates the account; the key is entered after, signed in.
        assert c.post("/api/auth/signup", json={"username": "ann", "password": "short"}).status_code == 400
        r = c.post("/api/auth/signup", json={"username": "ann", "password": "long-enough", "email": "Ann@x.com"})
        assert r.status_code == 201
        token = r.json()["token"]
        h = {"Authorization": f"Bearer {token}"}
        r = c.post("/api/auth/signup", json={"username": "ann2", "password": "long-enough", "email": "ann@x.com"})
        assert r.status_code == 409 and "email" in r.json()["detail"]

        st = c.get("/api/license/status", headers=h).json()
        assert st["mode"] == "user" and st["signed_in"] and st["state"] == "unlicensed"
        r = c.get("/api/scenarios/", headers=h)
        assert r.status_code == 403 and r.json()["detail"] == "License required"
        assert c.post("/api/license/offline-request", json={"key": KEY}, headers=h).status_code == 404

        assert c.post("/api/license/activate", json={"key": KEY}, headers=h).json()["state"] == "valid"
        assert c.get("/api/scenarios/", headers=h).status_code == 200
        assert c.post("/api/scenarios/", json={"name": "a"}, headers=h).status_code == 201
        r = c.post("/api/scenarios/", json={"name": "b"}, headers=h)
        assert r.status_code == 403 and "up to 1" in r.json()["detail"]["msg"]

        # Without a session the license routes need a login.
        assert c.post("/api/license/activate", json={"key": KEY}).status_code == 401
