"""Record live bus positions from the Bus Open Data Service.

Runs for a fixed time (GitHub Actions jobs are capped), polling the GTFS-RT
feed for the city every POLL_SECONDS. Every poll is logged, including
failures, so the analysis knows exactly when the feed was and wasn't
watched. A bus that wasn't seen during a gap is never called a ghost.

    BODS_API_KEY=... python -m ghostbus.collect --minutes 55
"""
from __future__ import annotations

import argparse
import csv
import gzip
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from google.transit import gtfs_realtime_pb2

from . import config as C

FIELDS = ["poll_ts", "ts", "vehicle_id", "trip_id", "route_id", "start_date", "start_time", "lat", "lon", "bearing"]
HEALTH_FIELDS = ["poll_ts", "ok", "http", "entities", "with_trip", "ms", "error"]


def fetch(api_key: str) -> bytes:
    lat0, lat1, lon0, lon1 = C.BBOX
    q = urllib.parse.urlencode({"boundingBox": f"{lon0},{lat0},{lon1},{lat1}", "api_key": api_key})
    req = urllib.request.Request(f"{C.GTFS_RT_URL}?{q}", headers={"User-Agent": "ghost-bus/1.0"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read()


def parse(blob: bytes, poll_ts: int) -> list[list]:
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(blob)
    rows, seen = [], set()
    for e in feed.entity:
        if not e.HasField("vehicle"):
            continue
        v = e.vehicle
        key = (v.vehicle.id, v.timestamp)
        if key in seen:          # the feed repeats entities
            continue
        seen.add(key)
        t = v.trip
        rows.append([poll_ts, v.timestamp or poll_ts, v.vehicle.id or e.id, t.trip_id, t.route_id, t.start_date,
                     t.start_time, round(v.position.latitude, 6), round(v.position.longitude, 6),
                     round(v.position.bearing, 1) if v.position.HasField("bearing") else ""])
    return rows


def _append(path, fields, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with gzip.open(path, "at", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(fields)
        w.writerows(rows)


def _push(health: list):
    """Collector heartbeat for Prometheus (only when PUSHGATEWAY_URL is set)."""
    url = os.environ.get("PUSHGATEWAY_URL")
    if not url:
        return
    try:
        from prometheus_client import CollectorRegistry, Gauge, push_to_gateway

        reg = CollectorRegistry()
        Gauge("ghostbus_collector_last_poll_ok", "1 if the last poll of the live feed worked", registry=reg).set(health[1])
        Gauge("ghostbus_collector_buses", "Buses seen in the last poll", registry=reg).set(health[3])
        if health[1]:
            Gauge("ghostbus_collector_last_ok_timestamp_seconds", "When the feed last answered",
                  registry=reg).set(health[0])
        push_to_gateway(url, job="ghostbus-collector", registry=reg)
    except Exception as e:  # monitoring must never stop collection
        print("pushgateway:", e)


def run(minutes: float, api_key: str):
    """Poll for `minutes` (GitHub Actions), or forever if minutes <= 0 (Kubernetes)."""
    end = time.time() + minutes * 60 if minutes > 0 else float("inf")
    while time.time() < end:
        t0 = time.time()
        poll_ts = int(t0)
        now = datetime.fromtimestamp(poll_ts, C.TZ)
        stamp = now.strftime("%Y-%m-%d")
        try:
            blob = fetch(api_key)
            rows = parse(blob, poll_ts)
            _append(C.RAW / stamp / f"{now:%H}.csv.gz", FIELDS, rows)
            health = [poll_ts, 1, 200, len(rows), sum(1 for r in rows if r[3]), int((time.time() - t0) * 1000), ""]
        except Exception as e:  # keep polling: an outage is data too
            code = getattr(e, "code", "")
            health = [poll_ts, 0, code, 0, 0, int((time.time() - t0) * 1000), str(e)[:200].replace("\n", " ")]
        _append(C.HEALTH / f"{stamp}.csv.gz", HEALTH_FIELDS, [health])
        _push(health)
        print(datetime.now(timezone.utc).strftime("%H:%M:%S"), "ok" if health[1] else "FAIL", health[3], "buses", health[4], "with trip")
        time.sleep(max(1, C.POLL_SECONDS - (time.time() - t0)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=55)
    a = ap.parse_args()
    key = os.environ.get("BODS_API_KEY", "").strip()
    if not key:
        raise SystemExit("Set BODS_API_KEY (free from https://data.bus-data.dft.gov.uk/account/signup/)")
    run(a.minutes, key)
