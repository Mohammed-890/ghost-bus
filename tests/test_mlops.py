"""Features, drift, the champion gate and both registries."""
from datetime import date, timedelta

import pandas as pd
import pytest

from ghostbus import train
from ghostbus.drift import psi, reference_from, score_predictions
from ghostbus.features import FEATURES, add_features, compute_tables, departures_table, judged
from ghostbus.model import ModelBundle, fit_bundle, training_frame
from ghostbus.registry import LocalRegistry
from tests.test_model import synthetic


def schedule_for(results, day):
    s = results[results.service_date == results.service_date.min()].drop(columns=["verdict"]).copy()
    s["service_date"] = day.isoformat()
    s["from_stop"], s["to_stop"] = "A", "B"
    return s


# ---------------------------------------------------------------- skew
def test_serving_builds_the_same_features_as_training():
    res = synthetic(days=10)
    day = max(res.service_date) + timedelta(days=1)
    sched = schedule_for(res, day)
    # training path: the day as one more results day
    trained = add_features(sched.assign(verdict="ran_tracked"), history=res).sort_values(["route", "direction_id", "start_secs"])
    # serving path: departures table + rate tables as of that day
    b = ModelBundle(classifier=None, categories={}, tables=compute_tables(judged(res), day),
                    departures=departures_table(sched))
    served = b.features_for_departures(b.departures, day).sort_values(["route", "direction_id", "start_secs"])
    pd.testing.assert_frame_equal(trained[FEATURES].reset_index(drop=True).astype({c: float for c in FEATURES[3:]}),
                                  served[FEATURES].reset_index(drop=True).astype({c: float for c in FEATURES[3:]}))


def test_rates_for_a_day_never_use_that_day_or_later():
    res = synthetic(days=6)
    d = sorted(set(res.service_date))[3]
    t = compute_tables(judged(res), d)
    before = judged(res)[judged(res).service_date < d]
    assert t["prior"] == pytest.approx(before.g.mean())


# ---------------------------------------------------------------- drift
def test_psi_is_small_for_same_data_and_large_for_shifted_data():
    f = training_frame(synthetic(days=14))
    ref = reference_from(f)
    assert max(psi(ref, f).values()) < 0.01
    shifted = f.assign(hour=f.hour + 6, headway_min=f.headway_min * 3)
    s = psi(ref, shifted)
    assert s["hour"] > 0.2 and s["headway_min"] > 0.2


def test_live_scoring_matches_by_trip():
    res = pd.DataFrame({"trip_id": ["a", "b", "c"], "verdict": ["ghost", "ran_tracked", "unknown"]})
    pred = pd.DataFrame({"trip_id": ["a", "b", "c"], "p_runs": [0.2, 0.9, 0.5], "model_version": "3"})
    s = score_predictions(pred, res)
    assert s["n"] == 2 and s["brier"] == pytest.approx(((0.8 - 1) ** 2 + (0.1 - 0) ** 2) / 2)


# ---------------------------------------------------------------- gate
def test_first_model_is_promoted_and_later_compared_on_unseen_days(tmp_path):
    reg = LocalRegistry(tmp_path)
    res = synthetic(days=21)
    first = res[res.service_date < min(res.service_date) + timedelta(days=12)]
    d1 = train.run(first, schedule_for(first, date(2026, 12, 1)), reg)
    assert d1["action"] == "promoted" and reg.champion().meta["version"] == d1["version"]

    d2 = train.run(res, schedule_for(res, date(2026, 12, 1)), reg, force=True)
    assert d2["action"] in ("promoted", "rejected")
    # the comparison window starts after everything the champion was trained on
    assert d2["test_days"][0] > reg_record(tmp_path, d1["version"])["meta"]["trained_through"]
    assert "champion_brier" in d2


def test_a_worse_challenger_is_never_promoted(tmp_path, monkeypatch):
    reg = LocalRegistry(tmp_path)
    res = synthetic(days=21)
    first = res[res.service_date < min(res.service_date) + timedelta(days=12)]
    d1 = train.run(first, schedule_for(first, date(2026, 12, 1)), reg)
    real = train.evaluate_split

    def sabotaged(tr, te):
        report, clf, cats = real(tr, te)
        report["model"]["brier"] = 0.99          # far worse than any real model
        return report, clf, cats

    monkeypatch.setattr(train, "evaluate_split", sabotaged)
    d2 = train.run(res, schedule_for(res, date(2026, 12, 1)), reg, force=True)
    assert d2["action"] == "rejected"
    assert reg.champion().meta["version"] == d1["version"]
    assert reg_record(tmp_path, d2["version"])["status"] == "rejected"


def test_no_trigger_keeps_the_champion(tmp_path):
    reg = LocalRegistry(tmp_path)
    res = synthetic(days=14)
    train.run(res, schedule_for(res, date(2026, 12, 1)), reg)
    d = train.run(res, schedule_for(res, date(2026, 12, 1)), reg)
    assert d["action"] == "keep"


def test_too_little_data_skips(tmp_path):
    d = train.run(synthetic(days=3), schedule_for(synthetic(days=3), date(2026, 12, 1)), LocalRegistry(tmp_path))
    assert d["action"] == "skip"


def reg_record(root, version):
    import json
    return json.loads((root / "versions" / f"v{version}.json").read_text())


# ---------------------------------------------------------------- bundle + MLflow
def test_bundle_predicts_a_known_departure_and_refuses_an_unknown_one():
    res = synthetic(days=14)
    b = fit_bundle(res, schedule_for(res, date(2026, 12, 1)))
    hit = b.predict_departure("52", "0", 8 * 3600, date(2026, 12, 1))
    assert 0 <= hit["p_runs"] <= 1
    assert b.predict_departure("52", "0", 8 * 3600 + 7, date(2026, 12, 1)) is None


def test_mlflow_registry_round_trip(tmp_path, monkeypatch):
    pytest.importorskip("mlflow")
    from ghostbus.registry import MlflowRegistry

    monkeypatch.setenv("MLFLOW_DISABLE_AGENT_HINT", "1")
    monkeypatch.chdir(tmp_path)                      # MLflow writes artifacts under ./mlruns
    reg = MlflowRegistry(uri=f"sqlite:///{tmp_path}/mlflow.db")
    res = synthetic(days=14)
    d = train.run(res, schedule_for(res, date(2026, 12, 1)), reg)
    assert d["action"] == "promoted"
    champ = reg.champion()
    assert champ.meta["version"] == d["version"]
    assert champ.predict_departure("52", "0", 8 * 3600, date(2026, 12, 1)) is not None
    reg.log_metrics("daily-2026-12-01", {"live": {"brier": 0.05}, "psi_max": 0.03})
