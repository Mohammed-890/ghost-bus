"""Daily job: judge, monitor, retrain if needed, predict tomorrow, publish.

    GHOSTBUS_DATA=store python -m ghostbus.daily

1. refresh the timetable weekly and write today's and tomorrow's schedule
2. judge every finished day (match.py)
3. score yesterday's predictions against what actually happened
4. check the champion for data drift
5. retrain if triggered; the champion gate decides what goes live (train.py)
6. store the champion's predictions for tomorrow (scored tomorrow, step 3)
7. push metrics and rebuild the website data
"""
from __future__ import annotations

import time
from datetime import date, datetime, timedelta

import pandas as pd

from . import config as C
from . import match, monitor, publish, schedule, train
from .model import load_results
from .registry import get_registry


def main(force_retrain: bool = False):
    city = C.DATA / "city_gtfs" / "trips.csv"
    if not city.exists() or time.time() - city.stat().st_mtime > 6 * 86400:
        print("refreshing timetable…")
        zp = schedule.download(C.DATA / "cache" / "region.zip")
        print(schedule.cut_to_city(zp))
        zp.unlink()

    today = datetime.now(C.TZ).date()
    tomorrow = today + timedelta(days=1)
    for d in (today, tomorrow):
        if not (C.SCHEDULE / d.isoformat() / "trips.csv.gz").exists():
            print("schedule", schedule.write_day(d))

    # 2. judge every collected day that has finished (trips run past midnight, so wait until 05:00 next day)
    days = sorted(date.fromisoformat(p.name) for p in C.RAW.iterdir() if p.is_dir()) if C.RAW.exists() else []
    now = datetime.now(C.TZ)
    new_days = []
    for d in days:
        if now < schedule.secs_to_dt(d + timedelta(days=1), 5 * 3600):
            continue
        if (C.RESULTS / f"{d.isoformat()}.csv.gz").exists():
            continue
        if not (C.SCHEDULE / d.isoformat() / "trips.csv.gz").exists():
            schedule.write_day(d)
        r = match.run_day(d)
        new_days.append((d, r))
        print(d, r.verdict.value_counts().to_dict())

    results = load_results()
    registry = get_registry()
    champ = registry.champion()

    # 3. live accuracy of the predictions made for each newly judged day
    for d, r in new_days:
        s = monitor.score_day(d, r)
        if s:
            print("live accuracy", d, s)

    # 4–5. drift, then retrain if triggered
    drift = monitor.drift_now(champ, results) if len(results) else {}
    decision = {"action": "skip", "reason": "no results yet"}
    if len(results):
        tomorrow_sched = pd.read_csv(C.SCHEDULE / tomorrow.isoformat() / "trips.csv.gz",
                                     dtype={"trip_id": str, "route": str, "route_id": str, "direction_id": str})
        decision = train.run(results, tomorrow_sched, registry, live=monitor.read_jsonl("live.jsonl"),
                             force=force_retrain)
        decision["day"] = today.isoformat()
        monitor.record_decision(decision)
        print("training decision:", {k: v for k, v in decision.items() if k != "report"})
        if decision.get("action") == "promoted":
            champ = registry.champion()

        # 6. the champion's predictions for tomorrow
        if champ is not None:
            print("predictions saved:", monitor.save_predictions(champ, tomorrow_sched, results))

    # 7. metrics + website
    last = new_days[-1][1] if new_days else None
    judged = last[last.verdict.isin(["ran_tracked", "ran_matched", "ghost"])] if last is not None else None
    live = monitor.read_jsonl("live.jsonl")
    values = {
        "judged_trips": ("Trips judged on the latest day", len(judged) if judged is not None else None),
        "ghost_rate": ("Share of judged trips that never ran", (judged.verdict == "ghost").mean() if judged is not None and len(judged) else None),
        "feed_ok_share": ("Share of polls the live feed answered", last.feed_ok_share.iloc[0] if last is not None and len(last) else None),
        "live_brier": ("Brier score of yesterday's predictions", live[-1]["brier"] if live else None),
        "psi_max": ("Largest feature PSI against the champion's training data", drift.get("psi_max")),
        "champion_version": ("Registered version of the live model", champ.meta.get("version") if champ else None),
        "promoted": ("1 if a new model was promoted today", 1 if decision.get("action") == "promoted" else 0),
        "last_success_timestamp_seconds": ("When the daily job last finished", time.time()),
    }
    try:
        monitor.push_metrics(values)
    except Exception as e:  # monitoring must never break the pipeline
        print("pushgateway unavailable:", e)
    try:
        registry.log_metrics(f"daily-{today}", {k: v for k, (_, v) in values.items() if v is not None})
    except Exception as e:
        print("could not log monitoring metrics:", e)
    publish.build()


if __name__ == "__main__":
    import sys
    main(force_retrain="--retrain" in sys.argv)
