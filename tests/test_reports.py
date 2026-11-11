"""Passenger reports: validation, verification levels and rate limits."""
import pytest
from fastapi.testclient import TestClient

from ghostbus import reports, serve


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GHOSTBUS_DB", str(tmp_path / "t.db"))
    reports._hits.clear()
    serve.app.state.skip_model_load = True
    with TestClient(serve.app) as c:
        yield c


def rep(device, kind="no_show", check="unconfirmed", i=5):
    return {"day": "2026-11-11", "i": i, "route": "52", "operator": "Stagecoach Yorkshire", "start": "08:07",
            "stop": "Crookes/School Road", "kind": kind, "check": check, "device": device}


def test_one_report_is_not_fact(client):
    r = client.post("/reports", json=rep("device-aaaa"))
    assert r.status_code == 201 and r.json()["trip"]["no_show"]["level"] == "single"


def test_levels_rise_with_devices_and_gps(client):
    client.post("/reports", json=rep("device-aaaa"))
    assert client.post("/reports", json=rep("device-bbbb")).json()["trip"]["no_show"]["level"] == "likely"
    assert client.post("/reports", json=rep("device-cccc")).json()["trip"]["no_show"]["level"] == "confirmed"
    gps = client.post("/reports", json=rep("device-dddd", kind="late", check="agrees")).json()["trip"]["late"]
    assert gps["level"] == "confirmed" and gps["gps_agrees"]
    today = client.get("/reports/today", params={"day": "2026-11-11"}).json()
    assert today["trips"][0]["trip"] == 5


def test_same_device_twice_is_still_one_voice(client):
    client.post("/reports", json=rep("device-aaaa"))
    assert client.post("/reports", json=rep("device-aaaa")).json()["trip"]["no_show"]["level"] == "single"


def test_validation_and_rate_limit(client):
    assert client.post("/reports", json={**rep("device-aaaa"), "kind": "aliens"}).status_code == 422
    assert client.post("/reports", json={**rep("x"), "device": "bad id!"}).status_code == 422
    codes = [client.post("/reports", json=rep("device-limit")).status_code for _ in range(11)]
    assert codes[:10] == [201] * 10 and codes[10] == 429


def test_push_subscription_is_stored(client):
    r = client.post("/push/subscribe", json={"endpoint": "https://push.example/abc", "p256dh": "x" * 40, "auth": "y" * 16, "device": "device-aaaa"})
    assert r.status_code == 201 and r.json()["sending_enabled"] is False
    assert client.delete("/push/subscribe", params={"endpoint": "https://push.example/abc"}).json()["ok"]
