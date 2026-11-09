"""Turn the daily verdicts into the small JSON files the website reads."""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from . import config as C
from .model import evaluate, load_results

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

    # the champion's stored predictions for the next day (written by the daily job)
    fc = None
    preds = sorted(C.DATA.joinpath("predictions").glob("*.csv.gz")) if C.DATA.joinpath("predictions").exists() else []
    if preds:
        fc = pd.read_csv(preds[-1], dtype={"route": str, "direction_id": str})
        fc["direction_id"] = fc.direction_id.fillna("").astype(str)

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
    _w("monitoring.json", monitoring_summary())
    _route_shapes(df)


def monitoring_summary():
    from .monitor import read_jsonl

    live, drift, decisions = read_jsonl("live.jsonl"), read_jsonl("drift.jsonl"), read_jsonl("decisions.jsonl")
    return {"live": live[-30:], "drift": drift[-1] if drift else None,
            "decisions": [d for d in decisions if d.get("action") in ("promoted", "rejected")][-10:],
            "last_decision": decisions[-1] if decisions else None}


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


def refresh_health():
    """Cheap update after each collector run: keep the published summary as it
    is, but refresh the live-feed health so the site shows collection is live."""
    path = C.SITE_DATA / "summary.json"
    try:
        summary = json.loads(path.read_text())
    except (OSError, ValueError):  # missing or damaged: start a fresh one, the daily job fills the rest
        summary = {"status": "collecting", "city": C.CITY}
    summary["health"] = health_summary()
    summary["updated"] = datetime.now(C.TZ).isoformat(timespec="minutes")
    _w("summary.json", summary)
    live_positions()


def live_positions(max_age_s: int = 600):
    """Every bus at the latest poll (reports older than 10 minutes left out),
    so the website can show the city's buses right now."""
    days = sorted(p for p in C.RAW.iterdir() if p.is_dir()) if C.RAW.exists() else []
    files = sorted(days[-1].glob("*.csv.gz")) if days else []
    if not files:
        return
    df = pd.read_csv(files[-1], dtype={"route_id": str, "vehicle_id": str})
    if df.empty:
        return
    at = int(df.poll_ts.max())
    now = df[(df.poll_ts == at) & (at - df.ts.fillna(0) <= max_age_s)].drop_duplicates("vehicle_id")
    names = {}
    routes = C.DATA / "city_gtfs" / "routes.csv"
    if routes.exists():
        r = pd.read_csv(routes, dtype=str)
        names = dict(zip(r.route_id, r.route_short_name))
    buses = [[round(float(x.lat), 5), round(float(x.lon), 5), names.get(str(x.route_id), "") if isinstance(x.route_id, str) else "",
              int(x.bearing) if pd.notna(x.bearing) and x.bearing >= 0 else None]
             for x in now.itertuples()]
    _w("live.json", {"at": datetime.fromtimestamp(at, C.TZ).isoformat(timespec="minutes"), "buses": buses})


if __name__ == "__main__":
    import sys

    if "--health" in sys.argv:
        refresh_health()
    else:
        build()
    print("site data written to", C.SITE_DATA)
