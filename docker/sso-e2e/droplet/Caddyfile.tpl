# SSO E2E droplet — Caddy reverse proxy with auto-TLS.
#
# Templated by scripts/sso-e2e/droplet/provision.sh: ${BASE} is replaced
# at deploy time with the sslip.io DNS suffix bound to the droplet's
# public IP (e.g. "159.203.85.6.sslip.io"). That gives us three real
# DNS names (api.<IP>.sslip.io / app.<IP>.sslip.io / kc.<IP>.sslip.io)
# with valid Let's Encrypt certs, no domain ownership required.
#
# Why this matters for the SSO test:
#   * SSO handoff cookie is emitted with `secure: true` — TLS required.
#   * Browser will reject self-signed certs and silently drop the cookie.
#   * `Domain=.<IP>.sslip.io` (6 labels) exercises the longest-common-
#     suffix path that no other shape covers in the unit suite (added
#     in derive-sso-cookie-domain.spec.ts under "sslip.io / 5+ label").
#
# If LE issuance fails (rate limit, ACME outage), provision.sh swaps in
# `Caddyfile.internal.tpl` which falls back to Caddy's local CA + we
# pass `ignoreHTTPSErrors: true` to Playwright. Same DNS shape, just no
# public trust.

{
    email ${CADDY_ACME_EMAIL}
    # Acme staging vs production: provision.sh sets ${CADDY_ACME_CA}
    # to LE production by default, but flipping to staging
    # (https://acme-staging-v02.api.letsencrypt.org/directory) lets us
    # iterate without burning the 50-certs-per-week-per-registered-
    # domain quota (sslip.io is one registered domain shared by all
    # of its users).
    acme_ca ${CADDY_ACME_CA}
}

(proxy_common) {
    header_up Host {host}
    header_up X-Forwarded-Proto https
    header_up X-Forwarded-Host {host}
    # Preserve the public host so `req.get('host')` in the API
    # auth.controller reads the sslip.io hostname (not the internal
    # docker hostname). That value is what deriveSsoCookieDomain
    # consumes to compute the cookie Domain.
}

app.${BASE} {
    reverse_proxy kodus-web-prod:3000 {
        import proxy_common
    }
}

api.${BASE} {
    reverse_proxy api:3001 {
        import proxy_common
    }
}

kc.${BASE} {
    reverse_proxy kc-sso-e2e:8080 {
        import proxy_common
    }
}
