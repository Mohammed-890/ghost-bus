"""Live departure board and live tracking for the website.

Published files
* ``board/<day>.json`` – today's timetable, written once per service day: every
  departure (duplicate timetable copies removed), its headsign, and the stops it
  calls at in the city with times. The big file, so only rewritten when it changes.
* ``status.json`` – one status letter per departure (same order) plus every
  departure that has a bus on it right now: how late it is and how far along.
* ``vehicles.json`` – every bus reporting right now, with its route, heading and,
  when known, the departure it is running.

The two small files are written every collector round to the site, and every couple
of minutes to the ``live`` branch (see ``python -m ghostbus.board --live``).

Status letters
  S  scheduled, not due yet
  P  due or under way, no bus found on it yet
  O  on the road now: a bus is on this departure (reported by the bus, or inferred
     from its route and position)
  R  ran: a bus was seen doing it
  G  never came: no bus seen, while the feed and the operator were both reporting
  N  can't be checked (operator not reporting, feed gap, or too little of the trip in the city)

Finding a bus's departure
  Many buses report the exact trip they are running. Others report only their route
  (or a trip id that isn't in the published timetable). For those, every departure of
  the same route that is under way is a candidate: the bus's position is projected onto
  the candidate's path, which gives the timetabled time at that point and so the delay.
  The bus is given the candidate it fits best (close to the path, believable delay), one
  bus per departure. R and G use the same matching as the daily results, so the board
  and the published figures agree; the daily job's verdict an hour later is final.
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

from . import config as C
from . import match

SETTLE_SECS = (C.LATE_MIN + 5) * 60   # judge a trip once even a late bus would have finished
LIVE_MAX_AGE = 600                     # a report older than 10 minutes is not "on the road now"
MAX_OFF_ROUTE_M = 300                  # an inferred bus must be this close to the departure's path
REPORTED_OFF_ROUTE_M = 800             # a bus reporting a trip gets more slack (stops can be sparse)
EARLY_LIMIT_MIN, LATE_LIMIT_MIN = -10, 45
W_DELAY, W_STEADY, W_BACK = 0.5, 2.0, 3.0   # how a candidate departure is scored (tuned on buses that report their trip)
HISTORY_SECS = 15 * 60                 # how much of a bus's recent track is used to tell departures apart


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


def _gtfs(name: str) -> pd.DataFrame:
    p = C.DATA / "city_gtfs" / name
    return pd.read_csv(p, dtype=str) if p.exists() else pd.DataFrame()


def departures(trips: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """One row per real departure, in a fixed order, and the alias of every duplicate trip id."""
    trips = trips.copy()
    trips["direction_id"] = trips.direction_id.fillna("").astype(str)
    key = ["operator", "route", "direction_id", "start_secs", "from_stop"]
    canon = trips.groupby(key, dropna=False, sort=False).trip_id.transform("first")
    alias = dict(zip(trips.trip_id, canon))
    deps = trips[trips.trip_id == canon].sort_values(["route", "operator", "direction_id", "start_secs", "trip_id"])
    return deps.reset_index(drop=True), alias


def _calls(deps: pd.DataFrame, stop_times: pd.DataFrame) -> dict:
    """trip_id -> (stop_ids, lats, lons, secs), in calling order. The board and the tracker share this order."""
    st = stop_times[stop_times.trip_id.isin(set(deps.trip_id))].copy()
    st["stop_sequence"] = pd.to_numeric(st.stop_sequence, errors="coerce")
    st = st.sort_values(["trip_id", "stop_sequence"])
    out = {}
    for tid, g in st.groupby("trip_id", sort=False):
        out[tid] = (list(g.stop_id.astype(str)), g.stop_lat.astype(float).to_numpy(), g.stop_lon.astype(float).to_numpy(),
                    g.secs.astype(float).to_numpy())
    return out


def timetable(day: date, deps: pd.DataFrame, calls: dict) -> dict:
    stops_df = _gtfs("stops.csv")
    names = dict(zip(stops_df.stop_id, stops_df.stop_name)) if not stops_df.empty else {}
    stop_ids = sorted({s for c in calls.values() for s in c[0]})
    sidx = {s: i for i, s in enumerate(stop_ids)}
    where = {}
    for c in calls.values():
        for s, la, lo in zip(c[0], c[1], c[2]):
            where.setdefault(s, (la, lo))
    stops = [[names.get(s, s), round(float(where[s][0]), 5), round(float(where[s][1]), 5)] for s in stop_ids]
    routes, ridx, rows = [], {}, []
    for d in deps.itertuples():
        rk = (str(d.route), str(d.operator))
        if rk not in ridx:
            ridx[rk] = len(routes)
            routes.append([rk[0], rk[1], f"{rk[0]}-{rk[1]}"])
        c = calls.get(d.trip_id)
        seq = []
        if c is not None:
            for s, secs in zip(c[0], c[3]):
                seq += [sidx[s], int(round((secs - float(d.start_secs)) / 60))]
        head = getattr(d, "trip_headsign", "")
        rows.append([ridx[rk], str(d.direction_id), int(d.start_secs), int(d.end_secs),
                     str(d.from_stop or ""), str(d.to_stop or ""), seq, head if isinstance(head, str) else ""])
    body = {"day": day.isoformat(), "stops": stops, "routes": routes, "trips": rows}
    body["version"] = hashlib.sha1(json.dumps([routes, [r[:4] for r in rows]]).encode()).hexdigest()[:10]
    return body


# ---------------------------------------------------------------- live tracking
def _xy(lat, lon, lat0):
    return np.asarray(lon) * 111_320.0 * math.cos(math.radians(lat0)), np.asarray(lat) * 110_540.0


def project(lat: float, lon: float, lats: np.ndarray, lons: np.ndarray, secs: np.ndarray, at_secs: float):
    """Where a bus is along a departure's path.

    Returns (metres off the path, timetabled seconds at that point, position as a fractional
    stop index). On routes that pass the same road twice, the point whose timetabled time is
    closest to `at_secs` wins (8 m of distance weighs the same as a minute of time)."""
    if len(lats) == 1:
        x, y = _xy([lat, lats[0]], [lon, lons[0]], lat)
        return float(math.hypot(x[0] - x[1], y[0] - y[1])), float(secs[0]), 0.0
    bx, by = _xy(lat, lon, lat)
    xs, ys = _xy(lats, lons, lat)
    ax, ay, cx, cy = xs[:-1], ys[:-1], xs[1:], ys[1:]
    dx, dy = cx - ax, cy - ay
    L2 = dx * dx + dy * dy
    t = np.where(L2 > 0, ((bx - ax) * dx + (by - ay) * dy) / np.where(L2 > 0, L2, 1), 0.0).clip(0, 1)
    px, py = ax + t * dx, ay + t * dy
    dist = np.hypot(bx - px, by - py)
    sched = secs[:-1] + t * (secs[1:] - secs[:-1])
    cost = dist + 8.0 * np.abs(sched - at_secs) / 60.0
    k = int(np.argmin(cost))
    return float(dist[k]), float(sched[k]), float(k + t[k])


def track(day: date, deps: pd.DataFrame, alias: dict, calls: dict, pings: pd.DataFrame, now_ts: float):
    """Give every bus reporting now the departure it's running, with its delay and progress.

    Returns (assigned: dict dep_index -> info, vehicles: list of every fresh bus)."""
    t0 = match.secs_to_dt(day, 0).timestamp()
    if pings.empty:
        return {}, []
    p = pings[pings.poll_ts == pings.poll_ts.max()].copy() if "poll_ts" in pings else pings.copy()
    p = p[(now_ts - p.ts.astype(float)) <= LIVE_MAX_AGE].sort_values("ts").drop_duplicates("vehicle_id", keep="last")
    if p.empty:
        return {}, []
    routes = _gtfs("routes.csv")
    short = dict(zip(routes.route_id, routes.route_short_name)) if not routes.empty else {}
    deps = deps.assign(i=np.arange(len(deps)))
    by_trip = dict(zip(deps.trip_id, deps.i))
    route_of = deps.route_id.astype(str).to_numpy() if "route_id" in deps else np.array([""] * len(deps))
    start, end = deps.start_secs.astype(float).to_numpy(), deps.end_secs.astype(float).to_numpy()
    trip_ids = deps.trip_id.to_numpy()

    def fit(i, lat, lon, ts):
        c = calls.get(trip_ids[i])
        if c is None:
            return None
        at = ts - t0
        dist, sched, pos = project(lat, lon, c[1], c[2], c[3], at)
        return dist, (at - sched) / 60.0, pos

    assigned, taken_by = {}, {}
    rows = list(p.itertuples())
    # 1. buses that report a trip in today's timetable
    for r in rows:
        tid = r.trip_id if isinstance(r.trip_id, str) else None
        i = by_trip.get(alias.get(tid)) if tid else None
        if i is None or i in assigned:
            continue
        f = fit(i, float(r.lat), float(r.lon), float(r.ts))
        if f and f[0] <= REPORTED_OFF_ROUTE_M and EARLY_LIMIT_MIN <= f[1] <= LATE_LIMIT_MIN + 30:
            assigned[i] = {"how": "r", "dist": f[0], "delay": f[1], "pos": f[2], "r": r}
            taken_by[r.vehicle_id] = i
    # 2. the rest: the departure of the same route that best explains the bus's last few positions.
    #    One position can't tell "5 min late on the 10:00" from "5 min early on the 10:10"; a track can:
    #    on the right departure the lateness holds steady and the bus moves forward along the path.
    hist = pings[(pings.ts.astype(float) >= now_ts - HISTORY_SECS)] if "ts" in pings else pings.iloc[0:0]
    hist = hist.sort_values("ts").drop_duplicates(["vehicle_id", "ts"])
    tracks = {v: g.tail(6) for v, g in hist.groupby("vehicle_id", sort=False)}
    options = []
    now_secs = now_ts - t0
    live_window = (start - 900 <= now_secs) & (now_secs <= end + LATE_LIMIT_MIN * 60)
    for r in rows:
        if r.vehicle_id in taken_by or not isinstance(r.route_id, str) or not r.route_id:
            continue
        tr = tracks.get(r.vehicle_id)
        samples = [(float(x.lat), float(x.lon), float(x.ts)) for x in tr.itertuples()] if tr is not None and len(tr) else []
        if not samples or samples[-1][2] != float(r.ts):
            samples.append((float(r.lat), float(r.lon), float(r.ts)))
        for i in np.flatnonzero(live_window & (route_of == str(r.route_id))):
            if i in assigned:
                continue
            fits = [fit(int(i), la, lo, ts) for la, lo, ts in samples]
            if any(f is None for f in fits):
                continue
            now_fit = fits[-1]
            if not (now_fit[0] <= MAX_OFF_ROUTE_M and EARLY_LIMIT_MIN <= now_fit[1] <= LATE_LIMIT_MIN):
                continue
            close = [f for f in fits if f[0] <= MAX_OFF_ROUTE_M * 1.5]
            delays = np.array([f[1] for f in close])
            pos = [f[2] for f in close]
            backwards = sum(max(0.0, a - b) for a, b in zip(pos, pos[1:]))   # stops travelled in reverse
            cost = (abs(now_fit[1]) * W_DELAY + float(np.std(delays)) * W_STEADY + backwards * W_BACK
                    + float(np.mean([f[0] for f in close])) / 100.0 + (len(fits) - len(close)) * 2.0)
            options.append((cost, int(i), r, now_fit))
    for _, i, r, f in sorted(options, key=lambda o: o[0]):
        if i in assigned or r.vehicle_id in taken_by:
            continue
        assigned[i] = {"how": "i", "dist": f[0], "delay": f[1], "pos": f[2], "r": r}
        taken_by[r.vehicle_id] = i

    vehicles = []
    for r in rows:
        i = taken_by.get(r.vehicle_id, -1)
        a = assigned.get(i)
        try:
            bearing = int(float(r.bearing)) if float(r.bearing) >= 0 else None
        except (TypeError, ValueError):
            bearing = None
        vehicles.append([round(float(r.lat), 5), round(float(r.lon), 5), bearing,
                         short.get(str(r.route_id), ""),
                         int(i), round(a["delay"]) if a else None, int(now_ts - float(r.ts)), a["how"] if a else ""])
    return assigned, vehicles


def self_check(day, deps, alias, calls, pings, now_ts, assigned) -> dict:
    """How well the inference works right now: hide the trip of every bus that reports one,
    infer it from route and position, and count how often the inference names the same departure."""
    rep = {a["r"].vehicle_id: i for i, a in assigned.items() if a["how"] == "r"}
    if not rep or pings.empty:
        return {"n": 0, "right": 0, "wrong": 0}
    hidden = pings.copy()
    hidden.loc[hidden.vehicle_id.isin(rep), "trip_id"] = ""
    guess, _ = track(day, deps, alias, calls, hidden, now_ts)
    g = {a["r"].vehicle_id: i for i, a in guess.items()}
    right = sum(1 for v, i in rep.items() if g.get(v) == i)
    wrong = sum(1 for v, i in rep.items() if v in g and g[v] != i)
    return {"n": len(rep), "right": right, "wrong": wrong}


def status(day: date, deps: pd.DataFrame, verdicts: pd.DataFrame, assigned: dict, now_ts: float):
    t0 = match.secs_to_dt(day, 0).timestamp()
    now_secs = now_ts - t0
    v = dict(zip(verdicts.trip_id, verdicts.verdict))
    reason = dict(zip(verdicts.trip_id, verdicts.reason))
    letters, counts = [], {}
    for i, d in enumerate(deps.itertuples()):
        verdict = v.get(d.trip_id, "unknown")
        if i in assigned:
            c = "O"
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
    live = [[i, max(-9, min(99, round(a["delay"]))), round(a["pos"], 2), round(float(a["r"].lat), 5), round(float(a["r"].lon), 5),
             int(now_ts - float(a["r"].ts)), a["how"]] for i, a in sorted(assigned.items())]
    return "".join(letters), live, counts


def snapshot(now: datetime | None = None, timetable_out: bool = True):
    """Everything the site needs at this moment: (day, board or None, status, vehicles)."""
    now = (now or datetime.now(C.TZ)).astimezone(C.TZ)
    day = service_day(now)
    if not (C.SCHEDULE / day.isoformat() / "trips.csv.gz").exists():
        return None
    trips, stop_times, pings, health = match.load_day(day)
    deps, alias = departures(trips)
    calls = _calls(deps, stop_times)
    body = timetable(day, deps, calls)
    verdicts = match.classify(day, trips, stop_times, pings, health, _agency_map(), settle_secs=SETTLE_SECS)
    assigned, vehicles = track(day, deps, alias, calls, pings, now.timestamp())
    letters, live, counts = status(day, deps, verdicts, assigned, now.timestamp())
    check = self_check(day, deps, alias, calls, pings, now.timestamp(), assigned)
    at = now.isoformat(timespec="seconds")
    if not pings.empty:
        at = datetime.fromtimestamp(int(pings.poll_ts.max()), C.TZ).isoformat(timespec="seconds")
    reported = sum(1 for x in vehicles if x[7] == "r")
    inferred = sum(1 for x in vehicles if x[7] == "i")
    stat = {"day": day.isoformat(), "version": body["version"], "at": at, "status": letters, "live": live, "counts": counts,
            "feed": {"buses": len(vehicles), "reported": reported, "inferred": inferred, "check": check}}
    veh = {"at": at, "v": vehicles}
    return day, (body if timetable_out else None), stat, veh


def publish(now: datetime | None = None) -> dict | None:
    """Write today's board (if new), the status and the vehicles to the site. Returns the counts."""
    from .publish import _w  # local import: publish imports this module

    snap = snapshot(now)
    if snap is None:
        return None
    day, body, stat, veh = snap
    board_path = C.SITE_DATA / "board" / f"{day.isoformat()}.json"
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
    _w("status.json", stat)
    _w("vehicles.json", veh)
    return stat["counts"]


def publish_live(out_dir) -> dict | None:
    """Write only the small, fast-changing files (status, vehicles) to out_dir."""
    from pathlib import Path

    from .publish import _clean

    snap = snapshot(timetable_out=False)
    if snap is None:
        return None
    _, _, stat, veh = snap
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for name, obj in (("status.json", stat), ("vehicles.json", veh)):
        (out / name).write_text(json.dumps(_clean(obj), separators=(",", ":"), allow_nan=False))
    return stat["feed"]


if __name__ == "__main__":
    import sys

    if "--live" in sys.argv:
        print(publish_live(sys.argv[sys.argv.index("--live") + 1]))
    else:
        print(publish())
