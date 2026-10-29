"""Daily job: refresh the timetable weekly, judge every finished day, rebuild the site data.

    GHOSTBUS_DATA=store python -m ghostbus.daily
"""
from __future__ import annotations

import time
from datetime import date, datetime, timedelta

from . import config as C
from . import match, publish, schedule


def main():
    city = C.DATA / "city_gtfs" / "trips.csv"
    if not city.exists() or time.time() - city.stat().st_mtime > 6 * 86400:
        print("refreshing timetable…")
        zp = schedule.download(C.DATA / "cache" / "region.zip")
        print(schedule.cut_to_city(zp))
        zp.unlink()

    today = datetime.now(C.TZ).date()
    for d in (today, today + timedelta(days=1)):
        if not (C.SCHEDULE / d.isoformat() / "trips.csv.gz").exists():
            print("schedule", schedule.write_day(d))

    # judge every collected day that has finished (trips run past midnight, so wait until 05:00 next day)
    days = sorted(date.fromisoformat(p.name) for p in C.RAW.iterdir() if p.is_dir()) if C.RAW.exists() else []
    now = datetime.now(C.TZ)
    for d in days:
        done_after = schedule.secs_to_dt(d + timedelta(days=1), 5 * 3600)
        if now < done_after:
            continue
        if (C.RESULTS / f"{d.isoformat()}.csv.gz").exists():
            continue
        if not (C.SCHEDULE / d.isoformat() / "trips.csv.gz").exists():
            schedule.write_day(d)
        r = match.run_day(d)
        print(d, r.verdict.value_counts().to_dict())
    publish.build()


if __name__ == "__main__":
    main()
