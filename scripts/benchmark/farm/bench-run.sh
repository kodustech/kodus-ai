#!/usr/bin/env bash
# bench-run.sh <slot> <branch>
#
# ONE command, end to end: ensure a droplet -> build the branch's compiled
# engine -> clone a fresh per-run repo-set -> open the 50 PRs -> wait for Kody
# -> judge vs golden -> F1 -> destroy the repo-set. DETACHED: it daemonizes and
# returns immediately with a run id; track with `bench-result.sh <slot>`.
#
# Because step 2 ships YOUR local .env (BYOK + secrets) to the droplet, launch
# this YOURSELF with the `!` prefix (`! scripts/benchmark/farm/bench-run.sh a my-branch`)
# so the credential moves by your hand -- the agent can't scp it.
#
# Env:
#   BENCH_ENV_FILE   .env shipped to the droplet (default <repo>/.env)
#   BENCH_MODEL      curated model slug to benchmark (default: farm-run.ts's first)
#   BENCH_MAX_PRS    cap PRs for a cheap plumbing smoke (e.g. 2); 0 = all 50
#   BENCH_DO_SIZE    droplet size if one must be created (default s-4vcpu-8gb)
#
# Usage:
#   ! scripts/benchmark/farm/bench-run.sh a my-engine-experiment
#   ! scripts/benchmark/farm/bench-run.sh a            # branch defaults to the current one

set -euo pipefail
FARM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${FARM_SCRIPT_DIR}/_farm-common.sh"

SLOT="${1:-}"
[ -n "$SLOT" ] || { err "Usage: bench-run.sh <slot> [branch]   (branch defaults to the current checked-out branch)"; exit 2; }
# Branch is optional: default to whatever branch you're on. git archive needs a
# named ref, so a detached HEAD must pass the branch explicitly.
BRANCH="${2:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)}"
[ -n "$BRANCH" ] && [ "$BRANCH" != "HEAD" ] || { err "Could not resolve a branch (detached HEAD?) — pass it: bench-run.sh $SLOT <branch>"; exit 2; }

RESULTS_ROOT="${FARM_SCRIPT_DIR}/results"
E2E_DIR="${REPO_ROOT}/tests/e2e"
# The farm uses ONE dedicated token, FARM_GH_TOKEN — a fine-grained PAT scoped to
# the benchmark org with repo Administration/Contents/PR/Webhooks/Workflows. It
# is NOT GH_TEST_TOKEN (that's reused by the rest of the e2e suite). It's read
# from ~/.kodus-dev/config (exported by _common.sh's `set -a` config load) and
# used by clone-run-repos.ts (create/push/delete) + farm-run.ts (integration +
# PRs, via GitHubProvider tokenOverride).
[ -n "${FARM_GH_TOKEN:-}" ] || { err "FARM_GH_TOKEN not set — add it to ~/.kodus-dev/config (a PAT scoped to the benchmark org: repo Administration+Contents+Pull requests+Webhooks+Workflows, all repos)"; exit 2; }
export FARM_GH_TOKEN

# ---- foreground: stamp a run id, daemonize, return ----
if [ "${BENCH_RUN_BG:-0}" != "1" ]; then
    RUN_ID="$(normalize_name "${SLOT}")-$(date +%Y%m%d-%H%M%S)"
    RUNDIR="${RESULTS_ROOT}/${RUN_ID}"
    mkdir -p "$RUNDIR"
    echo "$BRANCH" > "${RUNDIR}/branch"
    echo "queued"  > "${RUNDIR}/status"
    # Record this as the slot's latest run so bench-result.sh <slot> finds it.
    ln -sfn "$RUN_ID" "${RESULTS_ROOT}/${SLOT}-latest"
    BENCH_RUN_BG=1 FARM_RUN_ID="$RUN_ID" nohup bash "$0" "$SLOT" "$BRANCH" \
        >"${RUNDIR}/run.log" 2>&1 &
    ok "Launched run '${RUN_ID}' (pid $!)"
    dim "  track:   scripts/benchmark/farm/bench-result.sh ${SLOT}"
    dim "  log:     ${RUNDIR}/run.log"
    exit 0
fi

# ---- background worker ----
RUN_ID="${FARM_RUN_ID}"
RUNDIR="${RESULTS_ROOT}/${RUN_ID}"
set_status() { echo "$1" > "${RUNDIR}/status"; log "[${RUN_ID}] phase: $1"; }
fail() { echo "failed: $1" > "${RUNDIR}/status"; err "[${RUN_ID}] FAILED at $1"; exit 1; }

trap 'fail "${CURRENT_PHASE:-unknown}"' ERR

CURRENT_PHASE="droplet"; set_status droplet
if ! state_exists "$(farm_name_for "$SLOT")"; then
    bash "${FARM_SCRIPT_DIR}/bench-up.sh" "$SLOT"
fi

# Resolve the model's required temperature from the catalog. Some models reject
# anything but a fixed temperature (kimi-k2.7-code: "only 1 is allowed") and the
# engine's per-prompt temps then 400 every LLM call -> 0 findings. The BYOK
# temperature isn't authoritative (the prompt's wins), so the engine's global
# API_LLM_TEMPERATURE_OVERRIDE is the real lever — bench-sync writes it into
# .env.local from BENCH_TEMPERATURE below.
if [ -n "${BENCH_MODEL:-}" ]; then
    export BENCH_TEMPERATURE="$(BENCH_MODEL="$BENCH_MODEL" node -e '
        const fs=require("fs");
        const slug=process.env.BENCH_MODEL;
        const ms=id=>id.replace(/^claude-/,"").replace(/-preview/g,"").replace(/[^a-zA-Z0-9]+/g,"-").replace(/-+$/,"").toLowerCase();
        try { const cat=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
            const m=(cat.models||[]).filter(x=>x.tier==="recommended").find(x=>ms(x.id)===slug);
            if(m&&m.defaults&&m.defaults.temperature!==undefined)process.stdout.write(String(m.defaults.temperature));
        } catch(e){}' "${REPO_ROOT}/apps/web/src/features/ee/byok/_data/curated-models.json" 2>/dev/null || true)"
    [ -n "${BENCH_TEMPERATURE:-}" ] && log "[${RUN_ID}] model ${BENCH_MODEL} -> API_LLM_TEMPERATURE_OVERRIDE=${BENCH_TEMPERATURE}"
fi

CURRENT_PHASE="build"; set_status build
bash "${FARM_SCRIPT_DIR}/bench-sync.sh" "$SLOT" "$BRANCH"

IP="$(farm_ip_for "$SLOT")"

# tests/e2e is a self-contained npm project (its own node_modules: tsx, undici,
# zod…). On a Docker-only host (no root node_modules) it must be installed once,
# same as scripts/e2e/run.sh does. tsx then resolves from tests/e2e/node_modules.
CURRENT_PHASE="deps"; set_status deps
( cd "$E2E_DIR" && [ -d node_modules ] || npm install --silent )

CURRENT_PHASE="clone"; set_status clone
# Full run: try to CLAIM a pre-cloned set from the pool (instant rename) before
# paying the ~30min mint. Capped smokes skip the pool (pool sets are full; an
# inline clone of the 1-2 capped repos is cheaper than consuming a full set).
CLAIMED=0
if [ "${BENCH_MAX_PRS:-0}" = "0" ]; then
    if ( cd "$E2E_DIR" && FARM_RUN_ID="$RUN_ID" npx tsx benchmark/clone-run-repos.ts --claim ); then
        CLAIMED=1
    fi
fi
if [ "$CLAIMED" = "0" ]; then
    ( cd "$E2E_DIR" && FARM_RUN_ID="$RUN_ID" FARM_MAX_PRS="${BENCH_MAX_PRS:-0}" npx tsx benchmark/clone-run-repos.ts )
fi
# Best-effort detached pool top-up so the pool self-sustains (replaces what this
# run consumed). nohup so it outlives this run; failures are non-fatal.
( cd "$E2E_DIR" && FARM_POOL_SIZE="${BENCH_POOL_SIZE:-3}" nohup npx tsx benchmark/clone-run-repos.ts --refill >/dev/null 2>&1 & ) || true

CURRENT_PHASE="review"; set_status review
( cd "$E2E_DIR" && FARM_RUN_ID="$RUN_ID" FARM_WEB_BASE_URL="http://${IP}:${WEB_PORT:-3000}" \
    FARM_MODEL_SLUG="${BENCH_MODEL:-}" FARM_MAX_PRS="${BENCH_MAX_PRS:-0}" npx tsx benchmark/farm-run.ts )

CURRENT_PHASE="judge"; set_status judge
( cd "$E2E_DIR" && SCORECARD_RESULTS="${E2E_DIR}/benchmark/results-farm-${RUN_ID}.json" \
    SCORECARD_OUT="${RUNDIR}/scorecard.json" npx tsx benchmark/scorecard.ts )
# Surface the headline F1 next to the run for bench-result.sh.
cp "${E2E_DIR}/benchmark/results-farm-${RUN_ID}.json" "${RUNDIR}/results.json" 2>/dev/null || true

CURRENT_PHASE="cleanup"; set_status cleanup
( cd "$E2E_DIR" && FARM_RUN_ID="$RUN_ID" FARM_MAX_PRS="${BENCH_MAX_PRS:-0}" npx tsx benchmark/clone-run-repos.ts --destroy ) || \
    warn "[${RUN_ID}] repo-set cleanup failed -- orphan kodus-e2e/*-${RUN_ID} may remain"

trap - ERR
set_status done
ok "[${RUN_ID}] done -- scorecard: ${RUNDIR}/scorecard.json"
