"""End to end on disk: GTFS zip -> city cut -> day schedule -> raw pings -> verdicts -> site JSON."""
import importlib
import io
import json
import zipfile
from datetime import date

import pandas as pd


def make_gtfs(path, day):
    stops = "stop_id,stop_name,stop_lat,stop_lon\n" + "".join(
        f"S{i},Stop {i},{53.38 + i * 0.0036},-1.47\n" for i in range(10)) + "FAR,Leeds,53.80,-1.55\n"
    trips = "route_id,service_id,trip_id,direction_id,trip_headsign\n" + \
        "R1,WK,T1,0,City\nR1,WK,T2,0,City\nR1,WK,T3,0,City\nR9,WK,HBT,0,Depot\nRX,WK,LEEDS,0,Leeds\n"
    st = ["trip_id,arrival_time,departure_time,stop_id,stop_sequence"]
    for tid, h in [("T1", 8), ("T2", 9), ("T3", 10), ("HBT", 6)]:
        for i in range(10):
            t = f"{h:02d}:{i * 2:02d}:00"
            st.append(f"{tid},{t},{t},S{i},{i}")
    st.append("LEEDS,10:00:00,10:00:00,FAR,0")
    routes = "route_id,agency_id,route_short_name,route_type\nR1,A,52,3\nR9,A,99,3\nRX,A,X,3\n"
    agency = "agency_id,agency_name,agency_url,agency_timezone\nA,Test Buses,http://x,Europe/London\n"
    wd = ["0"] * 7
    wd[day.weekday()] = "1"
    cal = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" + \
        f"WK,{','.join(wd)},20260101,20271231\n"
    with zipfile.ZipFile(path, "w") as z:
        for n, s in [("stops.txt", stops), ("trips.txt", trips), ("stop_times.txt", "\n".join(st) + "\n"),
                     ("routes.txt", routes), ("agency.txt", agency), ("calendar.txt", cal),
                     ("calendar_dates.txt", "service_id,date,exception_type\n")]:
            z.writestr(n, s)


def test_full_pipeline(tmp_path, monkeypatch):
    monkeypatch.setenv("GHOSTBUS_DATA", str(tmp_path / "store"))
    from ghostbus import config
    importlib.reload(config)
    from ghostbus import schedule, match, collect, publish, model
    for m in (schedule, match, collect, model, publish):
        importlib.reload(m)
    monkeypatch.setattr(config, "SITE_DATA", tmp_path / "site")

    day = date(2026, 11, 2)
    zp = tmp_path / "region.zip"
    make_gtfs(zp, day)
    info = schedule.cut_to_city(zp)
    assert info["trips"] == 4                     # the Leeds-only trip is dropped
    schedule.write_day(day)

    from tests.test_match import drive, heartbeat, polls, trip
    t1, t2 = trip("T1", 8.0), trip("T2", 9.0)
    pings = pd.DataFrame(drive(t1, "V1", trip_id="T1") + drive(t2, "V2") + heartbeat("HBT", 6, 23.9))
    health = polls(6, 23.9)
    stamp = day.isoformat()
    for h, g in pings.assign(h=pd.to_datetime(pings.ts, unit="s", utc=True).dt.tz_convert(config.TZ).dt.hour).groupby("h"):
        collect._append(config.RAW / stamp / f"{h:02d}.csv.gz", collect.FIELDS,
                        g[["poll_ts", "ts", "vehicle_id", "trip_id", "route_id", "start_date", "start_time", "lat", "lon"]]
                        .assign(bearing="").values.tolist())
    collect._append(config.HEALTH / f"{stamp}.csv.gz", collect.HEALTH_FIELDS, health.values.tolist())

    r = match.run_day(day).set_index("trip_id")
    assert r.loc["T1", "verdict"] == "ran_tracked"
    assert r.loc["T2", "verdict"] == "ran_matched"
    assert r.loc["T3", "verdict"] == "ghost"

    publish.build()
    s = json.loads((tmp_path / "site" / "summary.json").read_text())
    assert s["ghosts"] == 1 and s["judged"] == 4
    routes = json.loads((tmp_path / "site" / "routes.json").read_text())
    r52 = next(x for x in routes if x["route"] == "52")
    assert r52["ghosts"] == 1 and r52["judged"] == 3
    detail = json.loads((tmp_path / "site" / "routes" / f"{r52['id']}.json").read_text())
    assert [d["time"] for d in detail["departures"]] == ["08:00", "09:00", "10:00"]
    assert (tmp_path / "site" / "shapes.json").exists()
