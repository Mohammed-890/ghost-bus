#!/usr/bin/env bash
# On failure: print cluster state, and the key lines as annotations (readable from the API).
NS=ghost-bus
kubectl -n $NS get pods -o wide || true
kubectl -n $NS get events --sort-by=.lastTimestamp | tail -30 || true
for p in $(kubectl -n $NS get pods -o name); do echo "=== $p"; kubectl -n $NS logs "$p" --all-containers --tail=60 || true; done
kubectl -n $NS get pods --no-headers | awk '$3 != "Running" && $3 != "Completed" {print}' | head -5 | while read -r l; do echo "::error title=pod::$l"; done
for p in $(kubectl -n $NS get pods -o name | head -8); do
  last=$(kubectl -n $NS logs "$p" --all-containers --tail=200 2>/dev/null | grep -iE "error|exception|traceback|denied|refused|fail" | tail -2 | tr '\n' ' ' | cut -c1-400)
  [ -n "$last" ] && echo "::error title=$p::$last"
done
exit 0
