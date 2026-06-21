#!/usr/bin/env bash
# bench-pool-refill.sh [K]
#
# Keep K pre-cloned repo-sets warm in the benchmark org so `bench-run` claims one
# INSTANTLY instead of waiting ~30min to mint it. Each set = the 5 dataset repos
# fully cloned (named <base>-pool-<id>); a run claims one by renaming it to its
# run-id. This does the slow git work (mirror + full-history push, from the local
# mirror cache) so the hot path doesn't.
#
# Run it however you like to keep the pool stocked:
#   scripts/benchmark/farm/bench-pool-refill.sh 3        # one-shot top-up to 3
#   /loop 30m scripts/benchmark/farm/bench-pool-refill.sh 3   # keep it topped up
#   (bench-run also kicks a detached top-up after it claims, so it self-sustains)
#
# Needs FARM_GH_TOKEN / FARM_GH_ORG in ~/.kodus-dev/config (same as bench-run).

set -euo pipefail
FARM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${FARM_SCRIPT_DIR}/_farm-common.sh"

K="${1:-${BENCH_POOL_SIZE:-3}}"
[ -n "${FARM_GH_TOKEN:-}" ] || { err "FARM_GH_TOKEN not set -- add it to ~/.kodus-dev/config"; exit 2; }

log "Refilling the pool to ${K} set(s)..."
( cd "${REPO_ROOT}/tests/e2e" && FARM_POOL_SIZE="${K}" npx tsx benchmark/clone-run-repos.ts --refill )
ok "Pool topped up to ${K}."
