"""Decide whether to retrain, and whether the new model goes live.

Retraining is triggered by any of:
  * there is no champion yet
  * the champion is 7 or more days old (weekly refresh)
  * data drift: a feature's PSI on the last 7 judged days is above 0.2
  * live accuracy fell: the last 3 scored days' Brier is 25% worse than
    the champion's own test Brier

A trigger only trains a challenger. The challenger goes live only if it
beats the champion on the SAME held-out days, which both models have never
seen: the test window starts after the champion's last training day. With
no champion, it must beat the "everyone runs" baseline. Once it passes,
it is refit on every judged day and registered as the new champion.
"""
from __future__ import annotations

import json
from datetime import date, timedelta

import numpy as np
import pandas as pd

from .drift import PSI_DRIFT, psi
from .model import enough_data, evaluate_split, fit_bundle, metrics, split, training_frame

MAX_AGE_DAYS = 7
LIVE_DEGRADE = 1.25
MIN_TEST_DAYS, MIN_TEST_GHOSTS = 2, 10


def triggers_for(champ, feats: pd.DataFrame, live: list[dict]) -> list[str]:
    if champ is None:
        return ["no champion yet"]
    out = []
    last = max(feats.service_date)
    trained = date.fromisoformat(champ.meta["trained_through"])
    if (last - trained).days >= MAX_AGE_DAYS:
        out.append(f"weekly refresh ({(last - trained).days} days old)")
    recent = feats[feats.service_date > last - timedelta(days=7)]
    scores = psi(champ.reference, recent) if champ.reference else {}
    worst = max(scores.items(), key=lambda kv: kv[1], default=(None, 0.0))
    if worst[1] > PSI_DRIFT:
        out.append(f"data drift ({worst[0]} PSI {worst[1]:.2f})")
    champ_brier = champ.meta.get("test_brier")
    scored = [s["brier"] for s in live[-3:] if s]
    if champ_brier and len(scored) == 3 and np.mean(scored) > champ_brier * LIVE_DEGRADE:
        out.append(f"live accuracy fell (Brier {np.mean(scored):.4f} vs {champ_brier:.4f})")
    return out


def run(results: pd.DataFrame, schedule: pd.DataFrame, registry, live: list[dict] | None = None,
        force: bool = False) -> dict:
    ok, counts = enough_data(results)
    if not ok:
        return {"action": "skip", "reason": "still collecting", **counts}
    feats = training_frame(results)
    champ = registry.champion()
    triggers = triggers_for(champ, feats, live or [])
    if force:
        triggers.append("forced")
    if not triggers:
        return {"action": "keep", "reason": "no trigger", "champion": champ.meta.get("version")}

    days = sorted(set(feats.service_date))
    cut = days[int(len(days) * 0.7)]
    if champ is not None:
        cut = max(cut, date.fromisoformat(champ.meta["trained_through"]) + timedelta(days=1))
    tr, te, cut = split(feats, cut)
    if te.service_date.nunique() < MIN_TEST_DAYS or te.y.sum() < MIN_TEST_GHOSTS or tr.empty:
        return {"action": "keep", "reason": "not enough unseen days to compare fairly", "triggers": triggers,
                "champion": champ.meta.get("version") if champ else None}

    report, _, _ = evaluate_split(tr, te)
    challenger = report["model"]["brier"]
    decision = {"triggers": triggers, "test_days": report["test_days"], "challenger_brier": challenger}
    if champ is None:
        bar = report["constant"]["brier"]
        decision["baseline_brier"] = bar
        promote = challenger < bar
        why = f"challenger Brier {challenger:.5f} vs baseline {bar:.5f}"
    else:
        champ_m = metrics(te.y.to_numpy(), champ.predict_ghost(te))
        decision["champion_brier"] = champ_m["brier"]
        decision["champion_version"] = champ.meta.get("version")
        promote = challenger < champ_m["brier"]
        why = f"challenger Brier {challenger:.5f} vs champion {champ_m['brier']:.5f} on the same days"

    bundle = fit_bundle(results, schedule, meta={"test_brier": challenger, "report": report})
    decision["promoted"] = bool(promote)
    decision["reason"] = why
    version = registry.register(bundle, report, decision)
    if promote:
        registry.set_champion(version)
    else:
        registry.reject(version, why)
    decision["action"] = "promoted" if promote else "rejected"
    decision["version"] = version
    return decision


if __name__ == "__main__":
    from . import schedule as S
    from .model import load_results
    from .registry import get_registry

    res = load_results()
    print(json.dumps(run(res, S.day_schedule(max(res.service_date) + timedelta(days=1))[0], get_registry(),
                         force=True), indent=2, default=str))
