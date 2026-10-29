"""Turn the daily verdicts into the small JSON files the website reads."""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

from . import config as C
from .model import evaluate, forecast, load_results
from .schedule import day_schedule

JUDGED = ["ran_tracked", "ran_matched", "ghost"]


def _w(name, obj):
    C.SITE_DATA.mkdir(parents=True, exist_ok=True)
    path = C.SITE_DATA / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), default=str))


def hhmm(secs):
    secs = int(secs) % 86400
    return f"{secs // 3600:02d}:{secs % 3600 // 60:02d}"


def slug(s):
    return re.sub(r"[^A-Za-z0-9]+", "-", str(s)).strip("-").lower() or "route"


def health_summary():
    files = sorted(C.HEALTH.glob("*.csv.gz"))
    if not files:
        return {}
    h = pd.concat([pd.read_csv(f) for f in files[-14:]])
    return {"polls": int(len(h)), "ok_share": round(float(h.ok.mean()), 4),
            "median_buses": int(h.loc[h.ok == 1, "entities"].median()) if (h.ok == 1).any() else 0,
            "with_trip_share": round(float(h.with_trip.sum() / max(1, h.entities.sum())), 3),
            "first_poll": datetime.fromtimestamp(int(h.poll_ts.min()), C.TZ).isoformat(timespec="minutes"),
            "last_poll": datetime.fromtimestamp(int(h.poll_ts.max()), C.TZ).isoformat(timespec="minutes")}


def build():
    df = load_results()
    now = datetime.now(C.TZ).isoformat(timespec="minutes")
    hs = health_summary()
    if df.empty:
        _w("summary.json", {"status": "collecting", "city": C.CITY, "updated": now, "health": hs})
        return
    df["g"] = (df.verdict == "ghost").astype(int)
    df["judged"] = df.verdict.isin(JUDGED).astype(int)
    j = df[df.judged == 1]
    last = max(df.service_date)
    recent = j[j.service_date > last - timedelta(days=7)]

    _w("summary.json", {
        "status": "ready", "city": C.CITY, "updated": now, "health": hs,
        "days": int(df.service_date.nunique()), "first_day": min(df.service_date), "last_day": last,
        "scheduled": int(len(df)), "judged": int(len(j)), "ghosts": int(j.g.sum()),
        "ghost_rate": round(float(j.g.mean()), 4) if len(j) else None,
        "ran_tracked": int((df.verdict == "ran_tracked").sum()), "ran_matched": int((df.verdict == "ran_matched").sum()),
        "unknown": int((df.verdict == "unknown").sum()),
        "unknown_reasons": df[df.verdict == "unknown"].reason.fillna("").astype(str).str.replace(r" \(.*\)", "", regex=True).value_counts().to_dict(),
        "last7": {"judged": int(len(recent)), "ghosts": int(recent.g.sum()),
                  "ghost_rate": round(float(recent.g.mean()), 4) if len(recent) else None},
    })

    daily = df.groupby("service_date").agg(scheduled=("trip_id", "size"), judged=("judged", "sum"), ghosts=("g", "sum")).reset_index()
    _w("daily.json", daily.to_dict("records"))

    ops = j.groupby("operator").agg(judged=("g", "size"), ghosts=("g", "sum")).reset_index()
    ops["rate"] = (ops.ghosts / ops.judged).round(4)
    _w("operators.json", ops.sort_values("rate", ascending=False).to_dict("records"))

    # forecast for the next scheduled day we have a timetable for
    fc = None
    nxt = last + timedelta(days=1)
    try:
        if (C.DATA / "city_gtfs" / "trips.csv").exists():
            sched, _ = day_schedule(nxt)
            if len(sched) and evaluate(df)["status"] == "ready":
                fc = forecast(df, sched)[["route", "direction_id", "start_secs", "p_runs"]]
    except Exception as e:  # the site still works without a forecast
        print("forecast skipped:", e)

    routes = []
    for (route, op), g in df.groupby(["route", "operator"]):
        jg = g[g.judged == 1]
        if not len(g):
            continue
        rid = slug(f"{route}-{op}")
        by_hour = jg.assign(h=(jg.start_secs // 3600).astype(int) % 24).groupby("h").agg(n=("g", "size"), ghosts=("g", "sum"))
        deps = jg.groupby(["direction_id", "start_secs", "from_stop", "to_stop"], dropna=False).agg(
            days=("g", "size"), ghosts=("g", "sum")).reset_index()
        if fc is not None:
            f = fc[fc.route == str(route)].groupby(["direction_id", "start_secs"]).p_runs.mean()
            deps["p_runs_next"] = [round(float(f.get((str(d), s), np.nan)), 3) if (str(d), s) in f.index else None
                                   for d, s in zip(deps.direction_id.astype(str), deps.start_secs)]
        deps["time"] = deps.start_secs.map(hhmm)
        _w(f"routes/{rid}.json", {
            "route": route, "operator": op, "id": rid,
            "by_hour": [[int(h), int(r.n), int(r.ghosts)] for h, r in by_hour.iterrows()],
            "departures": deps.sort_values(["direction_id", "start_secs"]).drop(columns=["start_secs"]).to_dict("records"),
        })
        routes.append({"id": rid, "route": route, "operator": op, "scheduled": int(len(g)), "judged": int(len(jg)),
                       "ghosts": int(jg.g.sum()), "rate": round(float(jg.g.mean()), 4) if len(jg) else None,
                       "last7_ghosts": int(jg[jg.service_date > last - timedelta(days=7)].g.sum())})
    _w("routes.json", sorted(routes, key=lambda r: (-(r["rate"] or 0), r["route"])))

    worst = j[j.g == 1].sort_values(["service_date", "start_secs"], ascending=[False, True]).head(60)
    _w("recent_ghosts.json", [{"date": r.service_date, "time": hhmm(r.start_secs), "route": r.route, "operator": r.operator,
                               "from": r.from_stop, "to": r.to_stop} for r in worst.itertuples()])

    _w("model.json", evaluate(df))
    _route_shapes(df)


def _route_shapes(df):
    """One line per route: the stops of its longest trip on the latest day."""
    last = max(df.service_date)
    sched = C.SCHEDULE / str(last)
    if not (sched / "stop_times.csv.gz").exists():
        return
    st = pd.read_csv(sched / "stop_times.csv.gz", dtype={"trip_id": str})
    trips = df[df.service_date == last][["trip_id", "route", "operator", "n_stops"]]
    best = trips.sort_values("n_stops", ascending=False).drop_duplicates(["route", "operator"])
    feats = []
    for r in best.itertuples():
        s = st[st.trip_id == r.trip_id].sort_values("stop_sequence")
        feats.append({"id": slug(f"{r.route}-{r.operator}"), "route": r.route,
                      "path": [[round(a, 5), round(b, 5)] for a, b in zip(s.stop_lat, s.stop_lon)]})
    _w("shapes.json", feats)


if __name__ == "__main__":
    build()
    print("site data written to", C.SITE_DATA)
