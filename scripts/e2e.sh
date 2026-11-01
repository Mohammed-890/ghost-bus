#!/usr/bin/env bash
# End-to-end test on a kind cluster: install the chart, wait for the demo
# champion, call the API, then delete an API pod under load and count failures.
set -euo pipefail
NS=ghost-bus
fail() { echo "::error title=e2e::$*"; exit 1; }

helm upgrade --install ghost-bus chart/ghost-bus -n $NS --create-namespace \
  -f deploy/values-ci.yaml \
  --set image.repository=ghost-bus --set mlflowImage.repository=ghost-bus-mlflow --wait=false

echo "--- waiting for MLflow"
kubectl -n $NS rollout status deploy/ghost-bus-mlflow --timeout=300s || fail "MLflow did not become ready"
echo "--- waiting for the demo champion to be registered"
kubectl -n $NS wait --for=condition=complete job/ghost-bus-demo-seed --timeout=600s || fail "demo seed job did not complete"
echo "--- waiting for the API (ready = champion loaded)"
kubectl -n $NS rollout status deploy/ghost-bus-api --timeout=300s || fail "API pods never became ready"

kubectl -n $NS port-forward svc/ghost-bus-api 8000:80 >/tmp/pf.log 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -sf localhost:8000/healthz >/dev/null && break; sleep 1; done

echo "--- API checks"
curl -sf localhost:8000/readyz | tee /dev/stderr | grep -q '"ready"' || fail "/readyz not ready"
RUSH=$(curl -sf "localhost:8000/predict?route=52&time=08:00&date=2026-12-01" | python3 -c 'import sys,json; print(json.load(sys.stdin)["p_runs"])')
NOON=$(curl -sf "localhost:8000/predict?route=52&time=12:00&date=2026-12-01" | python3 -c 'import sys,json; print(json.load(sys.stdin)["p_runs"])')
echo "route 52: 08:00 runs $RUSH, 12:00 runs $NOON"
python3 -c "import sys; sys.exit(0 if $RUSH < $NOON else 1)" || fail "model did not learn the planted rush-hour pattern ($RUSH vs $NOON)"
[ "$(curl -s -o /dev/null -w '%{http_code}' 'localhost:8000/predict?route=999&time=08:00')" = 404 ] || fail "unknown route should be 404"
curl -sf localhost:8000/metrics | grep -q 'ghostbus_requests_total{endpoint="/predict",status="200"}' || fail "metrics missing"

echo "--- zero-downtime check: delete an API pod while sending 300 requests through the Service"
kill $PF; sleep 1
kubectl -n $NS run loadtest --image=ghost-bus:ci --image-pull-policy=Never --restart=Never --command -- \
  python -c "
import time, urllib.request
ok = bad = 0
for i in range(300):
    try:
        urllib.request.urlopen('http://ghost-bus-api/predict?route=7&time=12:00&date=2026-12-01', timeout=5).read(); ok += 1
    except Exception as e:
        bad += 1; print('FAIL', i, e)
    time.sleep(0.1)
print(f'RESULT ok={ok} failed={bad}')
"
sleep 8
VICTIM=$(kubectl -n $NS get pods -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}')
echo "deleting $VICTIM"
kubectl -n $NS delete pod "$VICTIM" --wait=false
kubectl -n $NS wait --for=jsonpath='{.status.phase}'=Succeeded pod/loadtest --timeout=180s || true
RESULT=$(kubectl -n $NS logs loadtest | tail -1)
echo "$RESULT"
echo "$RESULT" | grep -q "failed=0" || fail "requests failed during pod deletion: $RESULT"
echo "::notice title=e2e::All checks passed. $RESULT. Route 52 runs $RUSH at 08:00 vs $NOON at 12:00."
