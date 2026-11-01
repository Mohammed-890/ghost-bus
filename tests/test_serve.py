"""The prediction API, with a model trained on synthetic days."""
from datetime import date

import pytest
from fastapi.testclient import TestClient

from ghostbus import serve
from ghostbus.model import fit_bundle
from tests.test_mlops import schedule_for
from tests.test_model import synthetic


@pytest.fixture()
def client():
    res = synthetic(days=14)
    bundle = fit_bundle(res, schedule_for(res, date(2026, 12, 1)), meta={"version": "7", "test_brier": 0.05})
    serve.app.state.skip_model_load = True
    serve.State.bundle = None
    with TestClient(serve.app) as c:
        serve.refresh_model(loader=lambda: bundle)
        yield c
    serve.State.bundle = None


def test_health_and_readiness(client):
    assert client.get("/healthz").json() == {"status": "ok"}
    r = client.get("/readyz")
    assert r.status_code == 200 and r.json()["model_version"] == "7"


def test_not_ready_without_a_model():
    serve.app.state.skip_model_load = True
    serve.State.bundle = None
    with TestClient(serve.app) as c:
        assert c.get("/readyz").status_code == 503
        assert c.get("/predict", params={"route": "52", "time": "08:00"}).status_code == 503


def test_predict_a_real_departure(client):
    r = client.get("/predict", params={"route": "52", "direction": "0", "time": "08:00", "date": "2026-12-01"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert 0 <= body["p_runs"] <= 1 and body["model_version"] == "7" and body["operator"] == "Stagecoach"


def test_rush_hour_52_is_riskier_than_midday(client):
    # the synthetic data plants unreliable route 52 trips between 07:00 and 09:00
    rush = client.get("/predict", params={"route": "52", "time": "08:00", "date": "2026-12-01"}).json()["p_runs"]
    noon = client.get("/predict", params={"route": "52", "time": "12:00", "date": "2026-12-01"}).json()["p_runs"]
    assert rush < noon


def test_clear_errors(client):
    assert client.get("/predict", params={"route": "999", "time": "08:00"}).status_code == 404
    assert client.get("/predict", params={"route": "52", "time": "8am"}).status_code == 400
    assert client.get("/predict", params={"route": "52", "time": "08:00", "date": "tomorrow"}).status_code == 400


def test_routes_and_metrics(client):
    routes = client.get("/routes").json()["routes"]
    assert {r["route"] for r in routes} == {"52", "7", "88"}
    client.get("/predict", params={"route": "52", "time": "08:00"})
    m = client.get("/metrics").text
    assert 'ghostbus_requests_total{endpoint="/predict",status="200"}' in m
    assert 'ghostbus_model_info{trained_through=' in m and "ghostbus_prediction_p_runs_bucket" in m
