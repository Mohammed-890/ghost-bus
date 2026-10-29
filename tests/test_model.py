"""The model pipeline on synthetic days with a planted pattern.

This only checks the plumbing (no leakage, it can find a real signal).
Reported results come from real data only.
"""
from datetime import date, timedelta

import numpy as np
import pandas as pd

from ghostbus.model import add_features, evaluate


def synthetic(days=21, seed=0):
    rng = np.random.default_rng(seed)
    rows = []
    for d in range(days):
        day = date(2026, 11, 2) + timedelta(days=d)
        for route, op, base in [("52", "Stagecoach", 0.02), ("7", "First", 0.04), ("88", "TM Travel", 0.15)]:
            for start in range(6 * 3600, 23 * 3600, 900):
                p = base
                if route == "52" and 7 * 3600 <= start < 9 * 3600:
                    p = 0.35                      # planted: route 52 rush hour is unreliable
                rows.append(dict(trip_id=f"{route}-{start}-{d}", route=route, route_id=route, operator=op,
                                 agency_id=op, direction_id="0", start_secs=start, end_secs=start + 2400, n_stops=20,
                                 service_date=day, verdict="ghost" if rng.random() < p else "ran_tracked"))
    return pd.DataFrame(rows)


def test_history_features_never_see_the_same_day():
    df = synthetic(days=5)
    f = add_features(df)
    first = f[f.service_date == df.service_date.min()]
    # nothing to learn from on day one, so every rate is the prior
    assert first.route_rate_7d.nunique() == 1 and (first.dep_obs_14d == 0).all()


def test_model_beats_constant_and_is_reported_honestly():
    r = evaluate(synthetic())
    assert r["status"] == "ready"
    assert r["model"]["brier"] < r["constant"]["brier"]
    assert r["model"]["roc_auc"] > 0.7
    assert r["test_days"][0] > r["train_days"][1]          # test is strictly later than train


def test_not_enough_data_says_so():
    assert evaluate(synthetic(days=3))["status"] == "collecting"
