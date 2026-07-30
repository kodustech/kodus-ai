#!/usr/bin/env bash
# End-to-end orchestrator for the SSO cookie-domain regression test.
#
# Boots the SSO E2E stack (Keycloak + API + Web prod images), configures
# Keycloak as a SAML IdP, configures Kodus to consume that IdP, then
# prints the manual verification steps.
#
# Prerequisites:
#   1. The dev stack must already be running (postgres, mongo, rabbit):
#        pnpm run docker:start
#   2. The prod images of API + Web must be built:
#        WEB_TAGS=kodus-web:sso-e2e RELEASE_VERSION=sso-e2e \
#          docker buildx bake -f docker-bake.hcl web
#        API_TAGS=kodus-api:sso-e2e API_CLOUD_MODE=false \
#          docker buildx bake -f docker-bake.hcl api
#
# After this script returns, follow the printed manual steps to assert
# `Set-Cookie: sso_handoff=...; Domain=.kodus.lvh.me` in the browser
# DevTools network panel.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="${REPO_ROOT}/docker/sso-e2e/docker-compose.yml"

export SSO_E2E_API_IMAGE="${SSO_E2E_API_IMAGE:-kodus-api:sso-e2e}"
export SSO_E2E_WEB_IMAGE="${SSO_E2E_WEB_IMAGE:-kodus-web:sso-e2e}"
# Web container's NODE_EXTRA_CA_CERTS volume — points at the host's
# mkcert CA root so server-side fetches to https://api.kodus.lvh.me
# succeed in production-mode.
export MKCERT_CAROOT_HOST="$(mkcert -CAROOT 2>/dev/null || true)"

cd "${REPO_ROOT}"

echo "════════════════════════════════════════════════════════════════"
echo " SSO E2E — Cookie domain regression test"
echo "════════════════════════════════════════════════════════════════"

# 0. Sanity: are the prod images built?
for img in "${SSO_E2E_API_IMAGE}" "${SSO_E2E_WEB_IMAGE}"; do
    if ! docker image inspect "${img}" >/dev/null 2>&1; then
        cat >&2 <<EOF
error: image "${img}" not found.

Build it first:
    WEB_TAGS=kodus-web:sso-e2e RELEASE_VERSION=sso-e2e \\
        docker buildx bake -f docker-bake.hcl web
    API_TAGS=kodus-api:sso-e2e API_CLOUD_MODE=false \\
        docker buildx bake -f docker-bake.hcl api
EOF
        exit 1
    fi
done

# 0.1 Sanity: are postgres/mongo/rabbit up?
for c in db_postgres mongodb rabbitmq; do
    if ! docker ps --format '{{.Names}}' | grep -q "^${c}$"; then
        echo "error: container ${c} is not running. Start the dev stack first: pnpm run docker:start" >&2
        exit 1
    fi
done

# 0.2 Sanity: mkcert installed + wildcard cert generated
if ! command -v mkcert >/dev/null 2>&1; then
    echo "error: mkcert is not installed. Install with \`brew install mkcert\` and run \`sudo mkcert -install\`." >&2
    exit 1
fi
TLS_DIR="${REPO_ROOT}/.tmp/sso-e2e-tls"
if [ ! -f "${TLS_DIR}/kodus.lvh.me.crt" ] || [ ! -f "${TLS_DIR}/kodus.lvh.me.key" ]; then
    echo "==> [0/5] generating mkcert wildcard cert (covers both test shapes)"
    mkdir -p "${TLS_DIR}"
    (cd "${TLS_DIR}" && mkcert \
        -cert-file kodus.lvh.me.crt -key-file kodus.lvh.me.key \
        '*.kodus.lvh.me' 'kodus.lvh.me' \
        '*.web.scorpion.lvh.me' 'web.scorpion.lvh.me' >/dev/null)
fi
# Verify the CA is actually in the system trust store (mkcert -install
# was run). Without it, the browser refuses the cert and cookies
# travel over an "untrusted" channel which Chrome flags but still
# accepts — confusing failure mode, better to call it out up front.
if ! mkcert -CAROOT >/dev/null 2>&1 || ! security find-certificate -c "mkcert" >/dev/null 2>&1; then
    cat >&2 <<EOF
warning: the mkcert local CA does not appear to be in the system trust
store. Browsers will show "Not secure" and may refuse to store cookies.
Run once on this machine:

    sudo mkcert -install

Continuing anyway — if SSO handoff fails with an HTTPS warning, this is
why.
EOF
fi

# 1. Sanitize .env for use as docker --env-file
echo
echo "==> [1/5] preparing API env file"
bash "${HERE}/prepare-env.sh"

# 2. Boot the SSO stack
echo
echo "==> [2/5] starting Keycloak + API + Web (prod images)"
docker compose -f "${COMPOSE}" up -d
echo "    waiting for services to be ready"
CAROOT="${MKCERT_CAROOT:-$(mkcert -CAROOT 2>/dev/null || true)}"
CURL_HEALTH=(curl -s -o /dev/null)
if [ -n "${CAROOT}" ] && [ -f "${CAROOT}/rootCA.pem" ]; then
    CURL_HEALTH+=(--cacert "${CAROOT}/rootCA.pem")
fi
for i in $(seq 1 60); do
    api_status=$("${CURL_HEALTH[@]}" -w "%{http_code}" "https://api.${SSO_E2E_DOMAIN:-kodus.lvh.me}/health" || true)
    web_status=$("${CURL_HEALTH[@]}" -w "%{http_code}" "https://app.${SSO_E2E_DOMAIN:-kodus.lvh.me}/sign-in" || true)
    kc_status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/realms/master" || true)
    if [ "${api_status}" = "200" ] && [ "${web_status}" = "200" ] && [ "${kc_status}" = "200" ]; then
        echo "    api=${api_status}  web=${web_status}  keycloak=${kc_status}  OK"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "error: services did not come up in 120s (api=${api_status} web=${web_status} kc=${kc_status})" >&2
        exit 1
    fi
    sleep 2
done

# 3. Bootstrap Keycloak (first pass — uses wildcard ACS, will be re-run)
echo
echo "==> [3/5] bootstrap Keycloak (first pass)"
bash "${HERE}/bootstrap-keycloak.sh"

# 4. Bootstrap Kodus (signup + cadastrar SSO + emit orgId)
echo
echo "==> [4/5] bootstrap Kodus tenant + SSO config"
bash "${HERE}/bootstrap-kodus.sh"

# 5. Re-bootstrap Keycloak so the SAML client's ACS URL points at the
#    actual orgId (instead of the placeholder "*").
echo
echo "==> [5/5] bootstrap Keycloak (second pass — bind ACS to orgId)"
bash "${HERE}/bootstrap-keycloak.sh"

ORG_ID="$(cat "${REPO_ROOT}/.tmp/sso-e2e-org-id.txt")"

cat <<EOF

════════════════════════════════════════════════════════════════
 Stack ready. Run the SAML flow:
════════════════════════════════════════════════════════════════

  1. Open  https://api.${SSO_E2E_DOMAIN:-kodus.lvh.me}/auth/sso/login/${ORG_ID}
     (direct call to the API — bypasses the front-end "active"
      gate, which would otherwise refuse to redirect because the
      seeded SSO config has active=false. The cookie-domain code
      path on the callback is the same either way.)

  2. On the Keycloak login form:
        username  sso-user@kodus-test.com
        password  TestSso!2026

  3. After Keycloak posts back, you should land on
     https://app.${SSO_E2E_DOMAIN:-kodus.lvh.me}/sso-callback and then be signed in
     (the page consumes \`sso_handoff\`, exchanges it for the
      session, then redirects into the app).

  4. Open Chrome DevTools → Application → Cookies →
     https://app.${SSO_E2E_DOMAIN:-kodus.lvh.me}. You should see:

        Name     sso_handoff (briefly — 15s lifetime, then gone)
        Domain   .${SSO_E2E_DOMAIN:-kodus.lvh.me}
        Path     /
        Secure   ✓
        SameSite Lax

     The \`Domain=.${SSO_E2E_DOMAIN:-kodus.lvh.me}\` line is the proof: it's the
     smallest common DNS suffix between api.${SSO_E2E_DOMAIN:-kodus.lvh.me} and
     app.${SSO_E2E_DOMAIN:-kodus.lvh.me}, computed at request-time — exactly what
     the Dmitry deployment needed and the old hard-coded
     \`.kodus.io\` could never produce.

  Teardown:    docker compose -f ${COMPOSE} down -v
  Logs:        docker compose -f ${COMPOSE} logs -f kodus-api
EOF
