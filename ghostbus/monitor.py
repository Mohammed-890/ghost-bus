"""Daily monitoring: live accuracy, drift, stored predictions, metrics.

Everything is kept as small JSON-lines files in the data folder (so the
website can show it) and, when configured, pushed to Prometheus through a
Pushgateway (PUSHGATEWAY_URL) and logged to MLflow.
"""
from __future__ import annotations

import json
import os
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

from . import config as C
from .drift import psi, score_predictions
from .features import apply_tables, base_columns, compute_tables, judged

MON = C.DATA / "monitoring"
PRED = C.DATA / "predictions"


def _append(name: str, rec: dict):
    MON.mkdir(parents=True, exist_ok=True)
    with open(MON / name, "a") as f:
        f.write(json.dumps(rec, default=str) + "\n")


def read_jsonl(name: str) -> list[dict]:
    p = MON / name
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


def save_predictions(bundle, schedule: pd.DataFrame, results: pd.DataFrame) -> Path | None:
    """The champion's chance for every trip on `schedule`'s day, kept so the
    day can be scored once it has been judged."""
    if bundle is None or schedule.empty:
        return None
    day = pd.to_datetime(schedule.service_date.iloc[0]).date()
    t = apply_tables(base_columns(schedule), compute_tables(judged(results), day))
    out = t[["trip_id", "route", "operator", "direction_id", "start_secs"]].copy()
    out["p_runs"] = (1 - bundle.predict_ghost(t)).round(4)
    out["model_version"] = bundle.meta.get("version")
    PRED.mkdir(parents=True, exist_ok=True)
    path = PRED / f"{day.isoformat()}.csv.gz"
    out.to_csv(path, index=False)
    return path


def score_day(day: date, results_day: pd.DataFrame) -> dict | None:
    p = PRED / f"{day.isoformat()}.csv.gz"
    if not p.exists():
        return None
    s = score_predictions(pd.read_csv(p, dtype={"trip_id": str, "model_version": str}), results_day)
    if s:
        s["day"] = day.isoformat()
        _append("live.jsonl", s)
    return s


def drift_now(bundle, results: pd.DataFrame) -> dict:
    """PSI of the last 7 judged days against the champion's training data."""
    if bundle is None or not bundle.reference:
        return {}
    from .model import training_frame

    feats = training_frame(results)
    if feats.empty:
        return {}
    last = max(feats.service_date)
    scores = psi(bundle.reference, feats[feats.service_date > last - timedelta(days=7)])
    rec = {"day": str(last), "model_version": bundle.meta.get("version"), "psi": scores,
           "psi_max": max(scores.values(), default=0.0)}
    _append("drift.jsonl", rec)
    return rec


def record_decision(decision: dict):
    _append("decisions.jsonl", {k: v for k, v in decision.items() if k != "report"})


def push_metrics(values: dict):
    """Gauges for Prometheus via a Pushgateway (the daily job is a batch job)."""
    url = os.environ.get("PUSHGATEWAY_URL")
    if not url:
        return False
    from prometheus_client import CollectorRegistry, Gauge, push_to_gateway

    reg = CollectorRegistry()
    for key, (help_, value) in values.items():
        if value is None:
            continue
        Gauge(f"ghostbus_daily_{key}", help_, registry=reg).set(float(value))
    push_to_gateway(url, job="ghostbus-daily", registry=reg)
    return True
