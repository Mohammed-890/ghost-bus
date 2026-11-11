from datetime import date, datetime

import numpy as np
import pandas as pd

from ghostbus import board, config as C
from ghostbus.schedule import secs_to_dt

DAY = date(2026, 11, 9)


def test_after_midnight_still_belongs_to_yesterdays_timetable():
    assert board.service_day(datetime(2026, 11, 10, 1, 30, tzinfo=C.TZ)) == date(2026, 11, 9)
    assert board.service_day(datetime(2026, 11, 10, 9, 0, tzinfo=C.TZ)) == date(2026, 11, 10)


# a straight east-west road with three stops 1 km apart, 3 minutes between stops
LAT = 53.38
LONS = np.array([-1.50, -1.50 + 1000 / (111_320 * np.cos(np.radians(LAT))), -1.50 + 2000 / (111_320 * np.cos(np.radians(LAT)))])


def test_projection_gives_progress_and_timetabled_time():
    secs = np.array([36000.0, 36180.0, 36360.0])
    dist, sched, pos = board.project(LAT + 0.0005, (LONS[0] + LONS[1]) / 2, np.full(3, LAT), LONS, secs, 36100)
    assert 50 < dist < 60                         # 0.0005° of latitude ≈ 55 m off the road
    assert abs(pos - 0.5) < 0.01 and abs(sched - 36090) < 2


def _deps():
    base = dict(route="52", operator="Stagecoach", direction_id="0", from_stop="A", to_stop="C", route_id="R52", trip_headsign="C")
    trips = pd.DataFrame([
        {**base, "trip_id": "t1000", "start_secs": 36000, "end_secs": 36360},
        {**base, "trip_id": "t1010", "start_secs": 36600, "end_secs": 36960},   # ten minutes later
        {**base, "trip_id": "t1000-copy", "start_secs": 36000, "end_secs": 36360},
    ])
    deps, alias = board.departures(trips)
    calls = {t: (["A", "B", "C"], np.full(3, LAT), LONS, np.array([0.0, 180.0, 360.0]) + s)
             for t, s in (("t1000", 36000), ("t1010", 36600))}
    return deps, alias, calls


def _ping(vehicle, trip, route, lon, at_secs, poll):
    return {"vehicle_id": vehicle, "trip_id": trip, "route_id": route, "lat": LAT, "lon": lon, "bearing": 90,
            "ts": secs_to_dt(DAY, at_secs).timestamp(), "poll_ts": secs_to_dt(DAY, poll).timestamp()}


def test_reported_trip_is_used_even_through_a_duplicate_id():
    deps, alias, calls = _deps()
    now = 36200
    pings = pd.DataFrame([_ping("bus1", "t1000-copy", "R52", LONS[1], now, now)])
    assigned, vehicles = board.track(DAY, deps, alias, calls, pings, secs_to_dt(DAY, now).timestamp())
    assert list(assigned) == [0] and assigned[0]["how"] == "r"
    assert abs(assigned[0]["delay"] - (now - 36180) / 60) < 0.1
    assert vehicles[0][4] == 0 and vehicles[0][7] == "r"


def test_untagged_bus_is_matched_to_the_departure_its_track_fits():
    deps, alias, calls = _deps()
    # a bus with no trip id that left A at 10:11 and reached B at 10:14: one minute late for the 10:10,
    # and nowhere near the 10:00, which would have it ten minutes late and standing still
    now = 36600 + 180 + 60       # 10:14, one minute late at B for the 10:10
    pings = pd.DataFrame([
        _ping("bus2", "", "R52", LONS[0], 36600 + 60, 36600 + 60),
        _ping("bus2", "", "R52", (LONS[0] + LONS[1]) / 2, 36600 + 150, 36600 + 150),
        _ping("bus2", "", "R52", LONS[1], now, now),
    ])
    assigned, _ = board.track(DAY, deps, alias, calls, pings, secs_to_dt(DAY, now).timestamp())
    assert list(assigned) == [1] and assigned[1]["how"] == "i"
    assert abs(assigned[1]["delay"] - 1.0) < 0.1


def test_status_letters_follow_live_buses_and_verdicts():
    deps, alias, calls = _deps()
    verdicts = pd.DataFrame({"trip_id": ["t1000", "t1010"], "verdict": ["ghost", "unknown"],
                             "reason": ["", "not finished when last checked"]})
    now = secs_to_dt(DAY, 36000 + 60).timestamp()
    letters, live, counts = board.status(DAY, deps, verdicts, {}, now)
    assert letters == "GS" and live == []
    fake = {"how": "i", "delay": 2.4, "pos": 1.5, "r": pd.Series({"lat": LAT, "lon": LONS[1], "ts": now - 30})}
    letters, live, _ = board.status(DAY, deps, verdicts, {1: fake}, now)
    assert letters == "GO" and live == [[1, 2, 1.5, round(LAT, 5), round(float(LONS[1]), 5), 30, "i"]]
