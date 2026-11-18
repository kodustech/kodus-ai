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
# reach: the registry, npm and the Debian, Ubuntu and Alpine package
# mirrors by default), UPSTREAM_DNS (1.1.1.1:53),
# STATE (/var/lib/kodus-cell-dev), HOLDER_IMAGE, BUILDER_IMAGE, MEM_LIMIT (the
# default size), MEM_MAX and CPUS_MAX (the largest size one claim may ask),
# BROWSER_IMAGE (the browser runner, browser-runner/, by digest: browser
# probes run only with it, ADR-071), BUILD_STATE (keep each environment's
# BuildKit state) and BUILD_STATE_KEEP (what its GC keeps, 20GB by default:
# a Go monorepo's module and build caches pass that). A pull request's
# build reads that state through a reflink clone when $STATE/work is on a
# filesystem that has them (XFS, btrfs); on ext4 it reads it through the
# kernel's overlay, where most Node builds fail once and run again cold.
# BUILDER_IMAGE is the cell's own builder by default (builder-image/, the
# digest cmd/cell/config.go pins): the stock rootless BuildKit walks the whole
# tree for every layer it exports under gVisor. A host that cannot pull it from
# GHCR builds it (docker buildx bake runtime-builder) into a registry of its
# own and passes that name with the same digest.
# BUILDER_TRUST=1 says a local build of builder-image/ under another digest
# (an arm64 build of the same revision) is the cell's own builder too, so its
# RUN steps get the cell's trust bundle (-gvisor-builder-trust).
# IMAGE_TRANSFER (the cell's default, registry) is how a build's image reaches
# this Docker: registry pushes it to a registry container of the build's own
# and pulls it by digest, so only the layers that changed move, and a build
# the environment's registry was never seeded for sends a tarball; tarball
# always sends one. REGISTRY_IMAGE is the distribution registry by digest (the
# cell's default otherwise), and REGISTRY_KEEP_GB bounds an environment's
# registry storage (40 by default).
# SANDBOX_IMAGE is the code sandbox's tool image (sandbox-image/, by id or
# digest): without it the cell runs no sandboxes. SANDBOX_POOL is how many
# blank sandboxes it keeps ready (0 by default; they count in the memory
# admission). SANDBOX_MEMORY_MB and SANDBOX_CPUS are the size of a sandbox that
# asks none and of every blank one (2048 MB and 2 CPUs by default; never the
# Run size MEM_LIMIT). OPENBAO_ADDR (https://runtime-openbao:8200) turns on the
# injector's org secrets: OPENBAO_DIR holds ca.pem, injector-role-id and
# injector-secret-id (scripts/runtime/dev-openbao.sh), copied 0600 next to the
# injector; OPENBAO_HOST_IP, when set, is where the address's host name
# resolves from the injector's container (a tunnel bound on this host's
# docker0, when OpenBao runs on another machine). ENFORCERS_SUBNET
# (10.214.0.0/29), EGRESS_ENFORCER_IP (10.214.0.2) and INJECTOR_ENFORCER_IP
# (10.214.0.3) are the internal network the egress reaches the injector on:
# outside the claims' pool (10.213.0.0/16) and this host's other networks.
# The cell takes the injector's CA certificate (-cell-ca-cert, never its key)
# and this host's public roots, and mounts the two into every machine of a
# claim with org secrets, and of every claim when -egress-recommended inspects
# over TLS (internal/machinetrust), so they trust the injector.
# PREVIEW=1 adds -preview: the cell names the preview feature and dials the
# preview edge the hub names (RUNTIME_PREVIEW_TUNNEL_URL), whose tunnel
# certificate must chain to ca.pem (docs/runtime/preview-urls.md §14.6).
set -euo pipefail
CERTS="$(cd "${1:?certs dir}" && pwd)"
BIN="$(cd "${2:?bin dir}" && pwd)"
HUB_URL="${HUB_URL:-wss://host.orb.internal:3410/cells}"
GIT_API="${GIT_API:-http://host.orb.internal:3499}"
# The registries a build installs from: the image registry, npm, and the
# system package mirrors of the usual base images (a Debian or Ubuntu image
# that runs apt-get, an Alpine one that runs apk). Without the mirrors the
# first RUN of most Dockerfiles cannot resolve its package host.
EGRESS_ALLOW="${EGRESS_ALLOW:-registry-1.docker.io,auth.docker.io,production.cloudfront.docker.com,registry.npmjs.org,deb.debian.org,security.debian.org,archive.ubuntu.com,security.ubuntu.com,ports.ubuntu.com,dl-cdn.alpinelinux.org}"
UPSTREAM_DNS="${UPSTREAM_DNS:-1.1.1.1:53}"
STATE="${STATE:-/var/lib/kodus-cell-dev}"
# alpine:3.20 (the multi-arch index) by digest: the holder runs in every claim and the injector, which holds credentials, runs from it.
HOLDER_IMAGE="${HOLDER_IMAGE:-alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc}"
BUILDER_IMAGE="${BUILDER_IMAGE:-ghcr.io/kodustech/kodus-runtime-builder@sha256:07f926354bfd21b8af9526f63924a0ca4e8cf89dfe56527e6dd7ed68ca5d16c1}"
OBSERVER_IMAGE=kodus-dev-observer:local
EGRESS=kodus-dev-egress
INJECTOR=kodus-dev-injector
ENFORCERS=kodus-dev-enforcers
ENFORCERS_SUBNET="${ENFORCERS_SUBNET:-10.214.0.0/29}"
EGRESS_ENFORCER_IP="${EGRESS_ENFORCER_IP:-10.214.0.2}"
INJECTOR_ENFORCER_IP="${INJECTOR_ENFORCER_IP:-10.214.0.3}"
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
INJECTOR_RUN=() INJECTOR_OPENBAO=()
if [ -n "${OPENBAO_ADDR:-}" ]; then
  for f in ca.pem injector-role-id injector-secret-id; do
    cp "${OPENBAO_DIR:?set OPENBAO_DIR}/$f" "$STATE/injector/openbao-$f"
  done
  INJECTOR_OPENBAO=(-openbao-addr "$OPENBAO_ADDR" -openbao-ca /etc/kodus/injector/openbao-ca.pem
    -openbao-role-id-file /etc/kodus/injector/openbao-injector-role-id -openbao-secret-id-file /etc/kodus/injector/openbao-injector-secret-id)
  if [ -n "${OPENBAO_HOST_IP:-}" ]; then
    h="${OPENBAO_ADDR#*://}"; h="${h%%/*}"; h="${h%%:*}"
    INJECTOR_RUN=(--add-host "$h:$OPENBAO_HOST_IP")
  fi
fi

cleanup() {
  docker rm -f "$EGRESS" "$INJECTOR" >/dev/null 2>&1 || true
  docker ps -aq --filter "label=kodus.cell=$CELL_ID" | xargs -r docker rm -f -v >/dev/null 2>&1 || true
  docker network ls -q --filter "label=kodus.cell=$CELL_ID" | xargs -r docker network rm >/dev/null 2>&1 || true
  docker network rm "$ENFORCERS" >/dev/null 2>&1 || true
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
# the egress to each claim network. They also share an internal network of
# their own, with fixed addresses: the egress sends a credentialed host (an
# org secret's) to the injector there (-injector-addr), and the injector
# takes PROXY v1 from that address only (-trusted-proxies) and listens on
# nothing else. Each is created, joined to it, then started, so the address
# exists before the process binds it.
# The mirror's blob cache outlives restarts (it is not under the dirs reset above):
# a layer is pulled from Docker Hub once per cell, not once per claim.
mkdir -p "$STATE/mirror-cache" && chmod 700 "$STATE/mirror-cache"
docker network create --internal --subnet "$ENFORCERS_SUBNET" "$ENFORCERS" >/dev/null
docker create --name "$EGRESS" -p 127.0.0.1:9443:9443 -v "$STATE/egress:/etc/kodus/egress:ro" \
  -v "$STATE/mirror-cache:/var/cache/kodus-mirror" "$HOLDER_IMAGE" \
  /etc/kodus/egress/egress -listen-tls :443 -listen-http :80 -dns-listen :53 -control :9443 \
  -mirror-listen :8080 -upstream-dns "$UPSTREAM_DNS" -transparent=false -injector-addr "$INJECTOR_ENFORCER_IP:8443" \
  -mirror-cache-dir /var/cache/kodus-mirror -mirror-cache-max-gb "${MIRROR_CACHE_GB:-20}" -agent-cn "$CELL_ID" >/dev/null
docker create --name "$INJECTOR" -p 127.0.0.1:9445:9445 -v "$STATE/injector:/etc/kodus/injector:ro" "${INJECTOR_RUN[@]}" "$HOLDER_IMAGE" \
  /etc/kodus/injector/injector -listen "$INJECTOR_ENFORCER_IP:8443" -trusted-proxies "$EGRESS_ENFORCER_IP" -control :9445 \
  -agent-cn "$CELL_ID" "${INJECTOR_OPENBAO[@]}" >/dev/null
docker network connect --ip "$EGRESS_ENFORCER_IP" "$ENFORCERS" "$EGRESS"
docker network connect --ip "$INJECTOR_ENFORCER_IP" "$ENFORCERS" "$INJECTOR"
docker start "$INJECTOR" "$EGRESS" >/dev/null

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
  -policy-key "$P/policy.key.pem" -egress-allow "$EGRESS_ALLOW" -cell-ca-cert "$STATE/injector/cell-ca.pem"
  -gvisor-holder-image "$HOLDER_IMAGE" -gvisor-builder-image "$BUILDER_IMAGE" ${BUILDER_TRUST:+-gvisor-builder-trust} -gvisor-egress-container "$EGRESS"
  -gvisor-mirror-goproxy "http://mirror.cell.internal:8080/go,off"
  -gvisor-mirror-npm "http://mirror.cell.internal:8080/npm/" -gvisor-mirror-pypi "http://mirror.cell.internal:8080/pypi/simple/"
  -gvisor-mirror-registry "mirror.cell.internal:8080" ${MEM_LIMIT:+-gvisor-mem-limit "$MEM_LIMIT"} ${MEM_MAX:+-gvisor-mem-max "$MEM_MAX"} ${CPUS_MAX:+-gvisor-cpus-max "$CPUS_MAX"} ${BUILD_STATE:+-gvisor-build-state} ${BUILD_STATE_KEEP:+-gvisor-build-state-keep "$BUILD_STATE_KEEP"}
  ${IMAGE_TRANSFER:+-gvisor-image-transfer "$IMAGE_TRANSFER"} ${REGISTRY_IMAGE:+-gvisor-registry-image "$REGISTRY_IMAGE"} ${REGISTRY_KEEP_GB:+-gvisor-registry-keep-gb "$REGISTRY_KEEP_GB"}
  -gvisor-observer-image "$OBSERVER_IMAGE" -gvisor-observer-tls-dir "$STATE/observer-tls"
  ${BROWSER_IMAGE:+-gvisor-browser-image "$BROWSER_IMAGE"}
  ${SANDBOX_IMAGE:+-gvisor-sandbox-image "$SANDBOX_IMAGE"} ${SANDBOX_POOL:+-sandbox-pool "$SANDBOX_POOL"}
  ${SANDBOX_MEMORY_MB:+-sandbox-memory-mb "$SANDBOX_MEMORY_MB"} ${SANDBOX_CPUS:+-sandbox-cpus "$SANDBOX_CPUS"}
  ${PREVIEW:+-preview})
"${exec_cell[@]}" &
CELL=$!
trap 'kill "$CELL" 2>/dev/null; wait "$CELL" 2>/dev/null; cleanup' EXIT INT TERM
wait "$CELL"
