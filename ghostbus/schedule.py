"""Timetable: download the regional GTFS from BODS, cut it down to the city,
and list every trip scheduled on a given service day.

GTFS times can go past 24:00:00 (a 25:10 departure is 01:10 the next
morning but belongs to the previous service day), so times are kept as
seconds after midnight of the service day.
"""
from __future__ import annotations

import io
import shutil
import sys
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C

CITY_GTFS = C.DATA / "city_gtfs"


def hms_to_secs(s: pd.Series) -> pd.Series:
    parts = s.str.split(":", expand=True).astype(int)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def download(dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(C.GTFS_URL, headers={"User-Agent": "ghost-bus/1.0 (github.com/Mohammed-890/ghost-bus)"})
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, length=1 << 20)
    return dest


def _read(z: zipfile.ZipFile, name: str, **kw) -> pd.DataFrame:
    if name not in z.namelist():
        return pd.DataFrame()
    with z.open(name) as f:
        return pd.read_csv(f, dtype=str, keep_default_na=False, **kw)


def cut_to_city(zip_path: Path, out: Path = CITY_GTFS, bbox=C.BBOX) -> dict:
    """Keep only stops inside the box and trips that call at one of them."""
    lat0, lat1, lon0, lon1 = bbox
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        stops = _read(z, "stops.txt")
        stops["stop_lat"] = pd.to_numeric(stops["stop_lat"], errors="coerce")
        stops["stop_lon"] = pd.to_numeric(stops["stop_lon"], errors="coerce")
        inside = stops[stops.stop_lat.between(lat0, lat1) & stops.stop_lon.between(lon0, lon1)]
        keep_stops = set(inside.stop_id)

        parts = []
        with z.open("stop_times.txt") as f:
            for chunk in pd.read_csv(f, dtype=str, keep_default_na=False, chunksize=1_000_000,
                                     usecols=["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"]):
                parts.append(chunk[chunk.stop_id.isin(keep_stops)])
        st = pd.concat(parts, ignore_index=True)
        trips = _read(z, "trips.txt")
        trips = trips[trips.trip_id.isin(set(st.trip_id))]
        routes = _read(z, "routes.txt")
        routes = routes[routes.route_id.isin(set(trips.route_id))]
        agency = _read(z, "agency.txt")
        cal = _read(z, "calendar.txt")
        cal_d = _read(z, "calendar_dates.txt")
        services = set(trips.service_id)
        if len(cal):
            cal = cal[cal.service_id.isin(services)]
        if len(cal_d):
            cal_d = cal_d[cal_d.service_id.isin(services)]

    t = st["departure_time"].where(st["departure_time"] != "", st["arrival_time"])
    st = st.assign(secs=hms_to_secs(t), stop_sequence=st.stop_sequence.astype(int))
    st = st[["trip_id", "stop_sequence", "stop_id", "secs"]].sort_values(["trip_id", "stop_sequence"])

    inside.to_csv(out / "stops.csv", index=False)
    st.to_csv(out / "stop_times.csv.gz", index=False)
    trips.to_csv(out / "trips.csv", index=False)
    routes.to_csv(out / "routes.csv", index=False)
    agency.to_csv(out / "agency.csv", index=False)
    cal.to_csv(out / "calendar.csv", index=False)
    cal_d.to_csv(out / "calendar_dates.csv", index=False)
    return {"stops": len(inside), "trips": len(trips), "routes": len(routes), "stop_times": len(st)}


def active_services(day: date, src: Path = CITY_GTFS) -> set[str]:
    ymd = day.strftime("%Y%m%d")
    cal = pd.read_csv(src / "calendar.csv", dtype=str, keep_default_na=False)
    active = set()
    if len(cal):
        wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][day.weekday()]
        on = cal[(cal[wd] == "1") & (cal.start_date <= ymd) & (cal.end_date >= ymd)]
        active = set(on.service_id)
    path = src / "calendar_dates.csv"
    if path.exists() and path.stat().st_size > 1:
        cd = pd.read_csv(path, dtype=str, keep_default_na=False)
        if len(cd):
            today = cd[cd.date == ymd]
            active |= set(today[today.exception_type == "1"].service_id)
            active -= set(today[today.exception_type == "2"].service_id)
    return active


def day_schedule(day: date, src: Path = CITY_GTFS) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Trips running on `day` (one row each) and their in-city stop times."""
    services = active_services(day, src)
    trips = pd.read_csv(src / "trips.csv", dtype=str, keep_default_na=False)
    trips = trips[trips.service_id.isin(services)]
    routes = pd.read_csv(src / "routes.csv", dtype=str, keep_default_na=False)
    # Trams and light rail aren't in the bus location feed, so they can't be judged.
    if "route_type" in routes:
        rail = set(routes.loc[routes.route_type.isin(["0", "1", "2", "900", "901", "902", "905", "906"]), "route_id"])
        trips = trips[~trips.route_id.isin(rail)]
    agency = pd.read_csv(src / "agency.csv", dtype=str, keep_default_na=False)
    stops = pd.read_csv(src / "stops.csv", dtype={"stop_id": str})
    st = pd.read_csv(src / "stop_times.csv.gz", dtype={"trip_id": str, "stop_id": str})
    st = st[st.trip_id.isin(set(trips.trip_id))].merge(stops[["stop_id", "stop_name", "stop_lat", "stop_lon"]], on="stop_id", how="left")

    g = st.groupby("trip_id")
    span = g.agg(start_secs=("secs", "min"), end_secs=("secs", "max"), n_stops=("secs", "size"))
    first = st.loc[g.secs.idxmin(), ["trip_id", "stop_name"]].set_index("trip_id").stop_name.rename("from_stop")
    last = st.loc[g.secs.idxmax(), ["trip_id", "stop_name"]].set_index("trip_id").stop_name.rename("to_stop")
    out = trips.set_index("trip_id")[[c for c in ["route_id", "direction_id", "trip_headsign"] if c in trips]].join([span, first, last])
    r = routes.set_index("route_id")
    out["route"] = out.route_id.map(r.get("route_short_name", r.get("route_long_name")))
    out["agency_id"] = out.route_id.map(r["agency_id"]) if "agency_id" in r else ""
    a = agency.set_index("agency_id")["agency_name"] if len(agency) else pd.Series(dtype=str)
    out["operator"] = out.agency_id.map(a).fillna(out.agency_id)
    out["service_date"] = day.isoformat()
    out = out.reset_index().sort_values(["route", "start_secs"])
    return out, st


def secs_to_dt(day: date, secs) -> datetime:
    """Wall-clock time for `secs` after the service day's midnight (local)."""
    base = datetime(day.year, day.month, day.day, tzinfo=C.TZ)
    return base + timedelta(seconds=int(secs))


def write_day(day: date) -> Path:
    trips, st = day_schedule(day)
    out = C.SCHEDULE / day.isoformat()
    out.mkdir(parents=True, exist_ok=True)
    trips.to_csv(out / "trips.csv.gz", index=False)
    # Keep only the stops the matcher samples (first, last and evenly spaced between).
    st = st.sort_values(["trip_id", "stop_sequence"]).reset_index(drop=True)
    pos = st.groupby("trip_id").cumcount().to_numpy()
    size = st.groupby("trip_id").trip_id.transform("size").to_numpy()
    keep = size <= C.SAMPLE_STOPS
    for n in np.unique(size[~keep]):            # same rule as match._sample
        picks = np.unique(np.linspace(0, n - 1, C.SAMPLE_STOPS).round().astype(int))
        keep |= (size == n) & np.isin(pos, picks)
    smp = st[keep]
    smp[["trip_id", "stop_sequence", "stop_id", "secs", "stop_lat", "stop_lon"]].to_csv(out / "stop_times.csv.gz", index=False)
    return out


if __name__ == "__main__":
    # python -m ghostbus.schedule refresh       -> download + cut
    # python -m ghostbus.schedule day 2026-11-02 -> write that day's schedule
    cmd = sys.argv[1]
    if cmd == "refresh":
        zp = download(C.DATA / "cache" / "region.zip")
        print(cut_to_city(zp))
        zp.unlink()
    elif cmd == "day":
        d = date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else datetime.now(C.TZ).date()
        print(write_day(d))
