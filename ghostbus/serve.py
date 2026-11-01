"""Prediction API: "what's the chance this bus actually runs?"

    uvicorn ghostbus.serve:app --host 0.0.0.0 --port 8000

The champion model is loaded once at start-up (from MLflow when
MLFLOW_TRACKING_URI is set, else from the local registry folder) and
re-checked every MODEL_REFRESH_SECONDS, so a newly promoted model goes live
without a restart. Features are built by the same code as training
(ghostbus.features), so there is no training/serving skew.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta

from fastapi import FastAPI, HTTPException, Query, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

from . import config as C

log = logging.getLogger("ghostbus.serve")
REFRESH = int(os.environ.get("MODEL_REFRESH_SECONDS", "300"))

REQUESTS = Counter("ghostbus_requests_total", "HTTP requests", ["endpoint", "status"])
LATENCY = Histogram("ghostbus_request_seconds", "Request latency", ["endpoint"],
                    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5))
P_RUNS = Histogram("ghostbus_prediction_p_runs", "Predicted chance a bus runs",
                   buckets=(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1.0))
MODEL_LOADED = Gauge("ghostbus_model_loaded", "1 if a champion model is loaded")
MODEL_INFO = Gauge("ghostbus_model_info", "The model being served", ["version", "trained_through"])
MODEL_TEST_BRIER = Gauge("ghostbus_model_test_brier", "Champion's Brier score on its held-out test days")


class State:
    bundle = None
    loaded_at: float | None = None


def load_champion():
    from .registry import get_registry
    return get_registry().champion()


def refresh_model(loader=load_champion) -> bool:
    try:
        bundle = loader()
    except Exception as e:  # keep serving the model we have
        log.warning("model refresh failed: %s", e)
        return False
    if bundle is None:
        return False
    old = State.bundle.meta.get("version") if State.bundle else None
    State.bundle, State.loaded_at = bundle, time.time()
    if bundle.meta.get("version") != old:
        MODEL_INFO.clear()
        MODEL_INFO.labels(str(bundle.meta.get("version")), str(bundle.meta.get("trained_through"))).set(1)
        if bundle.meta.get("test_brier") is not None:
            MODEL_TEST_BRIER.set(float(bundle.meta["test_brier"]))
        log.info("serving model version %s", bundle.meta.get("version"))
    MODEL_LOADED.set(1)
    return True


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not getattr(app.state, "skip_model_load", False):
        refresh_model()

        async def loop():
            while True:
                await asyncio.sleep(REFRESH)
                await asyncio.to_thread(refresh_model)

        task = asyncio.create_task(loop())
        yield
        task.cancel()
    else:
        yield


app = FastAPI(title="Ghost Bus Detector API", version="1.0", lifespan=lifespan,
              description="Chance a timetabled Sheffield bus actually runs, from the champion model.")


@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    route = request.scope.get("route")
    endpoint = route.path if route else "unmatched"
    if endpoint != "/metrics":
        LATENCY.labels(endpoint).observe(time.perf_counter() - start)
        REQUESTS.labels(endpoint, str(response.status_code)).inc()
    return response


def _require_model():
    if State.bundle is None:
        raise HTTPException(503, "No champion model yet: the daily job promotes one once there is enough data.")
    return State.bundle


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/readyz")
def readyz(response: Response):
    if State.bundle is None:
        response.status_code = 503
        return {"status": "no model"}
    return {"status": "ready", "model_version": State.bundle.meta.get("version")}


@app.get("/model")
def model_info():
    b = _require_model()
    return {"version": b.meta.get("version"), "trained_through": b.meta.get("trained_through"),
            "test_brier": b.meta.get("test_brier"), "n_train": b.meta.get("n_train"),
            "departures": int(len(b.departures)), "loaded_at": State.loaded_at}


@app.get("/routes")
def routes():
    b = _require_model()
    d = b.departures
    g = d.groupby(["route", "operator"]).agg(departures=("start_secs", "size"),
                                             directions=("direction_id", lambda s: sorted(set(s)))).reset_index()
    return {"routes": g.to_dict("records")}


def _parse_time(t: str) -> int:
    try:
        h, m = t.split(":")
        h, m = int(h), int(m)
        assert 0 <= m < 60 and 0 <= h < 30          # GTFS allows times past midnight (e.g. 25:10)
    except Exception:
        raise HTTPException(400, "time must be HH:MM, e.g. 08:10")
    return h * 3600 + m * 60


@app.get("/predict")
def predict(route: str = Query(..., examples=["52"]), direction: str = Query("0"),
            time_: str = Query(..., alias="time", examples=["08:10"]),
            on: str | None = Query(None, alias="date", description="YYYY-MM-DD, default tomorrow (UK)")):
    b = _require_model()
    secs = _parse_time(time_)
    try:
        day = date.fromisoformat(on) if on else datetime.now(C.TZ).date() + timedelta(days=1)
    except ValueError:
        raise HTTPException(400, "date must be YYYY-MM-DD")
    res = b.predict_departure(route, direction, secs, day)
    if res is None:
        raise HTTPException(404, f"No route {route} departure at {time_} (direction {direction}) in the timetable.")
    P_RUNS.observe(res["p_runs"])
    return {**res, "time": time_, "date": day.isoformat(), "model_version": b.meta.get("version")}


@app.get("/metrics")
def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
