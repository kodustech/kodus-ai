#!/usr/bin/env bash
# Checks and unit-tests the Kody Runtime alert rules with promtool, and checks
# that every dashboard query parses (apps/runtime/observability). Uses a local
# promtool when there is one, else the pinned Prometheus image (Apache-2.0).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$root/apps/runtime/observability"
image="prom/prometheus:v3.5.0"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/prometheus" && cp -R "$dir/prometheus/." "$tmp/prometheus/"
# Each dashboard query as a recording rule, Grafana's variables given a value, so promtool parses it.
node -e '
const fs = require("fs"), path = require("path");
const dir = process.argv[1], out = process.argv[2];
const rules = [];
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  for (const p of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).panels)
    for (const t of p.targets ?? []) rules.push({ record: "dashboard:" + f.replace(/[^a-z0-9]/g, "_") + ":" + p.id + t.refId, expr: t.expr.replace(/\$__rate_interval/g, "5m").replace(/\$__range/g, "1h") });
}
fs.writeFileSync(out, JSON.stringify({ groups: [{ name: "dashboards", rules }] }));
' "$dir/grafana" "$tmp/prometheus/dashboards.rules.json"
run() {
  if command -v promtool >/dev/null 2>&1; then
    (cd "$tmp/prometheus/tests" && promtool "$@")
  else
    docker run --rm -v "$tmp/prometheus":/r -w /r/tests --entrypoint promtool "$image" "$@"
  fi
}
run check rules ../runtime-alerts.rules.yml ../runtime-settings.rules.yml ../dashboards.rules.json
run test rules runtime-alerts.test.yml
