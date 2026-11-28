#!/usr/bin/env bash
# One command to run the Kody Runtime dev stack on a VM whose Runs execute on boat hosts.
# See docs/runtime/dev-boat.md. Idempotent: a re-run rewrites the files and applies the pool again.
#
# Usage: scripts/runtime/dev-boat-up.sh --public-host <ip-or-dns> [--org <uuid>[,<uuid>]]
#          [--boat-key-op <op://ref>] [--image-store <endpoint>] [--fleet-dir <dir>] [--no-billing] [--dry-run]
# The boat key comes from BOAT_API_KEY in the environment, or from `op read <ref>`. It is never printed.
# This script never changes a cloud firewall: open TCP 3410 yourself (the last lines say so).
set -euo pipefail

# The cell image every boat host boots from. Bump it here when a new base is published.
BOAT_CELL_BASE=kodus-cell-dev-0d8e68f43-gvisor-v33

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TPL="$ROOT/scripts/runtime/dev-boat"
CERTS="$ROOT/.runtime-certs"
FLEET_DIR="${HOME}/fleet"
PUBLIC_HOST="" ORGS="" KEY_OP="" IMAGE_STORE="" DRY=0 BILLING=1

die() { echo "dev-boat-up: $*" >&2; exit 1; }
step() { echo "==> $*"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-host) PUBLIC_HOST="${2:-}"; shift 2 ;;
    --org) ORGS="${2:-}"; shift 2 ;;
    --boat-key-op) KEY_OP="${2:-}"; shift 2 ;;
    --image-store) IMAGE_STORE="${2:-}"; shift 2 ;;
    --fleet-dir) FLEET_DIR="${2:-}"; shift 2 ;;
    --no-billing) BILLING=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n 2,8p "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$PUBLIC_HOST" ]] || die "--public-host <ip-or-dns> is required"
[[ "$PUBLIC_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "--public-host must be an IP or a DNS name, no scheme or port"
[[ -z "$IMAGE_STORE" || "$IMAGE_STORE" =~ ^https://[^[:space:]]+$ ]] || die "--image-store must be an https:// endpoint"
UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

DC=(docker compose -f docker-compose.dev.yml)
[[ $BILLING -eq 1 && -f "$ROOT/docker-compose.billing.yml" ]] && DC+=(-f docker-compose.billing.yml)
DC+=(-f "$FLEET_DIR/compose.fleet.yml" -f "$FLEET_DIR/compose.web-origin.yml" --profile runtime --profile runtime-fleet)
cd "$ROOT"

ORG_SQL="SELECT id || E'\\t' || name FROM organizations ORDER BY name;"
psql_dev() { docker exec -i db_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq' ; }

render() { # template out  (placeholders @@NAME@@ from the variables below)
  local c; c="$(cat "$1")"
  c="${c//@@PUBLIC_HOST@@/$PUBLIC_HOST}"; c="${c//@@FLEET_DIR@@/$FLEET_DIR}"
  c="${c//@@BOAT_CELL_BASE@@/$BOAT_CELL_BASE}"; c="${c//@@ORGS@@/$ORGS_LIST}"
  c="${c//@@IMAGE_STORE@@/$IMAGE_STORE_BLOCK}"
  printf '%s\n' "$c" >"$2"
}

# 1. Orgs ---------------------------------------------------------------------------------------
if [[ -z "$ORGS" ]]; then
  if [[ $DRY -eq 1 ]]; then ORGS="00000000-0000-0000-0000-000000000000"; step "orgs: would list them from the dev DB (placeholder in the dry run)"
  else
    step "no --org: listing organizations from the dev DB"
    docker ps --format '{{.Names}}' | grep -qx db_postgres || docker compose -f docker-compose.dev.yml up -d db_postgres >/dev/null 2>&1 || true
    LIST="$(psql_dev <<<"$ORG_SQL" 2>/dev/null || true)"
    [[ -n "$LIST" ]] || die "no organizations found (is the dev DB migrated and an org created?). Pass --org <uuid>"
    N="$(printf '%s\n' "$LIST" | wc -l | tr -d ' ')"
    if [[ "$N" -eq 1 ]]; then ORGS="${LIST%%$'\t'*}"; echo "only org: $ORGS"
    else printf '%s\n' "$LIST"; read -r -p "Org uuid(s), comma separated: " ORGS; fi
  fi
fi
ORGS="${ORGS// /}"
IFS=, read -r -a ORG_ARR <<<"$ORGS"
for o in "${ORG_ARR[@]}"; do [[ "$o" =~ $UUID_RE ]] || die "not a uuid: $o"; done
ORGS_LIST="${ORGS//,/, }"
IMAGE_STORE_BLOCK=""
if [[ -n "$IMAGE_STORE" ]]; then
  IMAGE_STORE_BLOCK="imageStore:
  provider: oci-registry
  endpoint: $IMAGE_STORE
  prefix: kodus-ci
  service: kodus-image-store
  tokenTtlSeconds: 600"
fi

# 2. Dry run: render to a temp dir and stop ------------------------------------------------------
if [[ $DRY -eq 1 ]]; then
  OUT="$(mktemp -d)"
  render "$TPL/compose.fleet.yml.tmpl" "$OUT/compose.fleet.yml"
  render "$TPL/compose.web-origin.yml.tmpl" "$OUT/compose.web-origin.yml"
  render "$TPL/boat-dev.yaml.tmpl" "$OUT/boat-dev.yaml"
  step "dry run: rendered to $OUT (compose.fleet.yml, compose.web-origin.yml, boat-dev.yaml); nothing else was touched"
  echo "would: 1. write $FLEET_DIR/boat.env (mode 600) from BOAT_API_KEY${KEY_OP:+ or op read $KEY_OP}"
  echo "would: 2. run scripts/runtime/dev-ca.sh .runtime-certs (hub SAN $PUBLIC_HOST) if the certs are missing or the host changed"
  echo "would: 3. write $FLEET_DIR/compose.fleet.yml and compose.web-origin.yml, and .runtime-certs/pools/boat-dev.yaml"
  echo "would: 4. ${DC[*]} up -d"
  echo "would: 5. set release_track=alpha on ${ORGS}; wait for 'runtime-hub listening'; run runtime-fleet apply -f /certs/pools/boat-dev.yaml"
  echo "would: 6. verify runtime.runtime_host_pools has a boat pool with base $BOAT_CELL_BASE"
  echo "would: 7. print the next steps (open TCP 3410 yourself; the script never edits a firewall)"
  exit 0
fi

command -v docker >/dev/null || die "docker is required"
command -v openssl >/dev/null || die "openssl is required"

# 3. Boat key -> $FLEET_DIR/boat.env (mode 600, never echoed) --------------------------------------
step "writing $FLEET_DIR/boat.env"
KEY="${BOAT_API_KEY:-}"
if [[ -z "$KEY" && -n "$KEY_OP" ]]; then command -v op >/dev/null || die "op (1Password CLI) not found"; KEY="$(op read "$KEY_OP")"; fi
[[ -n "$KEY" ]] || die "no boat key: export BOAT_API_KEY or pass --boat-key-op <op://ref>"
[[ "$KEY" =~ ^[[:graph:]]+$ && "$KEY" != *\'* && "$KEY" != *\"* && "$KEY" != *\$* ]] || die "the boat key has characters that cannot be written safely"
mkdir -p "$FLEET_DIR"; chmod 700 "$FLEET_DIR"
rm -f "$FLEET_DIR/boat.env"
( umask 077; cat >"$FLEET_DIR/boat.env" <<ENV
RUNTIME_BOAT_API_KEY=$KEY
ENV
)
chmod 600 "$FLEET_DIR/boat.env"
unset KEY

# 4. Certs ----------------------------------------------------------------------------------------
if [[ ! -f "$CERTS/container.env" || ! -f "$CERTS/fleet.env" || "$(cat "$CERTS/hub-sans" 2>/dev/null || true)" != "$PUBLIC_HOST" ]]; then
  step "generating the runtime certs (hub names: runtime-hub $PUBLIC_HOST)"
  RUNTIME_HUB_SANS="runtime-hub $PUBLIC_HOST" "$ROOT/scripts/runtime/dev-ca.sh" "$CERTS" cell-dev-1
  printf '%s\n' "$PUBLIC_HOST" >"$CERTS/hub-sans"
else step "runtime certs already match $PUBLIC_HOST"; fi
if [[ -n "$IMAGE_STORE" ]]; then
  [[ -f "$CERTS/image-store-signing.key" ]] || ( umask 077; openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out "$CERTS/image-store-signing.key" )
  grep -q '^RUNTIME_IMAGE_STORE_SIGNING_KEY=' "$CERTS/container.env" || printf 'RUNTIME_IMAGE_STORE_SIGNING_KEY=/certs/image-store-signing.key\n' >>"$CERTS/container.env"
fi

# 5. Compose overrides and pool file ----------------------------------------------------------------
step "writing the compose overrides and the pool file (base $BOAT_CELL_BASE)"
render "$TPL/compose.fleet.yml.tmpl" "$FLEET_DIR/compose.fleet.yml"
render "$TPL/compose.web-origin.yml.tmpl" "$FLEET_DIR/compose.web-origin.yml"
mkdir -p "$CERTS/pools"
render "$TPL/boat-dev.yaml.tmpl" "$CERTS/pools/boat-dev.yaml"
[[ -f .env ]] || { [[ -f .env.example ]] && cp .env.example .env && step "created .env from .env.example"; }

# 6. Start, wait, apply -----------------------------------------------------------------------------
step "starting the stack (the first build takes a while)"
"${DC[@]}" up -d
step "waiting for the hub"
for _ in $(seq 1 120); do docker logs kodus_runtime_hub 2>&1 | grep -q 'runtime-hub listening' && break; sleep 5; done
docker logs kodus_runtime_hub 2>&1 | grep -q 'runtime-hub listening' || die "the hub did not log 'runtime-hub listening' in 10 minutes: docker logs kodus_runtime_hub"
for _ in $(seq 1 60); do [[ "$(docker inspect -f '{{.State.Running}}' kodus_runtime_fleet 2>/dev/null)" == true ]] && break; sleep 5; done

step "setting the alpha release track on the org(s)"
IDS="'${ORGS//,/\',\'}'"
for _ in $(seq 1 60); do
  psql_dev <<<"UPDATE organizations SET release_track='alpha' WHERE id IN ($IDS);" >/dev/null 2>&1 && break; sleep 5
done

step "applying the pool"
docker exec kodus_runtime_fleet sh -c "set -a && . /certs/container.env && . /certs/fleet.env && set +a && node -r ts-node/register/transpile-only -r tsconfig-paths/register apps/runtime/src/fleet/main.ts apply -f /certs/pools/boat-dev.yaml"
HIT="$(psql_dev <<<"SELECT count(*) FROM runtime.runtime_host_pools WHERE provider='boat' AND spec::text LIKE '%$BOAT_CELL_BASE%';" | tr -d '[:space:]')"
[[ "${HIT:-0}" -ge 1 ]] || die "the DB has no boat pool with base $BOAT_CELL_BASE after apply"
step "verified: a boat pool with base $BOAT_CELL_BASE is in runtime.runtime_host_pools"

cat <<NEXT

Next steps (manual):
  1. Open inbound TCP 3410 on this VM's firewall / security group for the boat hosts. This script does not touch cloud firewalls.
  2. Open the UI: http://$PUBLIC_HOST:3000
  3. In the repo's environment settings, set the machine size (medium for heavy apps).
  4. Comment "@kody runtime" on a PR of a connected repo.
Re-run this script after editing a template or bumping BOAT_CELL_BASE: editing the pool file alone applies nothing.
NEXT
