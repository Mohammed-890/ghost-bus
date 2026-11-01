"""Is the live model going stale?

Two separate signals, because they fail differently:

* data drift   - the trips we're predicting no longer look like the trips
                 the model learned from (a new timetable, a route change).
                 Measured per feature with the Population Stability Index:
                 PSI < 0.1 stable, 0.1-0.2 watch, > 0.2 drifted.
* live accuracy - once a day has been judged, score the predictions that
                 were made for it the evening before (Brier score). This is
                 the real test: did the model's chances match what happened?

Either one triggers retraining in `train.py`, but retraining never puts a
model live on its own: the champion gate decides that.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

DRIFT_COLS = ["hour", "weekday", "headway_min", "duration_min", "n_stops", "route_rate_7d", "route_hour_rate_14d",
              "dep_rate_14d", "op_rate_7d"]
PSI_WARN, PSI_DRIFT = 0.1, 0.2
EPS = 1e-4


def reference_from(feats: pd.DataFrame, bins: int = 10, max_levels: int = 30) -> dict:
    """Per feature: the training shares, by value for features with few
    distinct values (hour, weekday, headway…), else by quantile bins with open
    ends so values outside the training range are caught."""
    ref = {}
    for c in DRIFT_COLS:
        x = feats[c].astype(float).dropna().to_numpy()
        if len(x) == 0:
            continue
        levels = np.unique(x)
        if len(levels) <= max_levels:
            ref[c] = {"kind": "values", "values": levels.tolist(), "share": _value_shares(x, levels).tolist()}
        else:
            inner = np.unique(np.quantile(x, np.linspace(0, 1, bins + 1))[1:-1])
            ref[c] = {"kind": "bins", "edges": inner.tolist(), "share": _bin_shares(x, inner).tolist()}
    return ref


def _value_shares(x: np.ndarray, levels: np.ndarray) -> np.ndarray:
    # one bucket per training value + one for values never seen in training
    idx = np.searchsorted(levels, x)
    known = (idx < len(levels)) & (levels[np.minimum(idx, len(levels) - 1)] == x)
    counts = np.bincount(np.where(known, idx, len(levels)), minlength=len(levels) + 1).astype(float)
    return counts / max(1.0, counts.sum())


def _bin_shares(x: np.ndarray, inner: np.ndarray) -> np.ndarray:
    # open-ended bins: (-inf, e0), [e0, e1), …, [e_last, inf)
    counts = np.bincount(np.searchsorted(inner, x, side="right"), minlength=len(inner) + 1).astype(float)
    return counts / max(1.0, counts.sum())


def psi(reference: dict, feats: pd.DataFrame) -> dict:
    """PSI per feature between the training reference and `feats`."""
    out = {}
    for c, r in reference.items():
        if c not in feats:
            continue
        x = feats[c].astype(float).dropna().to_numpy()
        if len(x) == 0:
            continue
        p = np.clip(np.asarray(r["share"]), EPS, None)
        q = _value_shares(x, np.asarray(r["values"])) if r["kind"] == "values" else _bin_shares(x, np.asarray(r["edges"]))
        q = np.clip(q, EPS, None)
        out[c] = round(float(np.sum((q - p) * np.log(q / p))), 4)
    return out


def score_predictions(predictions: pd.DataFrame, results: pd.DataFrame) -> dict | None:
    """Brier score of stored predictions against the verdicts for that day.
    predictions: trip_id, p_runs, model_version. results: one day's verdicts."""
    j = results[results.verdict.isin(["ran_tracked", "ran_matched", "ghost"])][["trip_id", "verdict"]]
    m = predictions.merge(j, on="trip_id")
    if m.empty:
        return None
    y = (m.verdict == "ghost").astype(float).to_numpy()
    p_ghost = 1 - m.p_runs.astype(float).to_numpy()
    return {"n": int(len(m)), "brier": round(float(np.mean((p_ghost - y) ** 2)), 5),
            "ghost_rate": round(float(y.mean()), 4), "predicted_ghost_rate": round(float(p_ghost.mean()), 4),
            "model_version": str(m.model_version.iloc[0]) if "model_version" in m else ""}
