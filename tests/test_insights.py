"""The per-stop ghost records, on a tiny made-up city."""
from datetime import date

import pandas as pd

from ghostbus import config as C
from ghostbus import insights


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
