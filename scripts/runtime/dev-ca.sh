#!/usr/bin/env bash
# Dev CA for the Kody Runtime (ADR-054). Writes into a gitignored directory:
#   ca.pem / ca.key           the hub's internal CA (P-256)
#   hub.pem / hub.key         hub server certificate (localhost, 127.0.0.1)
#   cell.pem / cell.key       managed cell client certificate (CN = cell id, OU = cell)
#   worker.pem / worker.key   runtime-worker client certificate (OU = worker)
#   fleet.pem / fleet.key     runtime-fleet client certificate (OU = worker, CN = runtime-fleet,
#                             which the hub admits on its fleet routes only: RUNTIME_FLEET_ALLOWED_CNS)
#   fleet.env                 the fleet container's client certificate over container.env's
#   hub.env                   env for the hub (paths + the cell's pinned serial)
#   preview-tunnel.pem/.key   the preview edge's tunnel certificate (cells dial it with mTLS)
#   preview-browser.pem/.key  a self-signed wildcard for *.$PREVIEW_DOMAIN (the browser listener)
#   preview-grant.key/.pub    the Ed25519 pair the API signs preview grants with and the edge checks
#   preview.env               env for the dev preview edge (docker compose --profile preview)
# Keys are written 0600 and never printed.
#   container.env             the same for the hub and worker containers of
#                             docker-compose.dev.yml (certificates under /certs)
# Usage: scripts/runtime/dev-ca.sh [out-dir] [cell-id]
# RUNTIME_HUB_SANS adds names to the hub certificate (default: runtime-hub,
# the service name the dev compose worker dials).
set -euo pipefail
HUB_SANS="DNS:localhost,IP:127.0.0.1"
for n in ${RUNTIME_HUB_SANS:-runtime-hub}; do HUB_SANS="$HUB_SANS,DNS:$n"; done
OUT="${1:-.runtime-certs}"
PREVIEW_DOMAIN="${RUNTIME_PREVIEW_DOMAIN:-kodus-preview.localhost}"
CELL_ID="${2:-cell-dev-1}"
DAYS_LEAF=1   # short-lived, like the certificates the hub issues
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
mkdir -p "$OUT"
chmod 700 "$OUT"
umask 077
cd "$OUT"

key() { openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out "$1"; }

if [[ ! -f ca.pem ]]; then
  key ca.key
  openssl req -x509 -new -key ca.key -sha256 -days 365 -subj "/O=kodus-runtime/CN=kody-runtime dev CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.pem
fi

leaf() { # name subject days extfile-content
  local n="$1" subj="$2" days="$3" ext="$4"
  key "$n.key"
  openssl req -new -key "$n.key" -subj "$subj" -out "$n.csr"
  printf '%s\n' "$ext" >"$n.ext"
  openssl x509 -req -in "$n.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -sha256 -days "$days" -extfile "$n.ext" -out "$n.pem" 2>/dev/null
  rm -f "$n.csr" "$n.ext"
}

leaf hub "/O=kodus-runtime/OU=hub/CN=localhost" 30 \
  "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=$HUB_SANS"
leaf cell "/O=kodus-runtime/OU=cell/CN=$CELL_ID" "$DAYS_LEAF" \
  "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth"
leaf worker "/O=kodus-runtime/OU=worker/CN=runtime-worker" 30 \
  "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth"
leaf fleet "/O=kodus-runtime/OU=worker/CN=runtime-fleet" 30 \
  "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth"
leaf preview-tunnel "/O=kodus-runtime/OU=edge/CN=runtime-preview-edge" 30 \
  "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:runtime-preview-edge,DNS:localhost,IP:127.0.0.1"
# The browser side: self-signed for local use only (a real deployment uses its wildcard certificate).
key preview-browser.key
openssl req -x509 -new -key preview-browser.key -sha256 -days 30 -subj "/O=kodus-runtime/CN=*.$PREVIEW_DOMAIN" \
  -addext "subjectAltName=DNS:*.$PREVIEW_DOMAIN,DNS:$PREVIEW_DOMAIN" -addext "extendedKeyUsage=serverAuth" -out preview-browser.pem
if [[ ! -f preview-grant.key ]]; then
  openssl genpkey -algorithm ed25519 -out preview-grant.key
  openssl pkey -in preview-grant.key -pubout -out preview-grant.pub
fi
rm -f ca.srl
chmod 600 ./*.key
printf '%s\n' "$CELL_ID" >cell-id

SERIAL="$(openssl x509 -in cell.pem -noout -serial | cut -d= -f2)"
DIR="$(pwd)"
cat >hub.env <<ENV
RUNTIME_TLS_CA=$DIR/ca.pem
RUNTIME_TLS_CA_KEY=$DIR/ca.key
RUNTIME_TLS_CERT=$DIR/hub.pem
RUNTIME_TLS_KEY=$DIR/hub.key
RUNTIME_WORKER_TLS_CERT=$DIR/worker.pem
RUNTIME_WORKER_TLS_KEY=$DIR/worker.key
RUNTIME_MANAGED_CELLS={"$CELL_ID":"$SERIAL"}
ENV
# Sourced by sh in the containers: the JSON value is single-quoted.
sed -e "s|$DIR|/certs|" -e "s|^\(RUNTIME_MANAGED_CELLS=\)\(.*\)$|\1'\2'|" hub.env >container.env
# runtime-fleet reads its client certificate from the worker's variables (shared/config.ts loadFleetConfig).
cat >fleet.env <<ENV
RUNTIME_WORKER_TLS_CERT=/certs/fleet.pem
RUNTIME_WORKER_TLS_KEY=/certs/fleet.key
ENV
cat >preview.env <<ENV
RUNTIME_PREVIEW_DOMAIN=$PREVIEW_DOMAIN
RUNTIME_PREVIEW_TLS_CERT=/certs/preview-browser.pem
RUNTIME_PREVIEW_TLS_KEY=/certs/preview-browser.key
RUNTIME_PREVIEW_TUNNEL_TLS_CERT=/certs/preview-tunnel.pem
RUNTIME_PREVIEW_TUNNEL_TLS_KEY=/certs/preview-tunnel.key
RUNTIME_PREVIEW_GRANT_PUBLIC_KEY=$(base64 <preview-grant.pub | tr -d '\n')
ENV
echo "dev CA written to $DIR (cell $CELL_ID); keys are 0600 and were not printed"
