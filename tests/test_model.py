"""The model pipeline on synthetic days with a planted pattern.

This only checks the plumbing (no leakage, it can find a real signal).
Reported results come from real data only.
"""


from ghostbus.model import add_features, evaluate


from ghostbus.demo import synthetic  # noqa: E402,F401  (shared with the demo seed job)


def test_history_features_never_see_the_same_day():
    df = synthetic(days=5)
    f = add_features(df)
    first = f[f.service_date == df.service_date.min()]
    # nothing to learn from on day one, so every rate is the prior
    assert first.route_rate_7d.nunique() == 1 and (first.dep_obs_14d == 0).all()


def test_model_beats_constant_and_is_reported_honestly():
    r = evaluate(synthetic())
    assert r["status"] == "ready"
    assert r["model"]["brier"] < r["constant"]["brier"]
    assert r["model"]["roc_auc"] > 0.7
    assert r["test_days"][0] > r["train_days"][1]          # test is strictly later than train


def test_not_enough_data_says_so():
    assert evaluate(synthetic(days=3))["status"] == "collecting"
