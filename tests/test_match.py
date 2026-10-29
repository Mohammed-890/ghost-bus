"""Synthetic day that exercises every verdict rule."""
from datetime import date

import numpy as np
import pandas as pd

from ghostbus import config as C
from ghostbus.match import classify
from ghostbus.schedule import secs_to_dt

DAY = date(2026, 11, 2)
T0 = secs_to_dt(DAY, 0).timestamp()

# A straight route: 10 stops, 400 m apart, 2 minutes apart.
STOPS = [(53.38 + i * 0.0036, -1.47) for i in range(10)]


def trip(tid, start_h, agency="A", route="R1", short="52"):
    start = int(start_h * 3600)
    return dict(trip_id=tid, route_id=route, route=short, operator="Op" + agency, agency_id=agency, direction_id="0",
                trip_headsign="City", from_stop="S0", to_stop="S9", start_secs=start, end_secs=start + 9 * 120,
                n_stops=10)


def stop_times(t):
    return [dict(trip_id=t["trip_id"], stop_sequence=i, stop_id=f"S{i}", secs=t["start_secs"] + i * 120,
                 stop_lat=lat, stop_lon=lon) for i, (lat, lon) in enumerate(STOPS)]


def drive(t, vehicle, trip_id="", late_s=180, every=60):
    """Pings for a bus running trip t, `late_s` late, optionally tagged."""
    rows = []
    for s in range(t["start_secs"] - 120, t["end_secs"] + 300, every):
        k = np.clip((s - late_s - t["start_secs"]) / 120, 0, 9)
        lat = STOPS[0][0] + k * 0.0036
        rows.append(dict(poll_ts=int(T0 + s), ts=int(T0 + s), vehicle_id=vehicle, trip_id=trip_id, route_id="",
                         start_date="", start_time="", lat=lat, lon=-1.47))
    return rows


def polls(from_h, to_h, gap=None):
    rows = []
    for s in range(int(from_h * 3600), int(to_h * 3600), 60):
        ok = not (gap and gap[0] * 3600 <= s < gap[1] * 3600)
        rows.append(dict(poll_ts=int(T0 + s), ok=int(ok), http=200 if ok else 503, entities=5, with_trip=3, ms=100,
                         error=""))
    return pd.DataFrame(rows)


def heartbeat(agency_trip_id, from_h, to_h, vehicle="HB"):
    """Another bus of the operator, tagged, so the operator counts as reporting."""
    return [dict(poll_ts=int(T0 + s), ts=int(T0 + s), vehicle_id=vehicle, trip_id=agency_trip_id, route_id="",
                 start_date="", start_time="", lat=53.30, lon=-1.40) for s in range(int(from_h * 3600), int(to_h * 3600), 60)]


def scenario():
    t = {
        "tracked": trip("T1", 8.0),
        "matched": trip("T2", 9.0),
        "ghost": trip("T3", 10.0),
        "op_dark": trip("T4", 11.0, agency="B", route="R2", short="X1"),
        "op_dark_seen": trip("T9", 15.0, agency="B", route="R2", short="X1"),
        "gap": trip("T5", 12.0),
        "pair_a": trip("T6", 13.0),
        "pair_b": trip("T7", 13.05),
        "unfinished": trip("T8", 23.5),
        "hb": trip("HBT", 6.0, route="R9", short="99"),
        "b_hb": trip("HBB", 6.0, agency="B", route="R8", short="98"),
    }
    trips = pd.DataFrame(t.values())
    st = pd.DataFrame([r for v in t.values() for r in stop_times(v)])
    pings = []
    pings += drive(t["tracked"], "V1", trip_id="T1")
    pings += drive(t["matched"], "V2")                     # untagged, follows T2
    pings += drive(t["op_dark_seen"], "V4")                # B never tags trips, but its bus is seen on the route
    pings += drive(t["pair_a"], "V6", late_s=120)          # one untagged bus for two close trips
    pings += heartbeat("HBT", 6, 23.9)                     # operator A reporting all day
    pings += heartbeat("HBB", 6, 7, vehicle="HB2")         # operator B only reports early morning
    health = polls(6, 23.9, gap=(11.9, 12.5))
    return trips, st, pd.DataFrame(pings), health


def test_every_verdict():
    trips, st, pings, health = scenario()
    r = classify(DAY, trips, st, pings, health).set_index("trip_id")
    assert r.loc["T1", "verdict"] == "ran_tracked"
    assert r.loc["T2", "verdict"] == "ran_matched" and r.loc["T2", "vehicle_id"] == "V2"
    assert r.loc["T3", "verdict"] == "ghost"
    assert r.loc["T4", "verdict"] == "unknown" and "operator" in r.loc["T4", "reason"]   # no bus, can't blame
    assert r.loc["T9", "verdict"] == "ran_matched"                                         # seen by position
    assert r.loc["T5", "verdict"] == "unknown" and "feed gap" in r.loc["T5", "reason"]
    # one bus explains exactly one of two overlapping trips
    assert sorted([r.loc["T6", "verdict"], r.loc["T7", "verdict"]]) == ["ghost", "ran_matched"]
    assert r.loc["T8", "verdict"] == "unknown" and "not finished" in r.loc["T8", "reason"]


def test_wrong_day_trip_id_is_not_a_match():
    trips, st, pings, health = scenario()
    pings.loc[pings.trip_id == "T1", "start_date"] = "20261101"   # yesterday's T1
    r = classify(DAY, trips, st, pings, health).set_index("trip_id")
    assert r.loc["T1", "verdict"] != "ran_tracked"


def test_bus_far_away_is_not_a_match():
    trips, st, pings, health = scenario()
    m = pings.vehicle_id == "V2"
    pings.loc[m, "lon"] = -1.40                                   # ~4.6 km east of the route
    r = classify(DAY, trips, st, pings, health).set_index("trip_id")
    assert r.loc["T2", "verdict"] == "ghost"


def test_bus_driving_backwards_is_not_a_match():
    trips, st, pings, health = scenario()
    m = pings.vehicle_id == "V2"
    lat = pings.loc[m, "lat"].to_numpy()
    pings.loc[m, "lat"] = lat[::-1]                               # passes the stops in reverse order
    r = classify(DAY, trips, st, pings, health).set_index("trip_id")
    assert r.loc["T2", "verdict"] == "ghost"


def test_no_polls_means_no_verdicts():
    trips, st, pings, _ = scenario()
    r = classify(DAY, trips, st, pings, pd.DataFrame())
    assert (r.verdict == "unknown").all()
