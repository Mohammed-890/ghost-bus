# 4. MLflow registry in production, a folder registry everywhere else

**Decision.** `get_registry()` uses MLflow when `MLFLOW_TRACKING_URI` is set. Otherwise it uses a local registry in the data folder: numbered versions, a champion file and statuses. Both have the same interface (`champion`, `register`, `set_champion`, `reject`, `log_metrics`), and both are tested.

**Why.**
- MLflow gives the registry, aliases, lineage and a UI, which matters once there's a cluster.
- The original pipeline runs on GitHub Actions with no server, and it has to keep working there.
- Tests run in seconds with the folder registry, and one test runs the full flow against a real MLflow store.

**Trade-off.** There are two implementations to keep in step. The shared test suite is what keeps them honest. In MLflow the model is stored as a pyfunc wrapper around the same bundle, so any MLflow tool can load it, not only this API.
