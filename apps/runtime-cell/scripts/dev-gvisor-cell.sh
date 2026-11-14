#!/usr/bin/env bash
# A docker-gvisor cell for development, on one Linux host with Docker and
# runsc, as root: the cell agent plus what a self-hosted cell runs beside it,
# each in its own container:
#   egress    proxy and resolver (cmd/egress), the claims' only way out
#   injector  credential injector (cmd/injector), required by the policy push
#   observer  image (cmd/observer) each claim's observer machine runs under
#             runsc on the claim network
# It runs in the foreground until killed, then removes its containers.
#
#   sudo apps/runtime-cell/scripts/dev-gvisor-cell.sh <certs-dir> <bin-dir>
#
# certs-dir: the dev CA output (scripts/runtime/dev-ca.sh): ca.pem, ca.key,
#   cell.pem, cell.key, cell-id. The dev CA also issues the egress, injector
#   and observer server certificates here; production gives the observers a
#   CA of their own.
# bin-dir: cell, egress, injector, observer built for this host (static).
# Env: HUB_URL (wss://host.orb.internal:3410/cells), GIT_API
# (http://host.orb.internal:3499), EGRESS_ALLOW (hosts every claim may
# reach: the registry and npm by default), UPSTREAM_DNS (1.1.1.1:53),
# STATE (/var/lib/kodus-cell-dev), HOLDER_IMAGE, BUILDER_IMAGE, MEM_LIMIT (the
# default size), MEM_MAX and CPUS_MAX (the largest size one claim may ask),
# BROWSER_IMAGE (the browser runner, browser-runner/, by digest: browser
# probes run only with it, ADR-071), BUILD_STATE (keep each environment's
# BuildKit state) and BUILD_STATE_KEEP (what its GC keeps, 20GB by default:
# a Go monorepo's module and build caches pass that).
set -euo pipefail
CERTS="$(cd "${1:?certs dir}" && pwd)"
BIN="$(cd "${2:?bin dir}" && pwd)"
HUB_URL="${HUB_URL:-wss://host.orb.internal:3410/cells}"
GIT_API="${GIT_API:-http://host.orb.internal:3499}"
EGRESS_ALLOW="${EGRESS_ALLOW:-registry-1.docker.io,auth.docker.io,production.cloudfront.docker.com,registry.npmjs.org}"
UPSTREAM_DNS="${UPSTREAM_DNS:-1.1.1.1:53}"
STATE="${STATE:-/var/lib/kodus-cell-dev}"
HOLDER_IMAGE="${HOLDER_IMAGE:-alpine:3.20}"
BUILDER_IMAGE="${BUILDER_IMAGE:-moby/buildkit:v0.34.0-rootless}"
OBSERVER_IMAGE=kodus-dev-observer:local
EGRESS=kodus-dev-egress
INJECTOR=kodus-dev-injector
[ "$(id -u)" = 0 ] || { echo "run as root: the cell drives Docker and runsc" >&2; exit 1; }
docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}' | grep -qw runsc || { echo "runsc is not a Docker runtime here" >&2; exit 1; }

# Keys stay on this host's own disk, root-owned and 0600; never printed.
umask 077
rm -rf "$STATE"/{observer-tls,egress,injector}
mkdir -p "$STATE"/{pki,observer-tls,egress,injector,work}
P="$STATE/pki"
cp "$CERTS/ca.pem" "$CERTS/ca.key" "$P/"
# The cell renews cell.pem in place and the hub then pins only the renewed
# one: a restart keeps that renewal, unless the dev CA issued a newer pair.
if [ ! -f "$P/cell.pem" ] || [ "$CERTS/cell.pem" -nt "$P/cell.pem" ]; then
  cp "$CERTS/cell.pem" "$CERTS/cell.key" "$P/"
fi
CELL_ID="$(cat "$CERTS/cell-id")"

key() { openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out "$1"; }
# server <name> <dir> <subjectAltName>: <dir>/cert.pem and <dir>/key.pem,
# the names cmd/egress, cmd/injector and cmd/observer read.
server() {
  key "$2/key.pem"
  openssl req -new -key "$2/key.pem" -subj "/O=kodus-runtime/OU=$1/CN=$1" -out "$2/cert.csr"
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$3" >"$2/cert.ext"
  openssl x509 -req -in "$2/cert.csr" -CA "$P/ca.pem" -CAkey "$P/ca.key" -CAcreateserial -sha256 -days 2 -extfile "$2/cert.ext" -out "$2/cert.pem" 2>/dev/null
  rm -f "$2/cert.csr" "$2/cert.ext" "$P/ca.srl"
}
# The control ports are published on this host's loopback only.
server kodus-egress "$STATE/egress" "DNS:kodus-egress,IP:127.0.0.1"
server kodus-injector "$STATE/injector" "DNS:kodus-injector,IP:127.0.0.1"
# An observer's address is known only once it runs: its certificate names it.
server kodus-observer "$STATE/observer-tls" "DNS:kodus-observer"
# The agent signs every egress policy with this key; the enforcers know its half.
openssl genpkey -algorithm ed25519 -out "$P/policy.key.pem"
openssl pkey -in "$P/policy.key.pem" -pubout -out "$P/policy.pub.pem"
# The injector's own CA for the leaves it shows the claims (never the hub's).
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$STATE/injector/cell-ca.key.pem" \
  -out "$STATE/injector/cell-ca.pem" -days 2 -subj "/O=kodus-runtime/CN=kodus dev injector CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign" 2>/dev/null
for d in egress injector observer-tls; do
  cp "$P/ca.pem" "$STATE/$d/ca.pem"
done
cp "$P/policy.pub.pem" "$STATE/egress/agent.pub.pem"
cp "$P/policy.pub.pem" "$STATE/injector/agent.pub.pem"
cp "$BIN/egress" "$STATE/egress/egress"
cp "$BIN/injector" "$STATE/injector/injector"
chmod 755 "$STATE/egress/egress" "$STATE/injector/injector"

cleanup() {
  docker rm -f "$EGRESS" "$INJECTOR" >/dev/null 2>&1 || true
  docker ps -aq --filter "label=kodus.cell=$CELL_ID" | xargs -r docker rm -f -v >/dev/null 2>&1 || true
  docker network ls -q --filter "label=kodus.cell=$CELL_ID" | xargs -r docker network rm >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

# The observer image: the static binary, nothing else.
OBS_CTX="$(mktemp -d)"
cp "$BIN/observer" "$OBS_CTX/observer"
printf 'FROM scratch\nCOPY observer /observer\n' >"$OBS_CTX/Dockerfile"
docker build -q -t "$OBSERVER_IMAGE" "$OBS_CTX" >/dev/null
rm -rf "$OBS_CTX"

# The enforcers live on the default bridge (their way out); the cell joins
# the egress to each claim network.
# The mirror's blob cache outlives restarts (it is not under the dirs reset above):
# a layer is pulled from Docker Hub once per cell, not once per claim.
mkdir -p "$STATE/mirror-cache" && chmod 700 "$STATE/mirror-cache"
docker run -d --name "$EGRESS" -p 127.0.0.1:9443:9443 -v "$STATE/egress:/etc/kodus/egress:ro" \
  -v "$STATE/mirror-cache:/var/cache/kodus-mirror" "$HOLDER_IMAGE" \
  /etc/kodus/egress/egress -listen-tls :443 -listen-http :80 -dns-listen :53 -control :9443 \
  -mirror-listen :8080 -upstream-dns "$UPSTREAM_DNS" -transparent=false \
  -mirror-cache-dir /var/cache/kodus-mirror -mirror-cache-max-gb "${MIRROR_CACHE_GB:-20}" >/dev/null
docker run -d --name "$INJECTOR" -p 127.0.0.1:9445:9445 -v "$STATE/injector:/etc/kodus/injector:ro" "$HOLDER_IMAGE" \
  /etc/kodus/injector/injector -listen :8443 -control :9445 >/dev/null

sleep 2
for c in "$EGRESS" "$INJECTOR"; do
  [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] || { echo "$c did not start:" >&2; docker logs "$c" 2>&1 | tail -5 >&2; exit 1; }
done

# Back to the usual umask for the cell: the rootless builder (uid 1000)
# reads the checkout the cell extracts, and writes the image it builds.
umask 022

# The cell's TLS to the hub renews cell.pem in place: it works on its copy.
exec_cell=("$BIN/cell" -driver docker-gvisor -dev -hub-url "$HUB_URL" -git-api "$GIT_API" -regions local
  -cert "$P/cell.pem" -key "$P/cell.key" -ca "$P/ca.pem" -issuer "$P/ca.pem"
  -workdir "$STATE/work" -metrics-addr 127.0.0.1:9466
  -observer http -observer-cert "$P/cell.pem" -observer-key "$P/cell.key" -observer-ca "$P/ca.pem" -observer-server-name kodus-observer
  -egress-control "egress=https://127.0.0.1:9443,resolver=https://127.0.0.1:9443,injector=https://127.0.0.1:9445"
  -policy-key "$P/policy.key.pem" -egress-allow "$EGRESS_ALLOW"
  -gvisor-holder-image "$HOLDER_IMAGE" -gvisor-builder-image "$BUILDER_IMAGE" -gvisor-egress-container "$EGRESS"
  -gvisor-mirror-goproxy "http://mirror.cell.internal:8080/go,off"
  -gvisor-mirror-registry "mirror.cell.internal:8080" ${MEM_LIMIT:+-gvisor-mem-limit "$MEM_LIMIT"} ${MEM_MAX:+-gvisor-mem-max "$MEM_MAX"} ${CPUS_MAX:+-gvisor-cpus-max "$CPUS_MAX"} ${BUILD_STATE:+-gvisor-build-state} ${BUILD_STATE_KEEP:+-gvisor-build-state-keep "$BUILD_STATE_KEEP"}
  -gvisor-observer-image "$OBSERVER_IMAGE" -gvisor-observer-tls-dir "$STATE/observer-tls"
  ${BROWSER_IMAGE:+-gvisor-browser-image "$BROWSER_IMAGE"})
"${exec_cell[@]}" &
CELL=$!
trap 'kill "$CELL" 2>/dev/null; wait "$CELL" 2>/dev/null; cleanup' EXIT INT TERM
wait "$CELL"
