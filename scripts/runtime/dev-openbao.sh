#!/usr/bin/env bash
# Dev material for the Runtime's OpenBao (docker-compose.dev.yml, profile
# runtime-secrets). Writes into a gitignored directory, never prints a value:
#   tls.pem / tls.key          OpenBao's server certificate (runtime-openbao,
#                              localhost, 127.0.0.1), signed by the dev CA of
#                              scripts/runtime/dev-ca.sh when it exists
#   ca.pem                     the CA the API and the injector trust for it
#   unseal.key                 the 32-byte static auto-unseal key
#   api-role-id/-secret-id     the API's AppRole (writes, never reads)
#   injector-role-id/-secret-id  the injector's AppRole (reads only)
#   pg-password / pgpass       the openbao Postgres role's password, and the
#                              PGPASSFILE OpenBao reads it from
#   api.env                    what the API needs (paths as the container sees them)
# The files stay 0600 on the host; the container reads them as the host user
# (RUNTIME_OPENBAO_UID, the compose service's user).
# Usage: scripts/runtime/dev-openbao.sh [out-dir]
set -euo pipefail
OUT="${1:-${RUNTIME_CERTS_DIR:-.runtime-certs}}/openbao"
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
mkdir -p "$OUT"
chmod 700 "$OUT"
umask 077
cd "$OUT"

if [[ -f ../ca.pem && -f ../ca.key ]]; then
  cp ../ca.pem ca.pem
  CA_CERT=../ca.pem CA_KEY=../ca.key
else
  if [[ ! -f own-ca.pem ]]; then
    openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out own-ca.key
    openssl req -x509 -new -key own-ca.key -sha256 -days 365 -subj "/O=kodus-runtime/CN=openbao dev CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out own-ca.pem
  fi
  cp own-ca.pem ca.pem
  CA_CERT=own-ca.pem CA_KEY=own-ca.key
fi

openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out tls.key
openssl req -new -key tls.key -subj "/O=kodus-runtime/OU=openbao/CN=runtime-openbao" -out tls.csr
printf '%s\n' "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:runtime-openbao,DNS:localhost,IP:127.0.0.1" >tls.ext
openssl x509 -req -in tls.csr -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial -sha256 -days 30 -extfile tls.ext -out tls.pem 2>/dev/null
rm -f tls.csr tls.ext ./*.srl ../*.srl

# Generated once: storage encrypted under the key, and AppRole ids set at the
# first start, must survive a rerun of this script.
[[ -f unseal.key ]] || openssl rand -out unseal.key 32
for f in api-role-id api-secret-id injector-role-id injector-secret-id pg-password; do
  # No trailing newline: OpenBao's self-init reads the file as is.
  [[ -f $f ]] || openssl rand -hex 24 | tr -d '\n' >"$f"
done
# OpenBao's Postgres client (pgx) reads the password from PGPASSFILE.
printf 'db_postgres:5432:kodus_openbao:openbao:%s\n' "$(cat pg-password)" >pgpass
chmod 600 ./*

cat >api.env <<ENV
RUNTIME_OPENBAO_ADDR=https://runtime-openbao:8200
RUNTIME_OPENBAO_MOUNT=runtime-kv
RUNTIME_OPENBAO_CA_FILE=/certs/openbao/ca.pem
RUNTIME_OPENBAO_ROLE_ID_FILE=/certs/openbao/api-role-id
RUNTIME_OPENBAO_SECRET_ID_FILE=/certs/openbao/api-secret-id
ENV
echo "OpenBao dev material written to $(pwd); values were not printed"
