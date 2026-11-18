"""Three extra files for the website, built from data the pipeline already keeps.

replay.json    one whole day, replayable: every bus's GPS track every 2 minutes, plus every ghost moving
               along the route it was timetabled to drive. Small enough for a phone (delta-encoded integers).
patterns.json  when buses go missing: ghost rate by weekday and hour, for the city and for busy routes.
weekly.json    the weekly ghost report: this week against last week, worst and most improved routes,
               the most reliable routes, the operators, and the departure that failed most often.
"""
from __future__ import annotations

import gzip
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

from . import config as C

JUDGED = ["ran_tracked", "ran_matched", "ghost"]
Q = 10_000                       # coordinates are stored as 1/10,000 of a degree (about 10 m)
STEP = 120                       # replay frame: 2 minutes
MIN_WEEK = 80                    # trips a route needs in a week before it is ranked


def _slug(s):
    from .publish import slug
    return slug(s)


def _hhmm(secs):
    secs = int(secs) % 86400
    return f"{secs // 3600:02d}:{secs % 3600 // 60:02d}"


def _delta(rows):
    """[[a,b,c],[a,b,c],...] -> flat list, first triple absolute, the rest as differences."""
    out, prev = [], (0, 0, 0)
    for r in rows:
        out += [int(r[0]) - prev[0], int(r[1]) - prev[1], int(r[2]) - prev[2]]
        prev = (int(r[0]), int(r[1]), int(r[2]))
    return out


def _q(lat, lon):
    return np.round((np.asarray(lat) - C.BBOX[0]) * Q).astype(int), np.round((np.asarray(lon) - C.BBOX[2]) * Q).astype(int)


# ---------------------------------------------------------------- replay
def _pings(day: date) -> pd.DataFrame:
    """Pings whose position time falls on `day` (local), from that day's and the next day's hourly files."""
    files = []
    for d in (day, day + timedelta(days=1)):
        p = C.RAW / d.isoformat()
        if p.exists():
            files += sorted(p.glob("*.csv.gz"))
    if not files:
        return pd.DataFrame()
    df = pd.concat([pd.read_csv(f, dtype={"vehicle_id": str, "trip_id": str, "route_id": str}) for f in files], ignore_index=True)
    df = df[(df.poll_ts - df.ts).between(-60, 300)]             # drop stale positions repeated by the feed
    t = pd.to_datetime(df.ts, unit="s", utc=True).dt.tz_convert(C.TZ)
    start = pd.Timestamp(datetime.combine(day, datetime.min.time()), tz=C.TZ)
    df["secs"] = (t - start).dt.total_seconds().astype(int)
    return df[df.secs.between(0, 86400 - 1)]


def build_replay(day: date, results: pd.DataFrame) -> dict | None:
    pings = _pings(day)
    if pings.empty:
        return None
    res = results[results.service_date == day]
    route_by_trip = dict(zip(res.trip_id, res.route))
    rpath = C.DATA / "city_gtfs" / "routes.csv"
    route_by_id = {}
    if rpath.exists():
        r = pd.read_csv(rpath, dtype=str)
        route_by_id = dict(zip(r.route_id, r.route_short_name.fillna("")))
    pings = pings.copy()
    pings["route"] = [route_by_trip.get(t) or route_by_id.get(r) or "" for t, r in zip(pings.trip_id, pings.route_id)]
    pings["slot"] = pings.secs // STEP
    pings = pings.sort_values("ts").drop_duplicates(["vehicle_id", "slot"], keep="last")
    pings["la"], pings["lo"] = _q(pings.lat, pings.lon)
    buses = []
    for vid, g in pings.groupby("vehicle_id"):
        if len(g) < 3:
            continue
        g = g.sort_values("slot")
        label = g.route[g.route != ""].mode()
        buses.append([label.iloc[0] if len(label) else "", _delta(g[["slot", "la", "lo"]].to_numpy())])

    ghosts = []
    st_path = C.SCHEDULE / day.isoformat() / "stop_times.csv.gz"
    gh = res[res.verdict == "ghost"]
    if st_path.exists() and len(gh):
        st = pd.read_csv(st_path, dtype={"trip_id": str})
        st = st[st.trip_id.isin(set(gh.trip_id))].sort_values(["trip_id", "secs"])
        st["la"], st["lo"] = _q(st.stop_lat, st.stop_lon)
        st["m"] = st.secs // 60
        paths = {t: g[["m", "la", "lo"]].to_numpy() for t, g in st.groupby("trip_id")}
        for r in gh.sort_values("start_secs").itertuples():
            p = paths.get(r.trip_id)
            if p is None or len(p) < 2:
                continue
            ghosts.append([r.route, r.operator, _hhmm(r.start_secs), r.from_stop, r.to_stop, _delta(p)])

    j = res[res.verdict.isin(JUDGED)]
    by_hour = j.assign(h=(j.start_secs // 3600).astype(int) % 24, g=(j.verdict == "ghost").astype(int)).groupby("h").g.agg(["size", "sum"])
    return {"day": day.isoformat(), "step": STEP, "q": Q, "lat0": C.BBOX[0], "lon0": C.BBOX[2],
            "buses": buses, "ghosts": ghosts,
            "totals": {"vehicles": len(buses), "judged": int(len(j)), "ghosts": int((j.verdict == "ghost").sum()), "ghost_paths": len(ghosts)},
            "by_hour": [[int(h), int(r["size"]), int(r["sum"])] for h, r in by_hour.iterrows()]}


# ---------------------------------------------------------------- patterns
def build_patterns(results: pd.DataFrame, min_route: int = 200) -> dict:
    j = results[results.verdict.isin(JUDGED)].copy()
    if j.empty:
        return {}
    j["wd"] = pd.to_datetime(j.service_date).dt.weekday
    j["h"] = (j.start_secs // 3600).astype(int) % 24
    j["g"] = (j.verdict == "ghost").astype(int)

    def grid(g):
        a = g.groupby(["wd", "h"]).g.agg(["size", "sum"])
        return [[int(wd), int(h), int(r["size"]), int(r["sum"])] for (wd, h), r in a.iterrows()]

    routes = {}
    for (route, op), g in j.groupby(["route", "operator"]):
        if len(g) >= min_route:
            routes[_slug(f"{route}-{op}")] = grid(g)
    days = j.groupby("wd").agg(n=("g", "size"), ghosts=("g", "sum"), dates=("service_date", "nunique"))
    return {"from": str(min(j.service_date)), "to": str(max(j.service_date)),
            "city": grid(j), "weekdays": [[int(k), int(r.n), int(r.ghosts), int(r.dates)] for k, r in days.iterrows()],
            "routes": routes}


# ---------------------------------------------------------------- weekly report
def build_weekly(results: pd.DataFrame) -> dict:
    j = results[results.verdict.isin(JUDGED)].copy()
    if j.empty:
        return {}
    j["g"] = (j.verdict == "ghost").astype(int)
    last = max(j.service_date)
    week = j[j.service_date > last - timedelta(days=7)]
    prev = j[(j.service_date <= last - timedelta(days=7)) & (j.service_date > last - timedelta(days=14))]

    def rate(g):
        return round(float(g.g.mean()), 4) if len(g) else None

    def per_route(g):
        a = g.groupby(["route", "operator"]).g.agg(["size", "sum"]).reset_index()
        a["rate"] = a["sum"] / a["size"]
        return a

    w, p = per_route(week), per_route(prev)
    both = w.merge(p, on=["route", "operator"], how="left", suffixes=("", "_prev"))

    def row(r):
        out = {"id": _slug(f"{r.route}-{r.operator}"), "route": r.route, "operator": r.operator,
               "judged": int(r["size"]), "ghosts": int(r["sum"]), "rate": round(float(r.rate), 4)}
        if "size_prev" in r and pd.notna(r.get("size_prev")) and r["size_prev"] >= MIN_WEEK:
            out["prev_rate"] = round(float(r.rate_prev), 4)
        return out

    ranked = both[both["size"] >= MIN_WEEK]
    worst = [row(r) for _, r in ranked.sort_values(["rate", "size"], ascending=[False, False]).head(6).iterrows()]
    best = [row(r) for _, r in ranked[ranked["size"] >= 150].sort_values(["rate", "size"], ascending=[True, False]).head(6).iterrows()]
    imp = ranked[ranked.size_prev >= MIN_WEEK].assign(change=lambda d: d.rate - d.rate_prev)
    improved = [row(r) for _, r in imp[imp.change < 0].sort_values("change").head(5).iterrows()]
    worse = [row(r) for _, r in imp[imp.change > 0].sort_values("change", ascending=False).head(5).iterrows()]

    ops = []
    for op, g in week.groupby("operator"):
        if len(g) < MIN_WEEK:
            continue
        gp = prev[prev.operator == op]
        ops.append({"operator": op, "judged": int(len(g)), "ghosts": int(g.g.sum()), "rate": rate(g),
                    "prev_rate": rate(gp) if len(gp) >= MIN_WEEK else None})
    ops.sort(key=lambda o: -(o["rate"] or 0))

    hours = week.assign(h=(week.start_secs // 3600).astype(int) % 24).groupby("h").g.agg(["size", "sum"])
    hours = hours[hours["size"] >= 100]
    worst_hour = None
    if len(hours):
        h = (hours["sum"] / hours["size"]).idxmax()
        worst_hour = {"hour": int(h), "judged": int(hours.loc[h, "size"]), "ghosts": int(hours.loc[h, "sum"]),
                      "rate": round(float(hours.loc[h, "sum"] / hours.loc[h, "size"]), 4)}

    days = week.groupby("service_date").g.agg(["size", "sum"])
    day_rows = [[str(d), int(r["size"]), int(r["sum"])] for d, r in days.iterrows()]

    # the timetabled departure that failed most often this week
    dep = week.groupby(["route", "operator", "direction_id", "start_secs", "from_stop", "to_stop"], dropna=False).g.agg(["size", "sum"]).reset_index()
    dep = dep[(dep["sum"] >= 2) & dep.start_secs.between(5 * 3600, 23 * 3600)].sort_values(["sum", "size"], ascending=[False, True])
    gotw = None
    if len(dep):
        r = dep.iloc[0]
        gotw = {"id": _slug(f"{r.route}-{r.operator}"), "route": r.route, "operator": r.operator, "time": _hhmm(r.start_secs),
                "from": r.from_stop, "to": r.to_stop, "ghost_days": int(r["sum"]), "judged_days": int(r["size"])}

    return {"from": str(min(week.service_date)), "to": str(last), "days": int(week.service_date.nunique()),
            "judged": int(len(week)), "ghosts": int(week.g.sum()), "rate": rate(week),
            "prev": {"judged": int(len(prev)), "ghosts": int(prev.g.sum()), "rate": rate(prev),
                     "from": str(min(prev.service_date)) if len(prev) else None, "to": str(max(prev.service_date)) if len(prev) else None},
            "worst": worst, "best": best, "improved": improved, "worsened": worse, "operators": ops,
            "worst_hour": worst_hour, "by_day": day_rows, "ghost_of_the_week": gotw,
            "extra_wait": extra_wait(results[results.service_date > last - timedelta(days=7)]),
            "extra_wait_all": extra_wait(results)}


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


# ---------------------------------------------------------------- forecast: tomorrow, from the live model
def build_forecast(results: pd.DataFrame) -> dict:
    """The champion model's chance that each departure runs, for the latest predicted day, plus how
    earlier forecasts compared with what actually happened."""
    pdir = C.DATA / "predictions"
    files = sorted(pdir.glob("*.csv.gz")) if pdir.exists() else []
    if not files:
        return {}
    f = files[-1]
    day = f.name[:10]
    p = pd.read_csv(f, dtype={"trip_id": str, "route": str, "direction_id": str, "model_version": str})
    sched = C.SCHEDULE / day / "trips.csv.gz"
    if sched.exists():
        t = pd.read_csv(sched, dtype={"trip_id": str})[["trip_id", "from_stop", "to_stop"]]
        p = p.merge(t, on="trip_id", how="left")
    else:
        p["from_stop"], p["to_stop"] = "", ""
    # the timetable lists many departures more than once (overlapping versions): count each once
    p = (p.groupby(["route", "operator", "direction_id", "start_secs", "from_stop", "to_stop"], dropna=False)
          .p_runs.mean().reset_index())
    p["miss"] = 1 - p.p_runs
    p["h"] = (p.start_secs // 3600).astype(int) % 24
    hours = p.groupby("h").agg(n=("miss", "size"), exp=("miss", "sum"))
    r = p.groupby(["route", "operator"]).agg(n=("miss", "size"), exp=("miss", "sum")).reset_index()
    r = r[r.n >= 10].assign(rate=lambda d: d.exp / d.n).sort_values("rate", ascending=False).head(10)
    risky = p[p.start_secs.between(5 * 3600, 23 * 3600)].sort_values("p_runs").head(15)

    track = []
    for pf in files[-14:]:
        d = pf.name[:10]
        rf = C.RESULTS / f"{d}.csv.gz"
        if not rf.exists():
            continue
        pr = pd.read_csv(pf, dtype={"trip_id": str})[["trip_id", "p_runs"]]
        rr = pd.read_csv(rf, dtype={"trip_id": str})
        j = rr[rr.verdict.isin(JUDGED)].merge(pr, on="trip_id")
        if len(j) >= 200:
            track.append([d, int(len(j)), round(float((1 - j.p_runs).sum()), 1), int((j.verdict == "ghost").sum())])
    version = None
    try:
        version = str(pd.read_csv(f, usecols=["model_version"]).model_version.iloc[0])
    except Exception:
        pass
    return {"day": day, "model_version": version, "departures": int(len(p)), "expected": round(float(p.miss.sum()), 1),
            "rate": round(float(p.miss.mean()), 4),
            "by_hour": [[int(h), int(x.n), round(float(x.exp), 2)] for h, x in hours.iterrows()],
            "routes": [{"id": _slug(f"{x.route}-{x.operator}"), "route": x.route, "operator": x.operator, "departures": int(x.n),
                        "expected": round(float(x.exp), 1), "rate": round(float(x.rate), 4)} for x in r.itertuples()],
            "risky": [{"route": x.route, "operator": x.operator, "time": _hhmm(x.start_secs), "from": x.from_stop if isinstance(x.from_stop, str) else "",
                       "to": x.to_stop if isinstance(x.to_stop, str) else "", "p_runs": round(float(x.p_runs), 3),
                       "id": _slug(f"{x.route}-{x.operator}")} for x in risky.itertuples()],
            "track": track}


def extra_wait(results: pd.DataFrame) -> dict:
    """When a bus never came, how long until the next one on the same route, direction and first stop did?"""
    r = results[results.verdict.isin(JUDGED)][["service_date", "route", "operator", "direction_id", "from_stop", "start_secs", "verdict"]]
    r = r.sort_values("start_secs")
    gaps = []
    for _, g in r.groupby(["service_date", "route", "operator", "direction_id", "from_stop"], dropna=False):
        ran = g[g.verdict != "ghost"].start_secs.to_numpy()
        for s in g[g.verdict == "ghost"].start_secs.to_numpy():
            k = np.searchsorted(ran, s, side="right")
            if k < len(ran) and ran[k] - s <= 3 * 3600:
                gaps.append((ran[k] - s) / 60)
    if not gaps:
        return {}
    a = np.array(gaps)
    return {"ghosts": int(len(a)), "median_min": round(float(np.median(a)), 1), "mean_min": round(float(a.mean()), 1),
            "over_30": round(float((a > 30).mean()), 3), "total_hours": round(float(a.sum() / 60), 0)}


def build_all(results: pd.DataFrame, write) -> dict:
    """Write the three files with publish's writer. Each part fails on its own without stopping the others."""
    done = {}
    if results.empty:
        return done
    for name, fn in (("patterns.json", lambda: build_patterns(results)), ("weekly.json", lambda: build_weekly(results)),
                     ("stops.json", lambda: build_stops(results)), ("forecast.json", lambda: build_forecast(results))):
        try:
            write(name, fn())
            done[name] = True
        except Exception as e:  # a broken extra must never stop the main site data
            print(f"{name} failed:", e)
    try:
        # the most recent judged day that still has its raw pings
        for d in sorted(set(results.service_date), reverse=True)[:3]:
            rp = build_replay(d, results)
            if rp and rp["buses"]:
                write("replay.json", rp)
                done["replay.json"] = rp["totals"]
                break
    except Exception as e:
        print("replay.json failed:", e)
    return done


def _size(path):
    raw = path.read_bytes()
    return len(raw), len(gzip.compress(raw))
