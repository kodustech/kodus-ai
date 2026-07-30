#!/usr/bin/env bash
# bench-sync.sh <slot> <branch>
#
# Ship a branch's SOURCE to a farm slot's droplet and (re)build the COMPILED
# stack there from docker-compose.bench.yml -- Option A: build on droplet, no
# registry. Idempotent: run it again with another branch to swap the variant.
#
# What it does:
#   1. `git archive <branch>` -> unpack the exact committed tree on the droplet
#      (no .git, no node_modules -- those are produced by the Docker build).
#   2. ship the .env (gitignored, so not in the archive -- see BENCH_ENV_FILE).
#   3. `docker compose -f docker-compose.bench.yml up -d --build` on the droplet.
#      Layer cache means only the changed `dist` recompiles on re-syncs.
#   4. wait for the API /health to go green.
#
# Tenant onboarding + webhook repoint + firing the 50 PRs are a separate step
# (see the banner printed at the end) -- this script's job is "branch -> running
# built stack".
#
# Usage:
#   scripts/benchmark/farm/bench-sync.sh a my-engine-experiment
#   BENCH_ENV_FILE=~/bench.env scripts/benchmark/farm/bench-sync.sh a main

set -euo pipefail
FARM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${FARM_SCRIPT_DIR}/_farm-common.sh"

SLOT="${1:-}"
BRANCH="${2:-}"
[ -n "$SLOT" ] && [ -n "$BRANCH" ] || { err "Usage: bench-sync.sh <slot> <branch>"; exit 2; }

IP="$(farm_ip_for "$SLOT")"
NAME="$(farm_name_for "$SLOT")"
ENV_SRC="$(bench_env_file)"

# --- preflight ---
git -C "$REPO_ROOT" rev-parse --verify --quiet "$BRANCH^{commit}" >/dev/null \
    || { err "Branch '$BRANCH' not found in $REPO_ROOT"; exit 1; }
[ -f "$ENV_SRC" ] \
    || { err "Env file not found: $ENV_SRC"; err "Set BENCH_ENV_FILE to a valid .env."; exit 1; }

COMMIT="$(git -C "$REPO_ROOT" rev-parse --short "$BRANCH")"
TAG="$(normalize_name "$BRANCH")-${COMMIT}"
log "Slot '$SLOT' ($NAME at $IP) <- branch '$BRANCH' @ $COMMIT"

# --- 1. ship source (exact branch tree) ---
log "Shipping source tree..."
farm_ssh "$SLOT" "rm -rf '$REMOTE_SRC' && mkdir -p '$REMOTE_SRC'"
git -C "$REPO_ROOT" archive --format=tar "$BRANCH" \
    | farm_ssh "$SLOT" "tar -x -C '$REMOTE_SRC'"

SSH_KEY="$(state_get "$NAME" .ssh_key_path)"
SCP="scp -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

# --- 1b. overlay the FARM's bench compose (decoupled from the benchmarked
# branch). The branch supplies the engine source + docker/Dockerfile (both from
# main), but docker-compose.bench.yml lives on the farm branch — so the branch's
# archive doesn't contain it. Ship it from the farm checkout so ANY branch
# (an experiment off main, before the farm is merged) builds. ---
log "Overlaying farm compose (docker-compose.bench.yml)..."
$SCP "$REPO_ROOT/docker-compose.bench.yml" "root@${IP}:${REMOTE_SRC}/docker-compose.bench.yml"

# --- 2. ship .env (gitignored -> not in archive) ---
log "Shipping env from $ENV_SRC..."
scp -i "$SSH_KEY" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    "$ENV_SRC" "root@${IP}:${REMOTE_SRC}/.env"

# Droplet-specific overrides in .env.local (compose loads it AFTER .env, so it
# wins). The GitHub webhook the app registers on each repo MUST be the droplet's
# PUBLIC ip:3332 (the webhooks service) so GitHub can deliver PR events — the
# dev default points at localhost. API_URL likewise points at the droplet.
log "Writing droplet webhook override (.env.local)..."
farm_ssh "$SLOT" "cat > '${REMOTE_SRC}/.env.local' <<EOF
API_GITHUB_CODE_MANAGEMENT_WEBHOOK=http://${IP}:3332/github/webhook
API_URL=http://${IP}:3001
EOF"

# Force the model's required temperature globally (the engine's per-prompt temps
# otherwise 400 on models like kimi-k2.7-code that only accept temperature=1).
# bench-run resolves BENCH_TEMPERATURE from the catalog; empty -> no override
# (the model keeps the engine's natural per-prompt temperatures).
if [ -n "${BENCH_TEMPERATURE:-}" ]; then
    log "Pinning API_LLM_TEMPERATURE_OVERRIDE=${BENCH_TEMPERATURE} (model requires it)"
    farm_ssh "$SLOT" "echo 'API_LLM_TEMPERATURE_OVERRIDE=${BENCH_TEMPERATURE}' >> '${REMOTE_SRC}/.env.local'"
fi

# --- 3. build + (re)start the compiled stack ---
# API_CLOUD_MODE=false: the droplet is a true self-contained self-hosted stack.
# Cloud mode routes /api/proxy/billing to a separate kodus-service-billing micro-
# service that the droplet doesn't run (the trial/migrate-to-free dance 500s). In
# self-hosted with no license the permission gate is Community Edition = "allow
# everything" (permissionValidation.validateSelfHostedPermissions), so reviews
# run with no billing/seat. Passed to BOTH the build arg (bakes environment.ts)
# and the runtime env so baked/runtime flags stay consistent.
COMPOSE="docker compose -f docker-compose.bench.yml"
BENV="BENCH_TAG='$TAG' API_CLOUD_MODE=false"

# Recreate the stack CLEANLY: `down` first, then build + `up`. Two reasons:
#  1. RAM — building the memory-hungry web (Next) build while the old 4-container
#     stack runs OOM-kills the 8GB box and resets SSH mid-build. With everything
#     down, the build has the whole box.
#  2. Correctness — partial stop/up on a long-lived rabbitmq leaves the
#     auto-delete `workflow.jobs.code_review.queue` dead with nobody recreating
#     it (api boots before the worker, fails QueueBind, never serves /health). A
#     full down→up reproduces the clean first-boot that declares it. Volumes
#     (pg/mongo/rabbit data) persist across `down`, so migrations stay no-ops.
log "Recreating stack cleanly (down)..."
farm_ssh "$SLOT" "cd '$REMOTE_SRC' && $COMPOSE down --remove-orphans 2>/dev/null || true"

# Build + up DETACHED on the droplet (nohup -> log + exit marker) and poll, so a
# transient SSH drop during the ~10min build doesn't fail the whole run. `up
# --build` builds with the stack down (max RAM) then starts a fresh set.
log "Building + starting stack (detached; first build ~10-15min, cached re-syncs faster)..."
farm_ssh "$SLOT" "cd '$REMOTE_SRC' && rm -f /tmp/bench-build.done && nohup env $BENV sh -c '$COMPOSE up -d --build > /tmp/bench-build.log 2>&1; echo \$? > /tmp/bench-build.done' >/dev/null 2>&1 </dev/null & echo launched"
BUILD_RC=""
for i in $(seq 1 160); do   # up to ~40min
    # `|| true` INSIDE the $() so a transient SSH hiccup while polling never
    # trips `set -e` (an unguarded $() that errors would silently kill the run
    # right after "launched", with the build itself perfectly fine). Empty when
    # the marker isn't there yet; once present it holds the exit code digits.
    done_rc="$(farm_ssh "$SLOT" "cat /tmp/bench-build.done 2>/dev/null" 2>/dev/null || true)"
    if [ -n "$done_rc" ]; then
        BUILD_RC="$(printf '%s' "$done_rc" | tr -dc 0-9)"
        break
    fi
    sleep 15
done
if [ "${BUILD_RC:-}" != "0" ]; then
    err "Build/up failed (rc=${BUILD_RC:-timeout}). Tail:"
    farm_ssh "$SLOT" "tail -25 /tmp/bench-build.log 2>/dev/null" || true
    exit 1
fi

# Reclaim disk: drop bench images from previous commits (kept only the current
# tag). Old tagged images aren't dangling, so prune alone won't catch them.
farm_ssh "$SLOT" "docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^kodus-ai-(bench-(api|worker|webhooks)|web-bench):' | grep -v ':${TAG}\$' | xargs -r docker rmi -f >/dev/null 2>&1 || true"

# --- 4. wait for API health ---
log "Waiting for API /health..."
HEALTHY=0
for i in $(seq 1 60); do
    if farm_ssh "$SLOT" "docker inspect -f '{{.State.Health.Status}}' kodus_api_bench 2>/dev/null | grep -q healthy"; then
        HEALTHY=1; break
    fi
    sleep 10
done
[ "$HEALTHY" = "1" ] || { err "API never became healthy; check: scripts/benchmark/farm/bench-status.sh $SLOT"; exit 1; }

ok "Slot '$SLOT' running branch '$BRANCH' @ $COMMIT (tag $TAG)"
cat <<EOF

  Stack is up and healthy. Webhook ingress for this slot:
      http://${IP}:${API_WEBHOOKS_PORT:-3332}

  Next (separate step -- tenant + PRs):
    - onboard the benchmark tenant + repo-set, pointing webhooks at the IP above
    - fire the 50 PRs (scripts/benchmark/benchmark-suite.sh) and judge
  See scripts/benchmark/farm/README.md.
EOF
