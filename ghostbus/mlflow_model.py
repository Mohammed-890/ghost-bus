"""The MLflow wrapper around a ModelBundle (only imported when MLflow is used)."""
from __future__ import annotations

import joblib
import mlflow.pyfunc
import pandas as pd


class GhostBusModel(mlflow.pyfunc.PythonModel):
    """Input rows: route, direction_id, start_secs, service_date (YYYY-MM-DD).
    Output: the chance each departure runs (NaN if it isn't in the timetable)."""

    def load_context(self, context):
        self.bundle = joblib.load(context.artifacts["bundle"])

    def predict(self, context, model_input: pd.DataFrame, params=None):
        out = []
        for r in model_input.itertuples():
            res = self.bundle.predict_departure(r.route, r.direction_id, r.start_secs,
                                                pd.to_datetime(r.service_date).date())
            out.append(res["p_runs"] if res else float("nan"))
        return pd.Series(out, name="p_runs")
