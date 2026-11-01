"""Model features, shared by training and serving.

Training and the prediction API call exactly these functions, so a trip
gets the same features whichever path asks (no training/serving skew):

    base_columns(trips)            things known from the timetable alone
    compute_tables(history, day)   ghost rates learned from days before `day`
    apply_tables(trips, tables)    joins those rates onto the trips

`add_features` runs the three for every day of a results table, so history
for day D only ever comes from days before D.
"""
from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pandas as pd

JUDGED = ["ran_tracked", "ran_matched", "ghost"]
CAT = ["route", "operator", "direction_id"]
NUM = ["hour", "weekday", "headway_min", "duration_min", "n_stops", "route_rate_7d", "route_hour_rate_14d",
       "dep_rate_14d", "dep_obs_14d", "op_rate_7d"]
FEATURES = CAT + NUM
DEFAULT_PRIOR = 0.05
SMOOTHING = 5.0


def as_dates(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s).dt.date


def judged(df: pd.DataFrame) -> pd.DataFrame:
    """Only trips with a verdict, plus a 0/1 ghost column and the hour."""
    h = df[df.verdict.isin(JUDGED)].copy()
    h["service_date"] = as_dates(h.service_date)
    h["g"] = (h.verdict == "ghost").astype(float)
    h["hour"] = (h.start_secs // 3600).astype(int)
    h["route"] = h.route.astype(str)
    h["direction_id"] = h.direction_id.fillna("").astype(str)
    return h


def base_columns(df: pd.DataFrame, headway_from_schedule: bool = True) -> pd.DataFrame:
    """Columns that come from the timetable and the date only."""
    df = df.copy()
    df["route"] = df.route.astype(str)
    df["operator"] = df.operator.astype(str)
    df["direction_id"] = df.direction_id.fillna("").astype(str)
    df["hour"] = (df.start_secs // 3600).astype(int)
    df["weekday"] = pd.to_datetime(df.service_date).dt.weekday
    df["duration_min"] = (df.end_secs - df.start_secs) / 60
    if headway_from_schedule:
        df = df.sort_values(["service_date", "route", "direction_id", "start_secs"])
        prev = df.groupby(["service_date", "route", "direction_id"]).start_secs.shift()
        df["headway_min"] = ((df.start_secs - prev) / 60).fillna(120).clip(upper=180)
    return df


def compute_tables(hist: pd.DataFrame, day: date) -> dict:
    """Ghost rates from judged history strictly before `day`."""
    day = pd.Timestamp(day).date()
    before = hist[hist.service_date < day]
    h7 = before[before.service_date >= day - timedelta(days=7)]
    h14 = before[before.service_date >= day - timedelta(days=14)]
    agg = lambda t, keys: t.groupby(keys).g.agg(["sum", "count"])  # noqa: E731
    return {
        "as_of": day,
        "prior": float(before.g.mean()) if len(before) else DEFAULT_PRIOR,
        "route_7d": agg(h7, ["route"]),
        "op_7d": agg(h7, ["operator"]),
        "route_hour_14d": agg(h14, ["route", "hour"]),
        "dep_14d": agg(h14, ["route", "direction_id", "start_secs"]),
    }


def _smoothed(ghosts, n, prior):
    return (ghosts + SMOOTHING * prior) / (n + SMOOTHING)


def _look(tbl: pd.DataFrame, part: pd.DataFrame, keys: list[str]):
    idx = pd.MultiIndex.from_frame(part[keys]) if len(keys) > 1 else pd.Index(part[keys[0]])
    s = tbl.reindex(idx)
    return s["sum"].fillna(0).to_numpy(), s["count"].fillna(0).to_numpy()


def apply_tables(part: pd.DataFrame, tables: dict) -> pd.DataFrame:
    part = part.copy()
    prior = tables["prior"]
    g, n = _look(tables["route_7d"], part, ["route"])
    part["route_rate_7d"] = _smoothed(g, n, prior)
    g, n = _look(tables["op_7d"], part, ["operator"])
    part["op_rate_7d"] = _smoothed(g, n, prior)
    g, n = _look(tables["route_hour_14d"], part, ["route", "hour"])
    part["route_hour_rate_14d"] = _smoothed(g, n, prior)
    g, n = _look(tables["dep_14d"], part, ["route", "direction_id", "start_secs"])
    part["dep_rate_14d"] = _smoothed(g, n, part.route_rate_7d.to_numpy())
    part["dep_obs_14d"] = n
    return part


def add_features(df: pd.DataFrame, history: pd.DataFrame | None = None) -> pd.DataFrame:
    """df: trips to describe. history: results to learn rates from (defaults
    to df). Rates for day D only use history from days before D."""
    hist = judged(df if history is None else history)
    df = base_columns(df.assign(service_date=as_dates(df.service_date)))
    out = [apply_tables(df[df.service_date == d], compute_tables(hist, d)) for d in sorted(set(df.service_date))]
    return pd.concat(out) if out else df


def to_X(df: pd.DataFrame) -> pd.DataFrame:
    X = df[FEATURES].copy()
    for c in CAT:
        X[c] = X[c].astype("category")
    for c in NUM:
        X[c] = X[c].astype(float)
    return X


def departures_table(schedule: pd.DataFrame) -> pd.DataFrame:
    """The timetable as the API needs it: one row per departure, with the
    headway already worked out the same way training does."""
    s = schedule.copy()
    if "service_date" not in s:
        s["service_date"] = date.today().isoformat()
    s = base_columns(s)
    cols = ["route", "operator", "direction_id", "start_secs", "end_secs", "n_stops", "headway_min", "from_stop", "to_stop"]
    for c in cols:
        if c not in s:
            s[c] = np.nan
    return s[cols].drop_duplicates(["route", "direction_id", "start_secs"]).reset_index(drop=True)
