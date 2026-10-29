"""Predict the chance a scheduled bus actually runs, and test that honestly.

Only judged trips are used (ran or ghost; "unknown" is left out). Every
history feature for a day is computed from earlier days only, and the test
set is the most recent days, so the model is always predicting the future.

Compared against:
  * constant   - every trip gets the overall ghost rate from training days
  * history    - this departure's past ghost rate (falls back to the route,
                 then the overall rate) - what a careful human would do
"""
from __future__ import annotations

import glob
import json
from datetime import date, timedelta

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score

from . import config as C

CAT = ["route", "operator", "direction_id"]
NUM = ["hour", "weekday", "headway_min", "duration_min", "n_stops", "route_rate_7d", "route_hour_rate_14d",
       "dep_rate_14d", "dep_obs_14d", "op_rate_7d"]


def load_results() -> pd.DataFrame:
    files = sorted(glob.glob(str(C.RESULTS / "*.csv.gz")))
    if not files:
        return pd.DataFrame()
    df = pd.concat([pd.read_csv(f, dtype={"trip_id": str, "route": str, "route_id": str, "direction_id": str,
                                          "agency_id": str, "vehicle_id": str}) for f in files], ignore_index=True)
    df["service_date"] = pd.to_datetime(df.service_date).dt.date
    return df


def _smoothed(ghosts, n, prior, k=5.0):
    return (ghosts + k * prior) / (n + k)


def add_features(df: pd.DataFrame, history: pd.DataFrame | None = None) -> pd.DataFrame:
    """df: trips to describe. history: judged trips to learn rates from
    (defaults to df). Rates for day D only use history from days < D."""
    df = df.copy()
    hist = (df if history is None else history)
    hist = hist[hist.verdict.isin(["ran_tracked", "ran_matched", "ghost"])].copy()
    hist["g"] = (hist.verdict == "ghost").astype(float)
    hist["hour"] = (hist.start_secs // 3600).astype(int)
    prior = hist.g.mean() if len(hist) else 0.05

    df["route"] = df.route.astype(str)
    df["direction_id"] = df.direction_id.fillna("").astype(str)
    df["hour"] = (df.start_secs // 3600).astype(int)
    df["weekday"] = pd.to_datetime(df.service_date).dt.weekday
    df["duration_min"] = (df.end_secs - df.start_secs) / 60
    df = df.sort_values(["service_date", "route", "direction_id", "start_secs"])
    prev = df.groupby(["service_date", "route", "direction_id"]).start_secs.shift()
    df["headway_min"] = ((df.start_secs - prev) / 60).fillna(120).clip(upper=180)

    days = sorted(set(df.service_date))
    out = []
    for d in days:
        part = df[df.service_date == d].copy()
        h7 = hist[(hist.service_date < d) & (hist.service_date >= d - timedelta(days=7))]
        h14 = hist[(hist.service_date < d) & (hist.service_date >= d - timedelta(days=14))]
        r7 = h7.groupby("route").g.agg(["sum", "count"])
        o7 = h7.groupby("operator").g.agg(["sum", "count"])
        rh = h14.groupby(["route", "hour"]).g.agg(["sum", "count"])
        dep = h14.groupby(["route", "direction_id", "start_secs"]).g.agg(["sum", "count"])

        def look(tbl, keys):
            idx = pd.MultiIndex.from_frame(part[keys]) if len(keys) > 1 else part[keys[0]]
            s = tbl.reindex(idx)
            return s["sum"].fillna(0).to_numpy(), s["count"].fillna(0).to_numpy()

        g, n = look(r7, ["route"]); part["route_rate_7d"] = _smoothed(g, n, prior)
        g, n = look(o7, ["operator"]); part["op_rate_7d"] = _smoothed(g, n, prior)
        g, n = look(rh, ["route", "hour"]); part["route_hour_rate_14d"] = _smoothed(g, n, prior)
        g, n = look(dep, ["route", "direction_id", "start_secs"])
        part["dep_rate_14d"] = _smoothed(g, n, part.route_rate_7d.to_numpy())
        part["dep_obs_14d"] = n
        out.append(part)
    return pd.concat(out) if out else df


def _model():
    return HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=40,
                                          l2_regularization=1.0, categorical_features="from_dtype", random_state=0)


def _X(df):
    X = df[CAT + NUM].copy()
    for c in CAT:
        X[c] = X[c].astype("category")
    return X


def _metrics(y, p):
    m = {"brier": round(float(brier_score_loss(y, p)), 5), "log_loss": round(float(log_loss(y, np.clip(p, 1e-4, 1 - 1e-4), labels=[0, 1])), 4)}
    if 0 < y.sum() < len(y):
        m["roc_auc"] = round(float(roc_auc_score(y, p)), 3)
        m["avg_precision"] = round(float(average_precision_score(y, p)), 3)
        top = np.argsort(-p)[: max(1, len(p) // 10)]
        m["ghosts_in_riskiest_10pct"] = round(float(y[top].sum() / y.sum()), 3)
    return m


def evaluate(df: pd.DataFrame, min_days: int = 7, min_ghosts: int = 30) -> dict:
    judged = df[df.verdict.isin(["ran_tracked", "ran_matched", "ghost"])].copy()
    days = sorted(set(judged.service_date))
    n_ghosts = int((judged.verdict == "ghost").sum())
    if len(days) < min_days or n_ghosts < min_ghosts:
        return {"status": "collecting", "days": len(days), "ghosts": n_ghosts,
                "needs": f"at least {min_days} days and {min_ghosts} ghost buses"}
    feats = add_features(judged)
    feats["y"] = (feats.verdict == "ghost").astype(int)
    feats = feats[feats.service_date >= days[0] + timedelta(days=3)]          # need some history first
    days = sorted(set(feats.service_date))
    cut = days[int(len(days) * 0.7)]
    tr, te = feats[feats.service_date < cut], feats[feats.service_date >= cut]
    y = te.y.to_numpy()

    const = np.full(len(te), tr.y.mean())
    hist = np.where(te.dep_obs_14d >= 3, te.dep_rate_14d, te.route_rate_7d)
    clf = _model().fit(_X(tr), tr.y)
    pm = clf.predict_proba(_X(te))[:, 1]

    bins = np.linspace(0, 1, 11)
    which = np.clip(np.digitize(pm, bins) - 1, 0, 9)
    calib = [{"predicted": round(float(pm[which == b].mean()), 3), "actual": round(float(y[which == b].mean()), 3),
              "n": int((which == b).sum())} for b in range(10) if (which == b).sum() >= 20]
    return {
        "status": "ready",
        "train_days": [str(tr.service_date.min()), str(tr.service_date.max())],
        "test_days": [str(te.service_date.min()), str(te.service_date.max())],
        "n_train": int(len(tr)), "n_test": int(len(te)), "test_ghost_rate": round(float(y.mean()), 4),
        "constant": _metrics(y, const), "history": _metrics(y, hist), "model": _metrics(y, pm),
        "calibration": calib,
    }


def forecast(df: pd.DataFrame, tomorrow: pd.DataFrame) -> pd.DataFrame:
    """Chance each trip in `tomorrow` (a day_schedule table) runs."""
    judged = df[df.verdict.isin(["ran_tracked", "ran_matched", "ghost"])].copy()
    feats = add_features(judged)
    feats["y"] = (feats.verdict == "ghost").astype(int)
    feats = feats[feats.service_date >= min(feats.service_date) + timedelta(days=3)]
    clf = _model().fit(_X(feats), feats.y)
    t = add_features(tomorrow.assign(verdict="?"), history=judged)
    t["p_runs"] = 1 - clf.predict_proba(_X(t))[:, 1]
    return t


if __name__ == "__main__":
    print(json.dumps(evaluate(load_results()), indent=2))
