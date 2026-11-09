from datetime import date, datetime

import pandas as pd

from ghostbus import board, config as C
from ghostbus.schedule import secs_to_dt


def test_after_midnight_still_belongs_to_yesterdays_timetable():
    assert board.service_day(datetime(2026, 11, 10, 1, 30, tzinfo=C.TZ)) == date(2026, 11, 9)
    assert board.service_day(datetime(2026, 11, 10, 9, 0, tzinfo=C.TZ)) == date(2026, 11, 10)


def _trips():
    base = dict(route="52", operator="Stagecoach", direction_id="0", from_stop="A", to_stop="B")
    return pd.DataFrame([
        {**base, "trip_id": "t1", "start_secs": 8 * 3600, "end_secs": 9 * 3600},
        {**base, "trip_id": "t1-copy", "start_secs": 8 * 3600, "end_secs": 9 * 3600},   # duplicate timetable entry
        {**base, "trip_id": "t2", "start_secs": 10 * 3600, "end_secs": 11 * 3600},
        {**base, "trip_id": "t3", "start_secs": 18 * 3600, "end_secs": 19 * 3600},
        {**base, "trip_id": "t4", "start_secs": 12 * 3600, "end_secs": 13 * 3600},
    ])


def test_status_letters_follow_verdicts_and_live_buses():
    day = date(2026, 11, 9)
    deps, alias = board.departures(_trips())
    assert list(deps.trip_id) == ["t1", "t2", "t4", "t3"] and alias["t1-copy"] == "t1"
    verdicts = pd.DataFrame({"trip_id": ["t1", "t2", "t3", "t4"],
                             "verdict": ["ran_tracked", "ghost", "unknown", "unknown"],
                             "reason": ["", "", "not finished when last checked", "operator not reporting (0%)"]})
    now = secs_to_dt(day, 17 * 3600 + 45 * 60).timestamp()
    pings = pd.DataFrame({"trip_id": ["t1-copy"], "ts": [now - 900], "lat": [53.4], "lon": [-1.5]})  # old report: not live
    letters, buses, counts = board.status(day, deps, alias, verdicts, pings, now)
    assert letters == "RGNS" and buses == []
    pings = pd.DataFrame({"trip_id": ["t3"], "ts": [now - 60], "lat": [53.4], "lon": [-1.5]})       # t3's bus is out
    letters, buses, _ = board.status(day, deps, alias, verdicts, pings, now)
    assert letters == "RGNO" and buses == [[3, 53.4, -1.5, 1]]
