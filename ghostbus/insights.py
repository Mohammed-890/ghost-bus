"""Per-stop ghost records for the website.

stops.json  for every stop: how many judged buses were due there and how many never came, for all days and the
            last 7. A ghost bus counts at every stop it was timetabled to serve. Shown on each stop page.
"""
from __future__ import annotations

from datetime import timedelta

import pandas as pd

from . import config as C

JUDGED = ["ran_tracked", "ran_matched", "ghost"]


# ---------------------------------------------------------------- stops: where buses vanish
def build_stops(results: pd.DataFrame, min_n: int = 20) -> dict:
    """For every stop: how many judged buses were due there, and how many never came, all days and the last 7."""
    j = results[results.verdict.isin(JUDGED)][["trip_id", "verdict", "service_date"]]
    path = C.DATA / "city_gtfs" / "stop_times.csv.gz"
    spath = C.DATA / "city_gtfs" / "stops.csv"
    if j.empty or not path.exists() or not spath.exists():
        return {}
    st = pd.read_csv(path, usecols=["trip_id", "stop_id"], dtype=str)
    st = st[st.trip_id.isin(set(j.trip_id))].drop_duplicates()
    last = max(j.service_date)
    j = j.assign(g=(j.verdict == "ghost").astype(int), w=(j.service_date > last - timedelta(days=7)).astype(int))
    m = st.merge(j[["trip_id", "g", "w"]], on="trip_id")
    m["g7"] = m.g * m.w
    a = m.groupby("stop_id").agg(n=("g", "size"), g=("g", "sum"), n7=("w", "sum"), g7=("g7", "sum")).reset_index()
    a = a[a.n >= min_n]
    stops = pd.read_csv(spath, dtype={"stop_id": str})[["stop_id", "stop_name", "stop_lat", "stop_lon"]]
    a = a.merge(stops, on="stop_id")
    rows = [[r.stop_id, r.stop_name, round(float(r.stop_lat), 5), round(float(r.stop_lon), 5), int(r.n), int(r.g), int(r.n7), int(r.g7)]
            for r in a.sort_values("g", ascending=False).itertuples()]
    return {"from": str(min(j.service_date)), "to": str(last), "fields": ["id", "name", "lat", "lon", "n", "ghosts", "n7", "ghosts7"], "stops": rows}


def build_all(results: pd.DataFrame, write) -> dict:
    """Write stops.json with publish's writer. A failure here must never stop the main site data."""
    if results.empty:
        return {}
    try:
        write("stops.json", build_stops(results))
        return {"stops.json": True}
    except Exception as e:
        print("stops.json failed:", e)
        return {}
