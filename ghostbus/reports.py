"""Passenger reports and web-push subscriptions for the Ghost Bus API.

Mounted on the API in serve.py. Storage is SQLite (GHOSTBUS_DB, default data/ghostbus.db), which is plenty for
one city. Swap for Postgres by changing `connect()` when it needs to scale.

A single report is never treated as fact. A trip's reports are summarised as:
- "confirmed": the GPS check agreed, or 3+ different devices reported the same problem within 30 minutes;
- "likely": 2 different devices agree;
- "single": one report so far.
Devices are identified by a random ID the browser makes, never by name. Limits: 10 reports per device per hour,
120 per IP per hour (kept in memory; use Redis behind more than one instance).
"""
from __future__ import annotations

import os
import sqlite3
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from . import config as C

KINDS = ("no_show", "no_stop", "full", "late", "wrong_info", "access")
CHECKS = ("agrees", "disagrees", "too_early", "unconfirmed")
router = APIRouter()
_lock = threading.Lock()
_hits: dict[str, deque] = defaultdict(deque)


def db_path() -> Path:
    return Path(os.environ.get("GHOSTBUS_DB", C.DATA / "ghostbus.db"))


def connect() -> sqlite3.Connection:
    p = db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.executescript("""
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, trip INTEGER NOT NULL, route TEXT NOT NULL,
            operator TEXT NOT NULL, start TEXT NOT NULL, stop TEXT NOT NULL, kind TEXT NOT NULL, note TEXT,
            gps_check TEXT NOT NULL, device TEXT NOT NULL, ts REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS reports_trip ON reports(day, trip, kind);
        CREATE INDEX IF NOT EXISTS reports_route ON reports(day, route);
        CREATE TABLE IF NOT EXISTS push_subs (
            endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, device TEXT NOT NULL,
            journeys TEXT NOT NULL, prefs TEXT NOT NULL, ts REAL NOT NULL);
    """)
    return con


def _limit(key: str, n: int, window: float = 3600) -> None:
    now = time.time()
    with _lock:
        q = _hits[key]
        while q and q[0] < now - window:
            q.popleft()
        if len(q) >= n:
            raise HTTPException(429, "Too many reports. Try again later.")
        q.append(now)


class Report(BaseModel):
    day: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    i: int = Field(ge=0, le=200_000)
    route: str = Field(min_length=1, max_length=12)
    operator: str = Field(min_length=1, max_length=80)
    start: str = Field(pattern=r"^\d{2}:\d{2}$")
    stop: str = Field(min_length=1, max_length=120)
    kind: Literal[KINDS]
    note: str = Field("", max_length=200)
    check: Literal[CHECKS] = "unconfirmed"
    device: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


def summarise(rows) -> dict:
    """Per kind: how many devices, and the verification level."""
    out = {}
    for kind in KINDS:
        rs = [r for r in rows if r["kind"] == kind]
        if not rs:
            continue
        devices = {r["device"] for r in rs}
        gps = any(r["gps_check"] == "agrees" for r in rs)
        ts = sorted(r["ts"] for r in rs)
        close = any(ts[k + 2] - ts[k] <= 1800 for k in range(len(ts) - 2)) if len(devices) >= 3 else False
        level = "confirmed" if gps or close else "likely" if len(devices) >= 2 else "single"
        out[kind] = {"reports": len(rs), "devices": len(devices), "gps_agrees": gps, "level": level}
    return out


@router.post("/reports", status_code=201)
def add_report(rep: Report, request: Request):
    _limit(f"dev:{rep.device}", 10)
    _limit(f"ip:{request.client.host if request.client else '-'}", 120)
    con = connect()
    with con:
        con.execute("INSERT INTO reports (at, day, trip, route, operator, start, stop, kind, note, gps_check, device, ts) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (datetime.now(timezone.utc).isoformat(timespec="seconds"), rep.day, rep.i, rep.route, rep.operator,
                     rep.start, rep.stop, rep.kind, rep.note.strip(), rep.check, rep.device, time.time()))
    rows = con.execute("SELECT * FROM reports WHERE day=? AND trip=?", (rep.day, rep.i)).fetchall()
    return {"ok": True, "trip": summarise(rows)}


@router.get("/reports/trip")
def trip_reports(day: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"), i: int = Query(..., ge=0)):
    rows = connect().execute("SELECT * FROM reports WHERE day=? AND trip=?", (day, i)).fetchall()
    return {"day": day, "trip": i, "summary": summarise(rows)}


@router.get("/reports/today")
def today(day: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$")):
    """Trips with at least 'likely' reports, for the map and the stop pages."""
    rows = connect().execute("SELECT * FROM reports WHERE day=?", (day,)).fetchall()
    by = defaultdict(list)
    for r in rows:
        by[r["trip"]].append(r)
    out = []
    for trip, rs in by.items():
        s = {k: v for k, v in summarise(rs).items() if v["level"] != "single"}
        if s:
            out.append({"trip": trip, "route": rs[0]["route"], "start": rs[0]["start"], "summary": s})
    return {"day": day, "trips": out}


class PushSub(BaseModel):
    endpoint: str = Field(pattern=r"^https://", max_length=600)
    p256dh: str = Field(min_length=20, max_length=200)
    auth: str = Field(min_length=8, max_length=60)
    device: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    journeys: list[dict] = Field(default_factory=list, max_length=6)
    prefs: dict = Field(default_factory=dict)


@router.post("/push/subscribe", status_code=201)
def subscribe(sub: PushSub):
    """Stores a browser's push subscription and the journeys it wants alerts for. Sending needs a VAPID key pair
    (VAPID_PRIVATE_KEY) and a worker that runs the same checks as the site's checkCommutes() against the live
    data, then calls pywebpush. See AUDIT.md."""
    import json
    con = connect()
    with con:
        con.execute("INSERT OR REPLACE INTO push_subs VALUES (?,?,?,?,?,?,?)",
                    (sub.endpoint, sub.p256dh, sub.auth, sub.device, json.dumps(sub.journeys), json.dumps(sub.prefs), time.time()))
    return {"ok": True, "sending_enabled": bool(os.environ.get("VAPID_PRIVATE_KEY"))}


@router.delete("/push/subscribe")
def unsubscribe(endpoint: str = Query(..., max_length=600)):
    con = connect()
    with con:
        con.execute("DELETE FROM push_subs WHERE endpoint=?", (endpoint,))
    return {"ok": True}
