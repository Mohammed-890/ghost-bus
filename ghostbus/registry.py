"""Where trained models live, and which one is the champion.

Two backends with the same interface:

* MlflowRegistry - when MLFLOW_TRACKING_URI is set (Docker Compose and the
  Kubernetes deployment). Every training run is an MLflow run with its
  metrics and report; every model is a registered version of
  `ghost-bus-runs`; the live one carries the `champion` alias.
* LocalRegistry - otherwise (the GitHub Actions daily job). The champion
  bundle and a JSON record of every version are kept in the data folder.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import joblib

from . import config as C

MODEL_NAME = "ghost-bus-runs"
CHAMPION = "champion"


def flatten(report: dict, prefix: str = "") -> dict:
    out = {}
    for k, v in report.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(flatten(v, key + "."))
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            out[key] = float(v)
    return out


class LocalRegistry:
    def __init__(self, root: Path | None = None):
        self.root = Path(root or C.DATA / "models")
        (self.root / "versions").mkdir(parents=True, exist_ok=True)

    def _versions(self) -> list[int]:
        return sorted(int(p.stem[1:]) for p in (self.root / "versions").glob("v*.json"))

    def champion(self):
        path = self.root / "champion.joblib"
        return joblib.load(path) if path.exists() else None

    def register(self, bundle, report: dict, decision: dict) -> str:
        n = (self._versions() or [0])[-1] + 1
        version = str(n)
        bundle.meta["version"] = version
        joblib.dump(bundle, self.root / "versions" / f"v{n}.joblib", compress=3)
        rec = {"version": version, "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "meta": bundle.meta, "report": report, "decision": decision, "status": "candidate"}
        (self.root / "versions" / f"v{n}.json").write_text(json.dumps(rec, indent=2, default=str))
        return version

    def _set_status(self, version: str, status: str, reason: str = ""):
        p = self.root / "versions" / f"v{version}.json"
        rec = json.loads(p.read_text())
        rec["status"], rec["reason"] = status, reason
        p.write_text(json.dumps(rec, indent=2, default=str))

    def set_champion(self, version: str):
        src = self.root / "versions" / f"v{version}.joblib"
        os.replace(src, self.root / "champion.joblib")
        for v in self._versions():
            rec = json.loads((self.root / "versions" / f"v{v}.json").read_text())
            if rec.get("status") == "champion" and str(v) != str(version):
                self._set_status(str(v), "retired", f"replaced by v{version}")
        self._set_status(version, "champion")

    def reject(self, version: str, reason: str):
        (self.root / "versions" / f"v{version}.joblib").unlink(missing_ok=True)   # keep the record, not the weights
        self._set_status(version, "rejected", reason)

    def log_metrics(self, name: str, values: dict):
        with open(self.root / "monitoring.jsonl", "a") as f:
            f.write(json.dumps({"name": name, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                **values}, default=str) + "\n")


class MlflowRegistry:
    def __init__(self, uri: str | None = None, experiment: str = "ghost-bus"):
        import mlflow
        from mlflow.tracking import MlflowClient

        self.mlflow = mlflow
        mlflow.set_tracking_uri(uri or os.environ["MLFLOW_TRACKING_URI"])
        mlflow.set_experiment(experiment)
        self.client = MlflowClient()

    def champion(self):
        try:
            mv = self.client.get_model_version_by_alias(MODEL_NAME, CHAMPION)
        except Exception:
            return None
        model = self.mlflow.pyfunc.load_model(f"models:/{MODEL_NAME}@{CHAMPION}")
        bundle = model.unwrap_python_model().bundle
        bundle.meta["version"] = str(mv.version)     # assigned by the registry after the bundle was saved
        return bundle

    def register(self, bundle, report: dict, decision: dict) -> str:
        from .mlflow_model import GhostBusModel

        with self.mlflow.start_run(run_name=f"train-{bundle.meta.get('trained_through')}"):
            self.mlflow.log_params({"trained_through": bundle.meta.get("trained_through"),
                                    "n_train": bundle.meta.get("n_train"),
                                    "train_days": "/".join(report.get("train_days", [])),
                                    "test_days": "/".join(report.get("test_days", [])),
                                    "triggers": "; ".join(decision.get("triggers", []))[:500]})
            self.mlflow.log_metrics(flatten({k: v for k, v in report.items() if k != "calibration"}))
            if "champion_brier" in decision:
                self.mlflow.log_metric("gate.champion_brier", decision["champion_brier"])
            self.mlflow.log_dict(report, "report.json")
            self.mlflow.log_dict(decision, "decision.json")
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "bundle.joblib"
                joblib.dump(bundle, path, compress=3)
                info = self.mlflow.pyfunc.log_model(name="model", python_model=GhostBusModel(),
                                                    artifacts={"bundle": str(path)},
                                                    registered_model_name=MODEL_NAME)
        version = str(info.registered_model_version)
        bundle.meta["version"] = version
        return version

    def set_champion(self, version: str):
        self.client.set_registered_model_alias(MODEL_NAME, CHAMPION, version)
        self.client.set_model_version_tag(MODEL_NAME, version, "status", "champion")

    def reject(self, version: str, reason: str):
        self.client.set_model_version_tag(MODEL_NAME, version, "status", "rejected")
        self.client.set_model_version_tag(MODEL_NAME, version, "reason", reason[:250])

    def log_metrics(self, name: str, values: dict):
        exp = self.mlflow.get_experiment_by_name("ghost-bus-monitoring") or None
        exp_id = exp.experiment_id if exp else self.mlflow.create_experiment("ghost-bus-monitoring")
        with self.mlflow.start_run(experiment_id=exp_id, run_name=name):
            self.mlflow.log_metrics(flatten(values))
            self.mlflow.log_dict(values, "values.json")


def get_registry():
    return MlflowRegistry() if os.environ.get("MLFLOW_TRACKING_URI") else LocalRegistry()
