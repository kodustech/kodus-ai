#!/bin/bash
#
# Validate benchmark-critical containers before starting a benchmark run.
#
# Usage:
#   ./benchmark-preflight.sh
#
set -euo pipefail

REQUIRED_CONTAINERS=(
  "kodus_api"
  "kodus_worker"
  "kodus_webhooks"
  "mongodb"
  "db_postgres"
  "rabbitmq"
)

FAILURES=0

echo "▸ Benchmark preflight..."

for container in "${REQUIRED_CONTAINERS[@]}"; do
  INSPECT=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container" 2>/dev/null || true)

  if [ -z "$INSPECT" ]; then
    echo "  ✗ $container: not found"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  STATE=$(echo "$INSPECT" | awk '{print $1}')
  HEALTH=$(echo "$INSPECT" | awk '{print $2}')

  if [ "$STATE" != "running" ]; then
    echo "  ✗ $container: state=$STATE"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  if [ "$HEALTH" != "healthy" ] && [ "$HEALTH" != "no-healthcheck" ]; then
    echo "  ✗ $container: state=$STATE health=$HEALTH"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  if [ "$HEALTH" = "no-healthcheck" ]; then
    echo "  ✓ $container: running"
  else
    echo "  ✓ $container: running healthy"
  fi
done

if [ "$FAILURES" -gt 0 ]; then
  echo ""
  echo "Benchmark preflight failed: $FAILURES container(s) are not ready."
  exit 1
fi

echo "  ✓ Benchmark preflight passed"
