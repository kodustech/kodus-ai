# SSO E2E droplet — Caddy reverse proxy with Caddy's INTERNAL CA (no ACME).
#
# Templated by scripts/sso-e2e/droplet/provision.sh (only ${BASE} is
# substituted with the droplet's sslip.io suffix, e.g. "1.2.3.4.sslip.io").
#
# Used instead of Caddyfile.tpl whenever SSO_E2E_TLS_MODE=internal (the
# default). Rationale: `sslip.io` is a SINGLE globally-shared registered
# domain, so it chronically exhausts Let's Encrypt's per-registered-domain
# certificate rate limit — issuance fails with
#   HTTP 429 "too many certificates (250000) already issued for sslip.io"
# which leaves kc.<IP>.sslip.io with no usable cert, the TLS handshake
# fails outright (tlsv1 alert internal error), and the Keycloak bootstrap
# poll times out. `tls internal` makes Caddy mint a local-CA cert for each
# host instantly — no ACME, no rate limit, deterministic.
#
# The certs are NOT publicly trusted, so:
#   * provision.sh sets IGNORE_TLS=1 → Playwright runs with
#     ignoreHTTPSErrors (the secure SSO handoff cookie is still honoured
#     because the browser treats the connection as HTTPS).
#   * the bootstrap curls already use -k.
# Same 6-label sslip.io host shape as the ACME variant, so the cookie
# Domain that deriveSsoCookieDomain computes — the thing under test — is
# unchanged.

(proxy_common) {
    header_up Host {host}
    header_up X-Forwarded-Proto https
    header_up X-Forwarded-Host {host}
    # Preserve the public host so the API's auth.controller reads the
    # sslip.io hostname (what deriveSsoCookieDomain consumes), not the
    # internal docker hostname.
}

app.${BASE} {
    tls internal
    reverse_proxy kodus-web-prod:3000 {
        import proxy_common
    }
}

api.${BASE} {
    tls internal
    reverse_proxy api:3001 {
        import proxy_common
    }
}

kc.${BASE} {
    tls internal
    reverse_proxy kc-sso-e2e:8080 {
        import proxy_common
    }
}
