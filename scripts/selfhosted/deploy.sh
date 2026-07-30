#!/usr/bin/env bash
# Rebuilds local source and redeploys it to an alive self-hosted droplet.
#
# Use this to iterate on your branch without provisioning new droplets every
# time. Flow:
#
#   1. pnpm run selfhosted:provision                  # one-time, provisions droplet
#   2. (edit code on your laptop)
#   3. pnpm run selfhosted:deploy            # builds local → pushes to your
#                                           GHCR namespace → restarts on droplet
#   4. (repeat 2-3 as needed)
#   5. pnpm run selfhosted:destroy                # when done
#
# Images are pushed to `ghcr.io/<your-gh-user>/kodus-ai-{api,worker,webhook,
# web,mcp-manager}:dev-<instance-name>` so each dev has their own namespace
# and there's no conflict with org-published images.
#
# Required:
#   - An alive instance from `pnpm run selfhosted:provision`
#   - `gh auth login` completed (we read your token + username from gh CLI)
#   - Docker with buildx
#
# Usage:
#   pnpm run selfhosted:deploy                       # rebuild + redeploy all 5 services
#   pnpm run selfhosted:deploy --name wellington     # target a specific instance
#   pnpm run selfhosted:deploy -- api worker         # only rebuild these services
#   pnpm run selfhosted:deploy --no-build            # skip build, just pull + restart
#                                                  # (useful if a teammate already pushed)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

NAME_RAW="default"
SKIP_BUILD=0
SERVICES_FILTER=""
while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME_RAW="$2"; shift 2 ;;
        --name=*) NAME_RAW="${1#--name=}"; shift ;;
        --no-build) SKIP_BUILD=1; shift ;;
        --) shift; SERVICES_FILTER="$*"; break ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) err "Unknown arg: $1"; exit 2 ;;
    esac
done
NAME=$(normalize_name "$NAME_RAW")

# Self-healing: if no droplet exists for this name yet, provision one first.
# Provision in turn will auto-run setup if no config exists. So a fresh dev
# can run `pnpm run selfhosted:deploy` from scratch and end up with their code
# running on a droplet — no need to remember the order.
if ! state_exists "$NAME"; then
    log "No instance named '$NAME' yet. Provisioning one first..."
    echo ""
    if [ "$NAME_RAW" = "default" ]; then
        "$SCRIPT_DIR/provision.sh"
    else
        "$SCRIPT_DIR/provision.sh" --name "$NAME_RAW"
    fi
    echo ""
    log "Provision done. Continuing with deploy of your local code..."
    echo ""
fi

SERVER_IP=$(state_get "$NAME" .server_ip)
SSH_KEY_PATH=$(state_get "$NAME" .ssh_key_path)
[ -n "$SERVER_IP" ] && [ -f "$SSH_KEY_PATH" ] \
    || { err "State file is broken (missing server_ip or ssh key)"; exit 1; }

# ---------- preflight ----------
# Cheap checks BEFORE we kick off `docker buildx bake` (which can take 5-10
# min). The goal is to fail fast on every common cause of a botched deploy.
for c in docker jq ssh; do require_cmd "$c"; done

if ! docker buildx version >/dev/null 2>&1; then
    err "docker buildx is required. Update Docker Desktop or install buildx."
    exit 1
fi

# Reachability check — catches the case where the state file is stale (droplet
# was destroyed manually, deploy thinks it's alive). Quick (~1-2s).
log "Verifying droplet is reachable..."
if ! ssh -i "$SSH_KEY_PATH" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR \
        -o ConnectTimeout=5 \
        -o BatchMode=yes \
        "root@$SERVER_IP" "true" 2>/dev/null; then
    err "Cannot SSH into '$NAME' at $SERVER_IP."
    err "  The droplet may have been destroyed manually or the network is down."
    err "  Fix: pnpm run selfhosted:destroy --name $NAME    # cleans up stale state"
    err "       pnpm run selfhosted:deploy --name $NAME     # provisions fresh + deploys"
    exit 1
fi
ok "Droplet $SERVER_IP reachable"

if [ "$SKIP_BUILD" != "1" ]; then
    if ! command -v gh >/dev/null 2>&1; then
        err "gh CLI is required to authenticate to GHCR. Install with 'brew install gh'."
        exit 1
    fi
    if ! gh auth status >/dev/null 2>&1; then
        err "Run 'gh auth login' first — we need your GHCR token to push images."
        exit 1
    fi
    # Confirm the token has the scope GHCR needs. Default `gh auth login`
    # doesn't include write:packages, so this is the #1 cause of a deploy
    # that does 8 minutes of build and then fails at push.
    if ! gh auth status 2>&1 | grep -qE "write:packages"; then
        err "Your gh token doesn't have the 'write:packages' scope — GHCR will reject the push."
        err ""
        err "Fix:"
        err "  gh auth refresh -h github.com -s write:packages,read:packages"
        err ""
        err "Then re-run: pnpm run selfhosted:deploy${NAME:+ --name $NAME}"
        exit 1
    fi
    ok "gh token has write:packages scope"
fi

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# Lowercase the GH user — Docker requires lowercase in image references.
if [ "$SKIP_BUILD" != "1" ] || [ -z "${GH_USER:-}" ]; then
    GH_USER=$(gh api user --jq .login 2>/dev/null | tr '[:upper:]' '[:lower:]')
    [ -n "$GH_USER" ] || { err "Could not read your GitHub username from gh CLI."; exit 1; }
fi

DEV_TAG="dev-${NAME}"
REGISTRY="ghcr.io/${GH_USER}"

ALL_SERVICES=(api worker webhooks web mcp-manager)

image_name_for() {
    case "$1" in
        api)         echo "kodus-ai-api" ;;
        worker)      echo "kodus-ai-worker" ;;
        webhooks)    echo "kodus-ai-webhook" ;;
        web)         echo "kodus-ai-web" ;;
        mcp-manager) echo "kodus-mcp-manager" ;;
    esac
}

# Map our internal service key (matches docker-bake.hcl target names) to the
# service name used in the installer's docker-compose.yml. They diverge for
# `web` (installer calls it `kodus-web`) and `mcp-manager` (installer calls it
# `kodus-mcp-manager`). Using the wrong name in the override creates a parallel
# service instead of overriding the existing one — so the old :latest image
# keeps the published port, and the user's branch code runs unreachable on
# a duplicate container.
compose_service_for() {
    case "$1" in
        api)         echo "api" ;;
        worker)      echo "worker" ;;
        webhooks)    echo "webhooks" ;;
        web)         echo "kodus-web" ;;
        mcp-manager) echo "kodus-mcp-manager" ;;
    esac
}

if [ -n "$SERVICES_FILTER" ]; then
    # Validate the filter contains only known service names.
    for svc in $SERVICES_FILTER; do
        case "$svc" in
            api|worker|webhooks|web|mcp-manager) ;;
            *) err "Unknown service '$svc'. Valid: ${ALL_SERVICES[*]}"; exit 2 ;;
        esac
    done
    SERVICES_TO_REBUILD=($SERVICES_FILTER)
else
    SERVICES_TO_REBUILD=("${ALL_SERVICES[@]}")
fi

log "Redeploy target: ${BLUE}$NAME${NC} @ $SERVER_IP"
log "  Build local:    $([ "$SKIP_BUILD" = "1" ] && echo "skip" || echo "yes")"
log "  Services:       ${SERVICES_TO_REBUILD[*]}"
log "  Image registry: $REGISTRY"
log "  Tag:            $DEV_TAG"

# ---------- build ----------
if [ "$SKIP_BUILD" != "1" ]; then
    # Keep the local BuildKit cache bounded so it doesn't fill the disk.
    # 15 GB is enough to keep recent layers warm for fast incremental builds,
    # but prevents the 25-30 GB blowups we hit otherwise. `--filter
    # unused-for=168h` keeps anything touched in the last week.
    # Override with KODUS_BUILDX_KEEP_STORAGE=<value> if you have room to
    # spare or want a tighter cap.
    BUILDX_KEEP_STORAGE="${KODUS_BUILDX_KEEP_STORAGE:-15GB}"
    log "Pruning BuildKit cache to ${BUILDX_KEEP_STORAGE} (keeps recently-used layers)..."
    docker buildx prune \
        --keep-storage="$BUILDX_KEEP_STORAGE" \
        --filter unused-for=168h \
        --force >/dev/null 2>&1 || warn "buildx prune failed — continuing anyway"

    log "Logging in to GHCR (push)..."
    gh auth token | docker login ghcr.io -u "$GH_USER" --password-stdin >/dev/null

    # In docker-bake.hcl, target names match service names 1:1 (api, worker,
    # webhooks, web, mcp-manager), so we set ${target}.tags directly.
    BAKE_ARGS=()
    BAKE_TARGETS=()
    for svc in "${SERVICES_TO_REBUILD[@]}"; do
        image_name=$(image_name_for "$svc")
        full_tag="${REGISTRY}/${image_name}:${DEV_TAG}"
        BAKE_ARGS+=("--set" "${svc}.tags=${full_tag}")
        BAKE_TARGETS+=("$svc")
    done

    # Force linux/amd64. DigitalOcean droplets default to x86; M-series Macs
    # build arm64 unless told otherwise — which then fails at pull on the
    # droplet with "no matching manifest for linux/amd64". QEMU emulates
    # amd64 on the Mac (~2x slower build but works everywhere).
    # Override with KODUS_DEPLOY_PLATFORM=linux/arm64 if you ever provision
    # an ARM droplet (Ampere on Hetzner, AWS Graviton, etc.).
    DEPLOY_PLATFORM="${KODUS_DEPLOY_PLATFORM:-linux/amd64}"
    log "Building (${#BAKE_TARGETS[@]} service$([ ${#BAKE_TARGETS[@]} -gt 1 ] && echo s), platform $DEPLOY_PLATFORM)..."
    docker buildx bake -f docker-bake.hcl \
        --set "base.args.API_CLOUD_MODE=false" \
        --set "*.platform=$DEPLOY_PLATFORM" \
        "${BAKE_ARGS[@]}" \
        --push \
        "${BAKE_TARGETS[@]}"
    ok "Build + push done"
fi

# ---------- generate override on droplet ----------
log "Writing docker-compose.override.yml on droplet..."
# Always include all 5 services in the override so the droplet runs a
# consistent dev tag across them (even if you only rebuilt one this
# iteration — the others stay on the dev tag from a previous round).
OVERRIDE_YML="services:"
for svc in "${ALL_SERVICES[@]}"; do
    image_name=$(image_name_for "$svc")
    compose_svc=$(compose_service_for "$svc")
    OVERRIDE_YML="${OVERRIDE_YML}
  ${compose_svc}:
    image: ${REGISTRY}/${image_name}:${DEV_TAG}"
done

ssh_to "$NAME" "cat > /opt/kodus-installer/docker-compose.override.yml" <<EOF
$OVERRIDE_YML
EOF
ok "Override written"

# Also persist the override on the dev machine so any FUTURE droplet
# (e.g. the sso-e2e droplet, which delegates to selfhosted/provision.sh
# but never runs deploy.sh) can pick up the same image tags without
# requiring a separate rebuild + push. provision.sh checks for this
# file post-rsync and SCPs it onto the new droplet BEFORE install.sh
# runs, so install.sh's docker compose up sees the override and pulls
# from ghcr.io/<gh-user>/*:dev-<name> instead of the org's stale or
# nonexistent :latest tags.
KODUS_DEV_DIR="${HOME}/.kodus-dev"
mkdir -p "$KODUS_DEV_DIR"
cat > "${KODUS_DEV_DIR}/last-deploy.override.yml" <<EOF
$OVERRIDE_YML
EOF
ok "Cached override at ~/.kodus-dev/last-deploy.override.yml (for sso-e2e + future droplets)"

# ---------- pull + restart on droplet ----------
# Translate our internal service keys → compose service names so we don't
# accidentally `pull web` (no such service) instead of `pull kodus-web`.
COMPOSE_SERVICES_TO_REBUILD=()
for svc in "${SERVICES_TO_REBUILD[@]}"; do
    COMPOSE_SERVICES_TO_REBUILD+=("$(compose_service_for "$svc")")
done

log "Logging in to GHCR on droplet + pulling new images..."
GH_TOKEN_FOR_DROPLET=$(gh auth token)
ssh_to "$NAME" bash <<REMOTE
set -e
cd /opt/kodus-installer
echo "$GH_TOKEN_FOR_DROPLET" | docker login ghcr.io -u "$GH_USER" --password-stdin >/dev/null
docker compose pull ${COMPOSE_SERVICES_TO_REBUILD[@]}
# --remove-orphans cleans up any leftover services that came from a previous
# broken override (e.g. parallel \`web\` / \`mcp-manager\` services that don't
# exist in the real compose). Without this, the old containers keep port 3000
# and the user hits the published :latest image instead of their branch code.
docker compose up -d --remove-orphans ${COMPOSE_SERVICES_TO_REBUILD[@]}
docker logout ghcr.io >/dev/null
REMOTE
unset GH_TOKEN_FOR_DROPLET
ok "Containers restarted"

# ---------- wait for health ----------
log "Waiting for services to respond..."
HEALTH_FAILED=()
for label_port in "web:3000" "api:3001" "webhooks:3332"; do
    label="${label_port%:*}"; port="${label_port#*:}"
    # Skip services we didn't rebuild
    case "$label" in
        web|api|webhooks)
            services_str=" ${SERVICES_TO_REBUILD[*]} "
            if [[ ! "$services_str" =~ " $label " ]]; then
                continue
            fi
            ;;
    esac
    SUCCESS=0
    for i in $(seq 1 100); do
        code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://$SERVER_IP:$port" || echo 000)
        if [[ "$code" =~ ^[234][0-9][0-9]$ ]]; then SUCCESS=1; break; fi
        sleep 3
    done
    [ "$SUCCESS" = "1" ] && ok "$label up" || { warn "$label not responding"; HEALTH_FAILED+=("$label_port"); }
done

if [ ${#HEALTH_FAILED[@]} -gt 0 ]; then
    err "Health check failed for: ${HEALTH_FAILED[*]}"
    err "  ssh in: pnpm run selfhosted:ssh${NAME:+ --name $NAME}"
    err "  logs:   pnpm run selfhosted:logs${NAME:+ --name $NAME}"
    exit 1
fi

DASHBOARD=$(state_get "$NAME" .dashboard_url)
echo ""
ok "Redeploy done"
echo ""
echo "  Dashboard: $DASHBOARD"
echo "  Image tag: $DEV_TAG"
echo "  Services:  ${SERVICES_TO_REBUILD[*]}"
echo ""
echo "  Iterate:   edit code → pnpm run selfhosted:deploy${NAME:+ --name $NAME}"
echo "  Logs:      pnpm run selfhosted:logs${NAME:+ --name $NAME}"
echo "  Destroy:   pnpm run selfhosted:destroy${NAME:+ --name $NAME}"
echo ""
