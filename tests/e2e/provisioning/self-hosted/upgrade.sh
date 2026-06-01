#!/usr/bin/env bash
# Self-hosted upgrade N-1 → N scenario provisioning.
#
# Provisions a fresh VM with the PREVIOUS released tag, exercises it (signup +
# trigger a review on the fixture PR to seed state), then performs a docker
# compose pull to the NEW candidate tag and re-runs the matrix to validate
# that nothing broke across the upgrade boundary.
#
# Required env:
#   UPGRADE_FROM_TAG       previous tag (e.g. selfhosted-1.41.0)
#   UPGRADE_TO_TAG         new candidate tag (e.g. selfhosted-1.42.0-rc.1)
#   KODUS_INSTALLER_PATH   path to a checkout of kodus-installer
#   DIGITALOCEAN_TOKEN     (or HCLOUD_TOKEN)
#   GH_TEST_TOKEN, GH_TEST_REPO, GH_TEST_PR_NUMBER
#
# Exit status is the matrix runner's exit status from the post-upgrade run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
E2E_ROOT="${REPO_ROOT}/tests/e2e"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[upgrade]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}      $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}    $*"; }
err()  { echo -e "${RED}[err]${NC}     $*" >&2; }

: "${UPGRADE_FROM_TAG:?UPGRADE_FROM_TAG is required}"
: "${UPGRADE_TO_TAG:?UPGRADE_TO_TAG is required}"

log "Step 1/3: provisioning stack at $UPGRADE_FROM_TAG (N-1)"
IMAGE_TAG="$UPGRADE_FROM_TAG" \
    MATRIX_FILE="matrix/fast.yml" \
    LICENSE_MODE="${LICENSE_MODE:-license-paid}" \
    TEST_KEEP_RUNNING=1 \
    "$E2E_ROOT/provisioning/self-hosted/vm.sh" || true

# vm.sh exits without teardown when TEST_KEEP_RUNNING=1. The droplet is still
# alive here. vm.sh runs as a subprocess so any `export SERVER_IP=...` it
# does dies with the child shell — read the IP back from the state file
# vm.sh writes (`.kodus-dev/selfhosted-vm-default.json`) instead.
SERVER_IP=$(jq -r '.server_ip // empty' "$REPO_ROOT/.kodus-dev/selfhosted-vm-default.json" 2>/dev/null || true)
if [ -z "${SERVER_IP:-}" ]; then
    err "vm.sh did not save SERVER_IP — upgrade flow expects a kept-alive droplet"
    exit 1
fi

log "Step 2/3: rolling stack from $UPGRADE_FROM_TAG to $UPGRADE_TO_TAG"
ssh -i "$LOCAL_SSH_KEY" -o StrictHostKeyChecking=no "root@$SERVER_IP" bash <<REMOTE
set -e
cd /opt/kodus-installer
sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=$UPGRADE_TO_TAG|" .env
docker compose pull
docker compose up -d
REMOTE

log "Waiting for upgraded services to respond..."
for label_port in "web:3000" "api:3001" "webhooks:3332"; do
    label="${label_port%:*}"; port="${label_port#*:}"
    SUCCESS=0
    for i in $(seq 1 100); do
        code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://$SERVER_IP:$port" || echo 000)
        if [[ "$code" =~ ^[234][0-9][0-9]$ ]]; then SUCCESS=1; break; fi
        sleep 3
    done
    [ "$SUCCESS" = "1" ] && ok "$label up post-upgrade" || { err "$label not responding post-upgrade"; exit 1; }
done

log "Step 3/3: running upgrade scenario matrix"
export UPGRADE_PRE_VALIDATED=1
cd "$E2E_ROOT"
exec ./node_modules/.bin/tsx cli/run-matrix.ts matrix/full.yml --target self-hosted
