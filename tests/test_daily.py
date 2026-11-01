"""The daily job end to end on disk: train, promote, predict tomorrow,
score those predictions once the day is judged, publish."""
import importlib
import json
from datetime import datetime, timedelta

import pandas as pd


def test_daily_loop(tmp_path, monkeypatch):
    monkeypatch.setenv("GHOSTBUS_DATA", str(tmp_path / "store"))
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    monkeypatch.delenv("PUSHGATEWAY_URL", raising=False)
    from ghostbus import config
    importlib.reload(config)
    from ghostbus import schedule, match, collect, model, monitor, registry, train, publish, daily
    for m in (schedule, match, collect, model, monitor, registry, train, publish, daily):
        importlib.reload(m)
    monkeypatch.setattr(config, "SITE_DATA", tmp_path / "site")

    from tests.test_model import synthetic
    from tests.test_pipeline import make_gtfs

    today = datetime.now(config.TZ).date()
    zp = tmp_path / "region.zip"
    make_gtfs(zp, today + timedelta(days=1), all_days=True)
    schedule.cut_to_city(zp)

    res = synthetic(days=28, first_day=today - timedelta(days=28))
    config.RESULTS.mkdir(parents=True)
    for d, g in res.groupby("service_date"):
        g.assign(reason="", from_stop="A", to_stop="B").to_csv(config.RESULTS / f"{d}.csv.gz", index=False)

    daily.main()
    decisions = monitor.read_jsonl("decisions.jsonl")
    assert decisions[-1]["action"] == "promoted"
    pred = pd.read_csv(config.DATA / "predictions" / f"{today + timedelta(days=1)}.csv.gz", dtype={"trip_id": str})
    assert set(pred.trip_id) == {"T1", "T2", "T3", "HBT"} and pred.p_runs.between(0, 1).all()

    # tomorrow gets judged: T3 never came
    judged = pd.DataFrame({"trip_id": ["T1", "T2", "T3", "HBT"], "verdict": ["ran_tracked", "ran_matched", "ghost", "ran_tracked"]})
    s = monitor.score_day(today + timedelta(days=1), judged)
    assert s["n"] == 4 and 0 <= s["brier"] <= 1

    # a second run with nothing new keeps the champion
    daily.main()
    assert monitor.read_jsonl("decisions.jsonl")[-1]["action"] == "keep"
    site = json.loads((tmp_path / "site" / "monitoring.json").read_text())
    assert site["live"][-1]["n"] == 4 and site["decisions"][-1]["action"] == "promoted"
