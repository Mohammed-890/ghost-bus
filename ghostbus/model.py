"""Predict the chance a scheduled bus actually runs, and test that honestly.

Only judged trips are used (ran or ghost; "unknown" is left out). Every
history feature for a day is computed from earlier days only, and the test
set is the most recent days, so the model is always predicting the future.

Compared against:
  * constant   - every trip gets the overall ghost rate from training days
  * history    - this departure's past ghost rate (falls back to the route,
                 then the overall rate) - what a careful human would do

A trained model travels as a `ModelBundle`: the classifier plus everything
needed to build its features later (rate tables, the timetable, the
categories it saw, and a reference sample for drift checks). The registry
stores bundles; the API and the daily forecast load them.
"""
from __future__ import annotations

import glob
import json
from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score

from . import config as C
from .features import CAT, FEATURES, NUM, add_features, apply_tables, base_columns, compute_tables, departures_table, judged

WARMUP_DAYS = 3          # a model needs some history before features mean anything
MIN_DAYS, MIN_GHOSTS = 7, 30


# ------------------------------------------------------------------ data
def load_results() -> pd.DataFrame:
    files = sorted(glob.glob(str(C.RESULTS / "*.csv.gz")))
    if not files:
        return pd.DataFrame()
    df = pd.concat([pd.read_csv(f, dtype={"trip_id": str, "route": str, "route_id": str, "direction_id": str,
                                          "agency_id": str, "vehicle_id": str}) for f in files], ignore_index=True)
    df["service_date"] = pd.to_datetime(df.service_date).dt.date
    return df


def training_frame(results: pd.DataFrame) -> pd.DataFrame:
    """Judged trips with features and the label `y` (1 = ghost)."""
    j = results[results.verdict.isin(["ran_tracked", "ran_matched", "ghost"])].copy()
    if j.empty:
        return j
    feats = add_features(j)
    feats["y"] = (feats.verdict == "ghost").astype(int)
    return feats[feats.service_date >= min(feats.service_date) + timedelta(days=WARMUP_DAYS)]


def enough_data(results: pd.DataFrame) -> tuple[bool, dict]:
    j = results[results.verdict.isin(["ran_tracked", "ran_matched", "ghost"])] if len(results) else results
    days = len(set(j.service_date)) if len(j) else 0
    ghosts = int((j.verdict == "ghost").sum()) if len(j) else 0
    return days >= MIN_DAYS and ghosts >= MIN_GHOSTS, {"days": days, "ghosts": ghosts}


# ------------------------------------------------------------------ model
def make_classifier():
    # Shallow, strongly regularised trees. Chosen by comparing settings on
    # 15 synthetic runs (5 seeds x 14/21/28 days): the earlier, deeper model
    # (31 leaves, 300 rounds) lost to the departure-history baseline in all 15;
    # this one beat both baselines in all 15.
    return HistGradientBoostingClassifier(max_iter=150, learning_rate=0.03, max_depth=3, min_samples_leaf=200,
                                          l2_regularization=5.0, categorical_features="from_dtype", random_state=0)


def X_with(df: pd.DataFrame, categories: dict) -> pd.DataFrame:
    """Feature matrix with categories fixed to the ones seen in training, so
    codes mean the same thing at train and predict time (unseen = missing)."""
    X = df[FEATURES].copy()
    for c in CAT:
        v = X[c].astype(str)
        X[c] = pd.Categorical(v.where(v.isin(categories[c])), categories=categories[c])
    for c in NUM:
        X[c] = X[c].astype(float)
    return X


def categories_of(df: pd.DataFrame) -> dict:
    return {c: sorted(df[c].astype(str).unique().tolist()) for c in CAT}


def fit_classifier(feats: pd.DataFrame):
    cats = categories_of(feats)
    clf = make_classifier().fit(X_with(feats, cats), feats.y)
    return clf, cats


def metrics(y, p) -> dict:
    y, p = np.asarray(y), np.asarray(p)
    m = {"brier": round(float(brier_score_loss(y, p)), 5),
         "log_loss": round(float(log_loss(y, np.clip(p, 1e-4, 1 - 1e-4), labels=[0, 1])), 4)}
    if 0 < y.sum() < len(y):
        m["roc_auc"] = round(float(roc_auc_score(y, p)), 3)
        m["avg_precision"] = round(float(average_precision_score(y, p)), 3)
        top = np.argsort(-p)[: max(1, len(p) // 10)]
        m["ghosts_in_riskiest_10pct"] = round(float(y[top].sum() / y.sum()), 3)
    return m


@dataclass
class ModelBundle:
    classifier: object
    categories: dict
    tables: dict
    departures: pd.DataFrame
    reference: dict = field(default_factory=dict)   # drift reference (see drift.py)
    meta: dict = field(default_factory=dict)        # version, trained_through, metrics, …

    def predict_ghost(self, feats: pd.DataFrame) -> np.ndarray:
        return self.classifier.predict_proba(X_with(feats, self.categories))[:, 1]

    def features_for_departures(self, rows: pd.DataFrame, service_date: date) -> pd.DataFrame:
        """Rows from `departures` (headway already set) → model features."""
        rows = rows.assign(service_date=service_date)
        return apply_tables(base_columns(rows, headway_from_schedule=False), self.tables)

    def predict_departure(self, route: str, direction_id: str, start_secs: int, service_date: date) -> dict | None:
        d = self.departures
        hit = d[(d.route == str(route)) & (d.direction_id == str(direction_id)) & (d.start_secs == int(start_secs))]
        if hit.empty:
            return None
        f = self.features_for_departures(hit.head(1), service_date)
        p_ghost = float(self.predict_ghost(f)[0])
        r = hit.iloc[0]
        return {"route": r.route, "operator": r.operator, "direction_id": r.direction_id,
                "from_stop": r.from_stop, "to_stop": r.to_stop, "p_runs": round(1 - p_ghost, 4)}


# ------------------------------------------------------------------ evaluation
def split(feats: pd.DataFrame, cut: date | None = None):
    days = sorted(set(feats.service_date))
    cut = cut or days[int(len(days) * 0.7)]
    return feats[feats.service_date < cut], feats[feats.service_date >= cut], cut


def evaluate_split(tr: pd.DataFrame, te: pd.DataFrame) -> tuple[dict, object, dict]:
    y = te.y.to_numpy()
    const = np.full(len(te), tr.y.mean())
    hist = np.where(te.dep_obs_14d >= 3, te.dep_rate_14d, te.route_rate_7d)
    clf, cats = fit_classifier(tr)
    pm = clf.predict_proba(X_with(te, cats))[:, 1]
    bins = np.linspace(0, 1, 11)
    which = np.clip(np.digitize(pm, bins) - 1, 0, 9)
    calib = [{"predicted": round(float(pm[which == b].mean()), 3), "actual": round(float(y[which == b].mean()), 3),
              "n": int((which == b).sum())} for b in range(10) if (which == b).sum() >= 20]
    report = {
        "status": "ready",
        "train_days": [str(tr.service_date.min()), str(tr.service_date.max())],
        "test_days": [str(te.service_date.min()), str(te.service_date.max())],
        "n_train": int(len(tr)), "n_test": int(len(te)), "test_ghost_rate": round(float(y.mean()), 4),
        "constant": metrics(y, const), "history": metrics(y, hist), "model": metrics(y, pm),
        "calibration": calib,
    }
    return report, clf, cats


def evaluate(results: pd.DataFrame, min_days: int = MIN_DAYS, min_ghosts: int = MIN_GHOSTS) -> dict:
    j = results[results.verdict.isin(["ran_tracked", "ran_matched", "ghost"])]
    days, ghosts = len(set(j.service_date)), int((j.verdict == "ghost").sum())
    if days < min_days or ghosts < min_ghosts:
        return {"status": "collecting", "days": days, "ghosts": ghosts,
                "needs": f"at least {min_days} days and {min_ghosts} ghost buses"}
    tr, te, _ = split(training_frame(results))
    return evaluate_split(tr, te)[0]


# ------------------------------------------------------------------ production fit
def fit_bundle(results: pd.DataFrame, schedule: pd.DataFrame, meta: dict | None = None) -> ModelBundle:
    """Fit on every judged day; rate tables as of the day after the last one."""
    from .drift import reference_from

    feats = training_frame(results)
    clf, cats = fit_classifier(feats)
    last = max(feats.service_date)
    return ModelBundle(
        classifier=clf, categories=cats,
        tables=compute_tables(judged(results), last + timedelta(days=1)),
        departures=departures_table(schedule),
        reference=reference_from(feats),
        meta={"trained_through": str(last), "n_train": int(len(feats)), **(meta or {})},
    )


def forecast(bundle: ModelBundle, schedule: pd.DataFrame, results: pd.DataFrame) -> pd.DataFrame:
    """Chance each trip in `schedule` (a day_schedule table) runs, with rate
    tables rebuilt from all results before that day."""
    day = pd.to_datetime(schedule.service_date.iloc[0]).date()
    t = base_columns(schedule)
    t = apply_tables(t, compute_tables(judged(results), day))
    t["p_runs"] = 1 - bundle.predict_ghost(t)
    return t


if __name__ == "__main__":
    print(json.dumps(evaluate(load_results()), indent=2, default=str))
