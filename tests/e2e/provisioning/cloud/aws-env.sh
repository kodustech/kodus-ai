#!/usr/bin/env bash
# Bring up (or tear down) a disposable CLOUD-mode Kodus environment on AWS.
#
# This is the "copy of QA" the cloud matrix can point at instead of the shared
# qa.web.kodus.io. Shared QA is a bottleneck and a false signal: on 2026-07-31
# and 2026-08-07 the release train stopped at the cloud gate for reasons that
# had nothing to do with the change under test, and self-hosted validation was
# skipped as collateral. An environment per run removes that entire class.
#
# It deliberately reuses provisioning/self-hosted/vm.sh rather than
# reimplementing provisioning. Cloud and self-hosted share a topology on
# purpose; a second provisioning script would drift from the first and we would
# be debugging the difference instead of the product.
#
# What differs from a self-hosted stack is exactly two things:
#   1. the IMAGES — API_CLOUD_MODE is baked at BUILD time, so cloud needs
#      images from .github/workflows/e2e-cloud-images.yml (tag `cloud-*`);
#   2. no license key — entitlement comes from billing, not a JWT.
#
# usage:
#   IMAGE_TAG=cloud-<sha> bash tests/e2e/provisioning/cloud/aws-env.sh up
#   bash tests/e2e/provisioning/cloud/aws-env.sh down <instance-id>
#   bash tests/e2e/provisioning/cloud/aws-env.sh list
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="${KODUS_ENV_STATE_DIR:-$HOME/.kodus-dev/e2e-envs}"
AWS_REGION_E2E="${AWS_REGION_E2E:-${AWS_DEFAULT_REGION:-us-east-2}}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[cloud-env]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}         $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}       $*"; }
err()  { echo -e "${RED}[err]${NC}        $*" >&2; }

cmd_up() {
    if [ -z "${IMAGE_TAG:-}" ]; then
        err "IMAGE_TAG is required and must be a CLOUD-mode tag (e.g. cloud-1a2b3c4)."
        err "Self-hosted tags are compiled with API_CLOUD_MODE off and will boot the wrong topology."
        err "Build one with the 'E2E: build cloud-mode images' workflow."
        exit 2
    fi
    case "$IMAGE_TAG" in
        cloud-*) ;;
        *)
            # Fail closed. Booting a self-hosted image here produces a stack
            # that looks right and behaves like the other topology — the most
            # expensive kind of wrong.
            err "IMAGE_TAG '$IMAGE_TAG' is not a cloud-mode tag (expected cloud-*)."
            err "Override with ALLOW_NON_CLOUD_TAG=1 only if you know the image was built with API_CLOUD_MODE=true."
            [ "${ALLOW_NON_CLOUD_TAG:-0}" = "1" ] || exit 2
            ;;
    esac

    log "Provisioning cloud-mode stack on AWS ($AWS_REGION_E2E), image $IMAGE_TAG"
    KODUS_STACK_MODE=cloud \
    LICENSE_MODE=cloud-none \
    PROVISION_ONLY=1 \
    TEST_VM_PROVIDER="${TEST_VM_PROVIDER:-aws}" \
    TEST_KEEP_RUNNING=1 \
    IMAGE_TAG="$IMAGE_TAG" \
        bash "$E2E_ROOT/provisioning/self-hosted/vm.sh"
}

cmd_down() {
    local id="${1:-}"
    if [ -z "$id" ]; then
        err "usage: aws-env.sh down <instance-id>"
        exit 2
    fi
    # Re-confirm the tag before terminating. The name is not enough — this is
    # the same fail-closed rule the reaper uses, for the same reason: an id
    # typed by hand must never be able to take down something else.
    local project
    project=$(aws ec2 describe-instances --region "$AWS_REGION_E2E" \
        --instance-ids "$id" \
        --query 'Reservations[0].Instances[0].Tags[?Key==`Project`]|[0].Value' \
        --output text 2>/dev/null || echo "")
    if [ "$project" != "kodus-e2e" ]; then
        err "SAFETY: instance $id is not tagged Project=kodus-e2e (got '${project:-none}') — refusing."
        exit 1
    fi
    aws ec2 terminate-instances --region "$AWS_REGION_E2E" --instance-ids "$id" >/dev/null
    rm -f "$STATE_DIR/$id.env"
    ok "Terminated $id"
}

cmd_list() {
    log "Cloud-mode environments in $AWS_REGION_E2E"
    aws ec2 describe-instances --region "$AWS_REGION_E2E" \
        --filters "Name=tag:Project,Values=kodus-e2e" \
                  "Name=instance-state-name,Values=pending,running" \
        --query 'Reservations[].Instances[].[InstanceId,PublicIpAddress,LaunchTime,Tags[?Key==`Name`]|[0].Value]' \
        --output table 2>/dev/null || warn "Could not list instances"
    if [ -d "$STATE_DIR" ]; then
        echo ""
        log "Local state files ($STATE_DIR):"
        ls -1 "$STATE_DIR" 2>/dev/null | sed 's/^/  /' || true
    fi
}

case "${1:-}" in
    up)   shift; cmd_up "$@" ;;
    down) shift; cmd_down "$@" ;;
    list) shift; cmd_list "$@" ;;
    *)
        echo "usage: aws-env.sh {up|down <instance-id>|list}"
        echo ""
        echo "  up    IMAGE_TAG=cloud-<sha> required. Prints TARGET_* URLs and"
        echo "        writes a state file under $STATE_DIR."
        echo "  down  terminates an instance (refuses anything not tagged"
        echo "        Project=kodus-e2e)."
        echo "  list  live environments + local state files."
        exit 2
        ;;
esac
