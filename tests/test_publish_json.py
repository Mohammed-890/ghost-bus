import json
import math

import numpy as np

from ghostbus import publish


def test_published_json_never_contains_nan(tmp_path, monkeypatch):
    monkeypatch.setattr(publish.C, "SITE_DATA", tmp_path)
    publish._w("x.json", {"a": float("nan"), "b": [1.5, np.float64("nan"), np.int64(3)], "c": {"d": math.inf}})
    out = json.loads((tmp_path / "x.json").read_text())  # strict parse, as a browser does
    assert out == {"a": None, "b": [1.5, None, 3], "c": {"d": None}}
