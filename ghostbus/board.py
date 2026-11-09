"""Live departure board for the website.

Two files are published:

* ``board/<day>.json`` – today's timetable, written once per service day: every
  departure (duplicate timetable copies removed), the stops it calls at in the city
  and when. It is the big file, so it is only rewritten when the timetable changes.
* ``status.json`` – rewritten every collector round: one letter per departure in the
  same order, plus where tracked buses are right now. It is a few kilobytes.

Status letters
  S  scheduled, not due yet
  P  due or under way, not confirmed yet (some operators only show up by position,
     which is checked once the trip has finished)
  O  on the road now: a bus is reporting this trip
  R  ran: a bus was seen doing it
  G  never came: no bus seen, while the feed and the operator were both reporting
  N  can't be checked (operator not reporting, feed gap, or too little of the trip in the city)

R and G use the same matching as the daily results, so the board and the published
figures agree; the daily job's verdict (an hour later) is the final word.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

from . import config as C
from . import match

SETTLE_SECS = (C.LATE_MIN + 5) * 60   # judge a trip once even a late bus would have finished
LIVE_MAX_AGE = 600                     # a report older than 10 minutes is not "on the road now"


def service_day(now: datetime | None = None) -> date:
    """Buses after midnight still belong to the previous day's timetable until about 4am."""
    now = (now or datetime.now(C.TZ)).astimezone(C.TZ)
    return (now - timedelta(hours=4)).date()


def _agency_map() -> dict:
    t, r = C.DATA / "city_gtfs" / "trips.csv", C.DATA / "city_gtfs" / "routes.csv"
    if not (t.exists() and r.exists()):
        return {}
    t, r = pd.read_csv(t, dtype=str), pd.read_csv(r, dtype=str)
    return dict(zip(t.trip_id, t.route_id.map(dict(zip(r.route_id, r.agency_id)))))


def _stop_names() -> dict:
    p = C.DATA / "city_gtfs" / "stops.csv"
    if not p.exists():
        return {}
    s = pd.read_csv(p, dtype=str)
    return dict(zip(s.stop_id, s.stop_name))


def departures(trips: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """One row per real departure, in a fixed order, and the alias of every duplicate trip id."""
    trips = trips.copy()
    trips["direction_id"] = trips.direction_id.fillna("").astype(str)
    key = ["operator", "route", "direction_id", "start_secs", "from_stop"]
    canon = trips.groupby(key, dropna=False, sort=False).trip_id.transform("first")
    alias = dict(zip(trips.trip_id, canon))
    deps = trips[trips.trip_id == canon].sort_values(["route", "operator", "direction_id", "start_secs", "trip_id"])
    return deps.reset_index(drop=True), alias


def timetable(day: date, deps: pd.DataFrame, stop_times: pd.DataFrame) -> dict:
    names = _stop_names()
    st = stop_times[stop_times.trip_id.isin(set(deps.trip_id))].sort_values(["trip_id", "stop_sequence"])
    stop_ids = sorted(set(st.stop_id))
    sidx = {s: i for i, s in enumerate(stop_ids)}
    first = st.drop_duplicates("stop_id").set_index("stop_id")
    stops = [[names.get(s, s), round(float(first.at[s, "stop_lat"]), 5), round(float(first.at[s, "stop_lon"]), 5)] for s in stop_ids]
    routes, ridx = [], {}
    calls = {k: g for k, g in st.groupby("trip_id")}
    rows = []
    for d in deps.itertuples():
        rk = (str(d.route), str(d.operator))
        if rk not in ridx:
            ridx[rk] = len(routes)
            routes.append([rk[0], rk[1], f"{rk[0]}-{rk[1]}"])
        g = calls.get(d.trip_id)
        seq = []
        if g is not None:
            for s, secs in zip(g.stop_id, g.secs):
                seq += [sidx[s], int(round((int(secs) - int(d.start_secs)) / 60))]
        rows.append([ridx[rk], str(d.direction_id), int(d.start_secs), int(d.end_secs),
                     str(d.from_stop or ""), str(d.to_stop or ""), seq])
    body = {"day": day.isoformat(), "stops": stops, "routes": routes, "trips": rows}
    body["version"] = hashlib.sha1(json.dumps([routes, [r[:4] for r in rows]]).encode()).hexdigest()[:10]
    return body


def status(day: date, deps: pd.DataFrame, alias: dict, verdicts: pd.DataFrame, pings: pd.DataFrame,
           now_ts: float) -> tuple[str, list, dict]:
    t0 = match.secs_to_dt(day, 0).timestamp()
    now_secs = now_ts - t0
    v = dict(zip(verdicts.trip_id, verdicts.verdict))
    reason = dict(zip(verdicts.trip_id, verdicts.reason))

    # buses reporting a trip right now (duplicate timetable ids folded onto the departure)
    live = {}
    if not pings.empty and "trip_id" in pings:
        p = pings.dropna(subset=["trip_id"])
        p = p[p.trip_id.astype(str) != ""]
        p = p[(now_ts - p.ts.astype(float)) <= LIVE_MAX_AGE]
        if not p.empty:
            p = p.assign(dep=p.trip_id.map(alias)).dropna(subset=["dep"]).sort_values("ts")
            for r in p.drop_duplicates("dep", keep="last").itertuples():
                live[r.dep] = [round(float(r.lat), 5), round(float(r.lon), 5), int((now_ts - float(r.ts)) // 60)]

    letters, buses, counts = [], [], {}
    for i, d in enumerate(deps.itertuples()):
        verdict = v.get(d.trip_id, "unknown")
        if d.trip_id in live and d.start_secs - 1800 <= now_secs <= d.end_secs + SETTLE_SECS:
            c = "O"
            buses.append([i, *live[d.trip_id]])
        elif verdict in ("ran_tracked", "ran_matched"):
            c = "R"
        elif verdict == "ghost":
            c = "G"
        elif reason.get(d.trip_id, "").startswith("not finished"):
            c = "S" if d.start_secs > now_secs else "P"
        else:
            c = "N"
        letters.append(c)
        counts[c] = counts.get(c, 0) + 1
    return "".join(letters), buses, counts


def publish(now: datetime | None = None) -> dict | None:
    """Write today's board (if new) and the live status. Returns the counts, or None if there's no timetable yet."""
    from .publish import _w  # local import: publish imports this module

    now = (now or datetime.now(C.TZ)).astimezone(C.TZ)
    day = service_day(now)
    if not (C.SCHEDULE / day.isoformat() / "trips.csv.gz").exists():
        return None
    trips, stop_times, pings, health = match.load_day(day)
    deps, alias = departures(trips)
    board_path = C.SITE_DATA / "board" / f"{day.isoformat()}.json"
    body = timetable(day, deps, stop_times)
    old = None
    if board_path.exists():
        try:
            old = json.loads(board_path.read_text()).get("version")
        except ValueError:
            old = None
    if old != body["version"]:
        _w(f"board/{day.isoformat()}.json", body)
    for f in (C.SITE_DATA / "board").glob("*.json"):  # keep today and yesterday only
        if f.stem < (day - timedelta(days=1)).isoformat():
            f.unlink()

    verdicts = match.classify(day, trips, stop_times, pings, health, _agency_map(), settle_secs=SETTLE_SECS)
    letters, buses, counts = status(day, deps, alias, verdicts, pings, now.timestamp())
    _w("status.json", {"day": day.isoformat(), "version": body["version"], "at": now.isoformat(timespec="minutes"),
                       "status": letters, "live": buses, "counts": counts})
    return counts


if __name__ == "__main__":
    print(publish())
