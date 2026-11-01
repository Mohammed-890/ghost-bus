# Ghost Bus: one image for the API, the daily job, the collector and the demo seed.
#   API:        uvicorn ghostbus.serve:app --host 0.0.0.0 --port 8000   (default)
#   daily job:  python -m ghostbus.daily
#   collector:  python -m ghostbus.collect --minutes 0

# ---- build stage: install dependencies into a virtualenv -------------------
FROM python:3.12-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
# Requirements first: this layer is cached until they change, so a code
# change rebuilds in seconds.
COPY requirements.txt requirements-serve.txt ./
RUN pip install -r requirements.txt -r requirements-serve.txt

# ---- runtime stage: no compilers, no pip cache, non-root ----------------------
FROM python:3.12-slim
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    GHOSTBUS_DATA=/data GHOSTBUS_SITE=/tmp/site MLFLOW_DISABLE_AGENT_HINT=1
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin ghostbus \
 && mkdir -p /data && chown 10001:10001 /data
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY ghostbus ./ghostbus
USER 10001
EXPOSE 8000
CMD ["uvicorn", "ghostbus.serve:app", "--host", "0.0.0.0", "--port", "8000"]
