# MLflow tracking server + model registry, pinned to the client version the app uses.
FROM python:3.12-slim
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1 MLFLOW_DISABLE_AGENT_HINT=1
RUN pip install mlflow==3.17.2 \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin mlflow \
 && mkdir -p /mlflow && chown 10001:10001 /mlflow
USER 10001
EXPOSE 5000
# Allowed hosts are set per deployment (compose / Helm) with --allowed-hosts.
ENTRYPOINT ["mlflow", "server", "--host", "0.0.0.0", "--port", "5000", \
            "--backend-store-uri", "sqlite:////mlflow/mlflow.db", "--artifacts-destination", "/mlflow/artifacts"]
