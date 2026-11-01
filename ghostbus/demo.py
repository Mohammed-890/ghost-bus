"""Seed a demo champion from SYNTHETIC data, for CI and local trials only.

    MLFLOW_TRACKING_URI=http://localhost:5000 python -m ghostbus.demo

The live system never uses this: its models are trained on real verdicts.
The synthetic days plant one pattern (route 52 is unreliable 07:00-09:00) so
a working model is easy to check by eye.
"""
from __future__ import annotations

import json
from datetime import date, timedelta

import numpy as np
import pandas as pd


def synthetic(days: int = 21, seed: int = 0, first_day: date = date(2026, 11, 2)) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    for d in range(days):
        day = first_day + timedelta(days=d)
        for route, op, base in [("52", "Stagecoach", 0.02), ("7", "First", 0.04), ("88", "TM Travel", 0.15)]:
            for start in range(6 * 3600, 23 * 3600, 900):
                p = 0.35 if route == "52" and 7 * 3600 <= start < 9 * 3600 else base
                rows.append(dict(trip_id=f"{route}-{start}-{d}", route=route, route_id=route, operator=op,
                                 agency_id=op, direction_id="0", start_secs=start, end_secs=start + 2400, n_stops=20,
                                 service_date=day, verdict="ghost" if rng.random() < p else "ran_tracked"))
    return pd.DataFrame(rows)


def schedule_from(results: pd.DataFrame, day: date) -> pd.DataFrame:
    s = results[results.service_date == results.service_date.min()].drop(columns=["verdict"]).copy()
    s["service_date"] = day.isoformat()
    s["from_stop"], s["to_stop"] = "Demo stop A", "Demo stop B"
    return s


def main():
    from . import train
    from .registry import get_registry

    res = synthetic(days=21)
    decision = train.run(res, schedule_from(res, max(res.service_date) + timedelta(days=1)), get_registry(), force=True)
    print(json.dumps({k: v for k, v in decision.items() if k != "report"}, default=str))
    if decision.get("action") != "promoted":
        raise SystemExit("demo model was not promoted")


if __name__ == "__main__":
    main()
