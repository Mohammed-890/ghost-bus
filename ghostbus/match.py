"""Decide, for every scheduled trip on a service day, whether a bus ran it.

Verdicts:
  ran_tracked   a live bus reported this exact trip ID during the trip
  ran_matched   no bus reported the trip ID, but a bus with no or an unknown
                trip ID passed the trip's stops in order, at the right times
  ghost         neither, while the feed was answering and the operator was
                visibly reporting other buses at the time
  unknown       we can't tell fairly: feed gap, operator not reporting,
                route never seen all day, or too few stops in the city
"""
from __future__ import annotations

import glob
import sys
from datetime import date, timedelta

import numpy as np
import pandas as pd

from . import config as C
from .schedule import secs_to_dt

VERDICTS = ["ran_tracked", "ran_matched", "ghost", "unknown"]


# ------------------------------------------------------------------ loading
def _read_many(pattern: str) -> pd.DataFrame:
    files = sorted(glob.glob(pattern))
    if not files:
        return pd.DataFrame()
    return pd.concat([pd.read_csv(f, dtype={"vehicle_id": str, "trip_id": str, "route_id": str, "start_date": str,
                                            "start_time": str, "error": str}, keep_default_na=False) for f in files],
                     ignore_index=True)


def load_day(day: date):
    nxt = day + timedelta(days=1)
    pings = pd.concat([_read_many(str(C.RAW / day.isoformat() / "*.csv.gz")),
                       _read_many(str(C.RAW / nxt.isoformat() / "0[0-4].csv.gz"))], ignore_index=True)
    health = pd.concat([_read_many(str(C.HEALTH / f"{day.isoformat()}.csv.gz")),
                        _read_many(str(C.HEALTH / f"{nxt.isoformat()}.csv.gz"))], ignore_index=True)
    sched = C.SCHEDULE / day.isoformat()
    trips = pd.read_csv(sched / "trips.csv.gz", dtype={"trip_id": str, "route_id": str, "agency_id": str, "route": str,
                                                      "direction_id": str})
    stops = pd.read_csv(sched / "stop_times.csv.gz", dtype={"trip_id": str, "stop_id": str})
    return trips, stops, pings, health


# ------------------------------------------------------------------ helpers
def _metres(lat1, lon1, lat2, lon2):
    k = 111_320.0
    return np.hypot((lat2 - lat1) * k, (lon2 - lon1) * k * np.cos(np.radians(lat1)))


def _lnds(times: list[float]) -> int:
    """Length of the longest non-decreasing run of times (stops are in order)."""
    import bisect
    tails: list[float] = []
    for t in times:
        i = bisect.bisect_right(tails, t)
        if i == len(tails):
            tails.append(t)
        else:
            tails[i] = t
    return len(tails)


def _sample(seq: pd.DataFrame, n: int) -> pd.DataFrame:
    if len(seq) <= n:
        return seq
    idx = np.unique(np.linspace(0, len(seq) - 1, n).round().astype(int))
    return seq.iloc[idx]


# ------------------------------------------------------------------ core
def classify(day: date, trips: pd.DataFrame, stops: pd.DataFrame, pings: pd.DataFrame, health: pd.DataFrame,
             all_trip_agency: dict | None = None) -> pd.DataFrame:
    t0 = secs_to_dt(day, 0).timestamp()
    trips = trips.copy()
    cols = ["trip_id", "route_id", "route", "operator", "agency_id", "direction_id", "trip_headsign",
            "from_stop", "to_stop", "start_secs", "end_secs", "n_stops"]
    for c in cols:
        if c not in trips:
            trips[c] = ""
    trips["agency_id"] = trips.agency_id.fillna("").astype(str)
    out = trips[cols].copy().reset_index(drop=True)
    out["verdict"] = "unknown"
    out["reason"] = ""
    out["vehicle_id"] = ""
    out["evidence"] = 0

    if health.empty:
        out["reason"] = "no polls"
        return out

    health = health.copy()
    health["secs"] = health.poll_ts.astype(float) - t0
    ok_polls = np.sort(health.loc[health.ok.astype(int) == 1, "secs"].to_numpy())
    last_poll = health.secs.max()

    if pings.empty:
        pings = pd.DataFrame(columns=["poll_ts", "ts", "vehicle_id", "trip_id", "route_id", "start_date", "lat", "lon"])
    p = pings.copy()
    p["secs"] = p.ts.astype(float) - t0
    p["poll_secs"] = p.poll_ts.astype(float) - t0
    p["lat"] = p.lat.astype(float)
    p["lon"] = p.lon.astype(float)
    ymd = day.strftime("%Y%m%d")

    sched_ids = set(trips.trip_id)
    agency_of = dict(all_trip_agency or {})
    agency_of.update(dict(zip(trips.trip_id, trips.agency_id)))

    # Which operators were visibly reporting at each poll?
    tagged = p[p.trip_id != ""].copy()
    tagged["agency"] = tagged.trip_id.map(agency_of)
    vis = tagged.dropna(subset=["agency"]).groupby("agency").poll_secs.apply(lambda s: np.sort(s.unique()))

    # 1. exact trip ID matches (same service day)
    t_today = tagged[tagged.trip_id.isin(sched_ids) & ((tagged.start_date == "") | (tagged.start_date == ymd))]
    by_trip = t_today.groupby("trip_id")

    # 2. candidate pings for position matching: no trip ID, or one not in today's timetable
    cand = p[(p.trip_id == "") | ~p.trip_id.isin(sched_ids)].sort_values("secs")
    c_secs, c_lat, c_lon, c_veh = cand.secs.to_numpy(), cand.lat.to_numpy(), cand.lon.to_numpy(), cand.vehicle_id.to_numpy()

    stops_by_trip = {k: g.sort_values("stop_sequence") for k, g in stops.groupby("trip_id")}
    routes_seen = set(trips.loc[trips.trip_id.isin(set(t_today.trip_id)), "route_id"])
    proposals = []  # (score, trip_id, vehicle, start, end)

    pending = {}  # trip index -> reason it would be "unknown" instead of "ghost" if no bus is found
    for i, row in out.iterrows():
        tid, a, b = row.trip_id, row.start_secs, row.end_secs
        if b + 3600 > last_poll:
            out.at[i, "reason"] = "not finished when last checked"
            continue
        if tid in by_trip.groups:
            g = by_trip.get_group(tid)
            g = g[(g.secs >= a - 1800) & (g.secs <= b + 3600)]
            if len(g):
                out.at[i, "verdict"] = "ran_tracked"
                out.at[i, "vehicle_id"] = g.vehicle_id.mode().iat[0]
                out.at[i, "evidence"] = len(g)
                continue
        # Only allowed to call it a ghost if we were watching and the operator was reporting.
        win = ok_polls[(ok_polls >= a - 300) & (ok_polls <= b + 300)]
        cov = min(1.0, len(win) / max(1.0, (b - a + 600) / C.POLL_SECONDS))
        op_cov = np.isin(win, vis.get(row.agency_id, np.array([]))).mean() if len(win) else 0.0
        seq = stops_by_trip.get(tid)
        if cov < C.MIN_POLL_COVERAGE:
            pending[i] = f"feed gap ({cov:.0%} of polls)"
        elif op_cov < C.MIN_OPERATOR_COVERAGE:
            pending[i] = f"operator not reporting ({op_cov:.0%})"
        elif seq is None or len(seq) < C.MIN_STOPS_MATCHED:
            pending[i] = "too few stops in the city to check"
        else:
            pending[i] = "no bus seen"
        out.at[i, "reason"] = pending[i]
        if seq is None or len(seq) < C.MIN_STOPS_MATCHED:
            continue
        # Look for any untagged bus that passed this trip's stops in order, on time.
        smp = _sample(seq, C.SAMPLE_STOPS)
        hits: dict[str, list[tuple[int, float]]] = {}
        for k, (_, s) in enumerate(smp.iterrows()):
            lo = np.searchsorted(c_secs, s.secs - C.EARLY_MIN * 60)
            hi = np.searchsorted(c_secs, s.secs + C.LATE_MIN * 60, side="right")
            if hi <= lo:
                continue
            d = _metres(s.stop_lat, s.stop_lon, c_lat[lo:hi], c_lon[lo:hi])
            for j in np.nonzero(d <= C.STOP_RADIUS_M)[0]:
                lst = hits.setdefault(c_veh[lo + j], [])
                if not lst or lst[-1][0] != k:
                    lst.append((k, c_secs[lo + j]))
        need = max(C.MIN_STOPS_MATCHED, int(np.ceil(C.MIN_STOP_SHARE * len(smp))))
        for v, lst in hits.items():
            score = _lnds([t for _, t in lst])
            if score >= need:
                proposals.append((score / len(smp), tid, v, a, b))

    # 3. one bus can't run two overlapping trips: assign best matches first
    busy: dict[str, list[tuple[float, float]]] = {}
    done = set()
    for score, tid, v, a, b in sorted(proposals, key=lambda x: -x[0]):
        if tid in done:
            continue
        if any(not (b < s or a > e) for s, e in busy.get(v, [])):
            continue
        busy.setdefault(v, []).append((a, b))
        done.add(tid)
        m = out.trip_id == tid
        out.loc[m, ["verdict", "vehicle_id", "evidence", "reason"]] = ["ran_matched", v, round(score, 2), ""]
        routes_seen.add(out.loc[m, "route_id"].iat[0])

    ghosts = (out.verdict == "unknown") & (out.reason == "no bus seen")
    never = ghosts & ~out.route_id.isin(routes_seen)
    out.loc[never, "reason"] = "route not seen all day"
    out.loc[ghosts & ~never, "verdict"] = "ghost"
    out.loc[out.verdict == "ghost", "reason"] = ""
    out["service_date"] = day.isoformat()
    out["feed_ok_share"] = round(len(ok_polls) / max(1, len(health)), 3)
    return out


def run_day(day: date) -> pd.DataFrame:
    trips, stops, pings, health = load_day(day)
    agency_map = {}
    city_trips = C.DATA / "city_gtfs" / "trips.csv"
    if city_trips.exists():
        t = pd.read_csv(city_trips, dtype=str)
        r = pd.read_csv(C.DATA / "city_gtfs" / "routes.csv", dtype=str)
        agency_map = dict(zip(t.trip_id, t.route_id.map(dict(zip(r.route_id, r.agency_id)))))
    res = classify(day, trips, stops, pings, health, agency_map)
    C.RESULTS.mkdir(parents=True, exist_ok=True)
    res.to_csv(C.RESULTS / f"{day.isoformat()}.csv.gz", index=False)
    return res


if __name__ == "__main__":
    d = date.fromisoformat(sys.argv[1])
    r = run_day(d)
    print(r.verdict.value_counts().to_string())
