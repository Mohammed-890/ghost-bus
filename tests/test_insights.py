"""The replay, patterns and weekly report builders, on a tiny made-up city."""
import gzip
from datetime import date, datetime

import pandas as pd

from ghostbus import config as C
from ghostbus import insights


def _results(days, ghost_every=10):
    rows = []
    for d in days:
        for k in range(120):
            route = "52" if k % 2 else "X1"
            rows.append({"trip_id": f"{d}-{k}", "route": route, "operator": "Op", "direction_id": "0",
                         "start_secs": 6 * 3600 + k * 300, "from_stop": "A", "to_stop": "B",
                         "verdict": "ghost" if k % ghost_every == 0 else "ran_tracked", "service_date": d})
    return pd.DataFrame(rows)


def test_patterns_counts_by_weekday_and_hour():
    days = [date(2026, 11, d) for d in range(2, 9)]
    p = insights.build_patterns(_results(days), min_route=10)
    total = sum(c[2] for c in p["city"])
    ghosts = sum(c[3] for c in p["city"])
    assert total == 7 * 120 and ghosts == 7 * 12
    assert {wd for wd, *_ in p["city"]} == set(range(7))
    assert "52-op" in p["routes"] and "x1-op" in p["routes"]


def test_weekly_compares_with_the_week_before():
    early = _results([date(2026, 11, d) for d in range(2, 9)], ghost_every=40)
    late = _results([date(2026, 11, d) for d in range(9, 16)], ghost_every=10)
    w = insights.build_weekly(pd.concat([early, late]))
    assert w["from"] == "2026-11-09" and w["to"] == "2026-11-15"
    assert w["rate"] > w["prev"]["rate"]
    assert w["worst"] and w["worst"][0]["prev_rate"] is not None
    assert w["ghost_of_the_week"]["ghost_days"] == 7


def test_replay_encodes_tracks_and_ghost_paths(tmp_path, monkeypatch):
    monkeypatch.setattr(C, "RAW", tmp_path / "raw")
    monkeypatch.setattr(C, "SCHEDULE", tmp_path / "schedule")
    monkeypatch.setattr(C, "DATA", tmp_path)
    day = date(2026, 11, 16)
    (C.RAW / day.isoformat()).mkdir(parents=True)
    t0 = int(datetime(2026, 11, 16, 8, 0, tzinfo=C.TZ).timestamp())
    pings = pd.DataFrame([{"poll_ts": t0 + 60 * k, "ts": t0 + 60 * k, "vehicle_id": "V1", "trip_id": "T1", "route_id": "R",
                           "start_date": "20261116", "start_time": "08:00:00", "lat": 53.38 + k * 0.001, "lon": -1.47, "bearing": 0}
                          for k in range(20)])
    with gzip.open(C.RAW / day.isoformat() / "08.csv.gz", "wt") as f:
        pings.to_csv(f, index=False)
    (C.SCHEDULE / day.isoformat()).mkdir(parents=True)
    st = pd.DataFrame([{"trip_id": "G1", "stop_sequence": k, "stop_id": str(k), "secs": 9 * 3600 + k * 120,
                        "stop_lat": 53.40, "stop_lon": -1.50 + k * 0.002} for k in range(5)])
    st.to_csv(C.SCHEDULE / day.isoformat() / "stop_times.csv.gz", index=False, compression="gzip")
    res = pd.DataFrame([
        {"trip_id": "T1", "route": "52", "operator": "Op", "start_secs": 8 * 3600, "from_stop": "A", "to_stop": "B", "verdict": "ran_tracked", "service_date": day},
        {"trip_id": "G1", "route": "7", "operator": "Op", "start_secs": 9 * 3600, "from_stop": "C", "to_stop": "D", "verdict": "ghost", "service_date": day}])
    rp = insights.build_replay(day, res)
    assert rp["totals"]["vehicles"] == 1 and rp["totals"]["ghosts"] == 1
    route, flat = rp["buses"][0]
    assert route == "52"
    # undo the delta encoding: slots climb, latitude climbs
    s = la = 0
    slots, lats = [], []
    for k in range(0, len(flat), 3):
        s += flat[k]
        la += flat[k + 1]
        slots.append(s)
        lats.append(la)
    assert slots == sorted(slots) and lats == sorted(lats) and slots[0] == 8 * 3600 // insights.STEP
    g = rp["ghosts"][0]
    assert g[0] == "7" and g[2] == "09:00" and len(g[5]) == 15


def test_stops_count_every_stop_a_ghost_should_have_served(tmp_path, monkeypatch):
    monkeypatch.setattr(C, "DATA", tmp_path)
    g = tmp_path / "city_gtfs"
    g.mkdir()
    pd.DataFrame([{"trip_id": t, "stop_sequence": k, "stop_id": s, "secs": 0}
                  for t in ("T1", "T2") for k, s in enumerate(["S1", "S2"])]).to_csv(g / "stop_times.csv.gz", index=False, compression="gzip")
    pd.DataFrame([{"stop_id": "S1", "stop_name": "One", "stop_lat": 53.38, "stop_lon": -1.47},
                  {"stop_id": "S2", "stop_name": "Two", "stop_lat": 53.39, "stop_lon": -1.46}]).to_csv(g / "stops.csv", index=False)
    res = pd.DataFrame([{"trip_id": "T1", "verdict": "ghost", "service_date": date(2026, 11, 16)},
                        {"trip_id": "T2", "verdict": "ran_tracked", "service_date": date(2026, 11, 16)}])
    d = insights.build_stops(res, min_n=1)
    rows = {r[1]: r for r in d["stops"]}
    assert rows["One"][4:6] == [2, 1] and rows["Two"][4:6] == [2, 1]
