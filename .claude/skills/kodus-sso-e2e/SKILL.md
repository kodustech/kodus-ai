---
name: kodus-sso-e2e
description: Use when the user wants to validate the Kodus SSO flow end-to-end (cookie-domain regression for self-hosted, Bug 1 force-dynamic, SAML round-trip via Keycloak), confirm the SSO test still passes after changes, or regression-check before merging code that touches `auth.controller.ts`, `derive-sso-cookie-domain.ts`, `apps/web/src/app/(auth)/sso-callback/page.tsx`, or `libs/ee/sso/`. Also triggers on phrases like "test SSO", "validate SSO", "SSO regression", "rodar teste de SSO", "verificar SSO", "SSO selfhosted vs cloud".
---

# Kodus SSO E2E Test

## Overview

Drives the full SSO regression suite: 28 unit/integration tests + 2-shape
prod-image runtime smoke (cloud + self-hosted) + optional browser SAML
round-trip via Keycloak + Caddy + mkcert. Reports back which layers passed
and which failed, with the exact failure surface.

## When to use

- User asks to validate SSO is still working after code changes.
- User wants confidence that both SaaS deployments (`*.kodus.io`) and
  self-hosted deployments (`*.web.scorpion.co`-style) still authenticate.
- Pre-merge / pre-release sanity check on changes that touch the SSO
  callback path, cookie domain derivation, or the `/sso-callback` page.
- After bumping `passport-saml`, `next-auth`, `@nestjs/passport`.

## When NOT to use

- Routine "is the test green" question → run only the test layer (no
  Docker, no browser): just `yarn test apps/api/src/utils/__tests__/derive-sso-cookie-domain.spec.ts apps/api/src/controllers/__tests__/auth.controller.sso-cookie.spec.ts`.
- The user is asking about SSO **architecture** or **code review** —
  this skill executes tests, it doesn't analyse code.
- CI: this skill needs sudo for mkcert and (optionally) a browser. Not
  CI-shaped.

## Workflow

### 1) Decide the test depth

Start by asking the user (or inferring from context) which layer is
needed:

- **Quick** (default): unit + integration tests + 2-shape prod-image smoke.
  ~10s. Catches algorithm regressions, force-dynamic regressions,
  cloud/self-hosted env-injection regressions.
- **Full**: also runs the browser SAML round-trip (Keycloak + Caddy +
  Playwright). ~5min. Catches integration regressions (TLS, cookie
  storage in browser, /sso-callback page consuming the cookie).

If unsure, default to Quick. Offer Full as follow-up.

### 2) Pre-flight checks (only relevant for Full)

Verify before invoking the browser layer; bail with a clear message
if anything is missing rather than failing mid-run:

```sh
# Dev backing services up?
docker ps --format '{{.Names}}' | grep -qE '^(db_postgres|mongodb|rabbitmq)$' \
    || echo "ERROR: run 'yarn docker:start' first"

# Production images of API + Web built?
docker image inspect kodus-api:sso-e2e >/dev/null 2>&1 \
    || echo "ERROR: build with 'API_TAGS=kodus-api:sso-e2e API_CLOUD_MODE=false docker buildx bake -f docker-bake.hcl api'"
docker image inspect kodus-web:sso-e2e >/dev/null 2>&1 \
    || echo "ERROR: build with 'WEB_TAGS=kodus-web:sso-e2e RELEASE_VERSION=sso-e2e docker buildx bake -f docker-bake.hcl web'"

# mkcert installed and CA trusted?
mkcert -CAROOT >/dev/null 2>&1 \
    || echo "ERROR: install with 'brew install mkcert && sudo mkcert -install'"
security find-certificate -c "mkcert" >/dev/null 2>&1 \
    || echo "WARN: mkcert CA not in system trust — browsers may reject. Run 'sudo mkcert -install'"
```

If sudo is needed, **do not try to run it**. Tell the user to run it
themselves (`! sudo mkcert -install` in Claude Code, or in a regular
terminal). Resume after they confirm.

### 3) Quick path

```sh
./scripts/sso-e2e/test-all.sh
```

Expected output ends with:

```
═══════════════════════════════════════════════════════════
 All SSO regression layers passed
═══════════════════════════════════════════════════════════
  Layer 1: unit + integration tests           28 cases
  Layer 2: kodus-web:test image               built
  Layer 3: runtime smoke (cloud + self-hosted) 2 shapes
```

If layer 3 fails on cloud shape: `force-dynamic` regression.
If layer 3 fails on self-hosted shape: `force-dynamic` is NOT in
`apps/web/src/app/layout.tsx` → restore it.

### 4) Full path

```sh
./scripts/sso-e2e/test-all.sh --e2e
```

This delegates to `scripts/sso-e2e/run.sh`, which boots the SSO stack
(Keycloak + Caddy + API + Web prod images), seeds the SAML IdP via
admin REST API, and prints the manual SAML round-trip steps.

### 5) Drive the browser round-trip via Playwright (when --e2e)

If a Playwright MCP is available in the session, drive the flow
yourself:

1. `browser_navigate https://api.${SSO_E2E_DOMAIN:-kodus.lvh.me}/auth/sso/login/$(cat .tmp/sso-e2e-org-id.txt)`
2. Fill Keycloak login form: `sso-user@kodus-test.com` / `TestSso!2026`
3. After Keycloak posts the SAML assertion back, the browser should
   land on `https://app.${SSO_E2E_DOMAIN:-kodus.lvh.me}/setup` (or
   similar authenticated route). Confirm via `page.url()`.

To **prove the cookie domain was computed correctly**, two options
(`Set-Cookie` is filtered by Playwright's network panel for privacy):

- **Method A (recommended, no code changes)**: read API logs after
  the SAML round-trip:
  ```sh
  docker logs kodus-sso-e2e-api 2>&1 | grep '\[SSO_E2E\]' | tail -1
  ```
  This works only if the controller has the temporary instrumentation
  log. It's not committed; if absent, fall back to Method B.
- **Method B (verify implicitly)**: confirm `/setup` rendered
  authenticated — that proves the cookie was both emitted and stored
  by the browser, which means `Domain=` was correct.

### 6) Multi-shape coverage (only when explicitly requested)

The default shape is `kodus.lvh.me` (3-label common parent — analog
of cloud `.kodus.io`). To also exercise the Dmitry shape (4-label
common parent — analog of `.web.scorpion.co`):

```sh
SSO_E2E_DOMAIN=web.scorpion.lvh.me ./scripts/sso-e2e/run.sh
```

Same mkcert wildcard cert covers both shapes; same Caddy; same
upstream containers — just different URLs. Both should produce the
expected smallest-common-DNS-suffix cookie domain.

### 7) Multi-user scenarios (only when explicitly requested)

The seeded user `sso-user@kodus-test.com` covers the happy path. To
also exercise the failure-mode users:

- **Auto-signup user** (Keycloak only): create a Keycloak user that
  does not exist in the Kodus DB. SSO callback triggers
  `signUpUseCase.execute()` → user created with `status=pending` →
  front-end redirects to `/confirm-email`.
- **Removed user**: insert a user in the Kodus DB with
  `status='removed'`. Keycloak login succeeds, SAML callback emits
  tokens, but the JWT auth strategy rejects subsequent requests.
  Front-end redirects to `/sign-in?reason=removed`.

These are mostly only relevant when the user asks "does it correctly
reject a deactivated user via SSO?". Don't run them by default.

### 8) Report the result

Format the final report as:

- **Quick**: which of the 3 layers passed, total time, exact failure
  if any.
- **Full**: same as Quick, plus the cookie-domain value observed in
  API logs (if Method A was used) or the final URL the browser
  landed on (if Method B was used), plus any unexpected console
  errors from `browser_console_messages`.

Always include the **expected vs observed** cookie domain (from
unit/integration tests if Quick; from browser if Full). The match is
the proof.

### 9) Cleanup (only on user request)

```sh
# Containers & Keycloak realm
docker compose -f docker/sso-e2e/docker-compose.yml down -v

# Demo-only images
docker rmi kodus-web:nofix-selfhosted kodus-web:nofix-cloud 2>/dev/null

# Test fixtures (always regenerated on next run)
rm -rf .tmp/sso-e2e-*
```

By default, leave the stack running so the user can poke at it.

## Common failure modes + fixes

Refer to `scripts/sso-e2e/AGENTS.md` for the full troubleshooting
catalogue. The most frequent ones:

- **"Invalid redirect uri" from Keycloak** → ACS URL mismatch. Compare
  the URL in the Keycloak error page with what the controller emits in
  `libs/ee/sso/strategies/saml-auth.strategy.ts` (uses `API_URL` env).
  Re-run `bootstrap-keycloak.sh` to update.
- **"Network error while requesting…" on `/setup`** → Web container
  can't reach API over TLS. Confirm `NODE_EXTRA_CA_CERTS` is mounted
  (compose `kodus-web.volumes` should include the mkcert CAROOT).
- **Cookie not stored in browser** → likely `secure: true` over http.
  This stack uses Caddy + mkcert specifically to avoid that. If you
  see this, something broke the TLS layer.
- **Front-end shows password prompt instead of "Continue with SSO"**
  → `sso_config.active=false`. The bootstrap seeds it as false (the
  API rejects `active: true` without a connection-test session).
  Either bypass the front-end gate by navigating to
  `/auth/sso/login/<orgId>` directly, or run a connection test via the
  admin UI / `UPDATE sso_config SET active = true` for demo purposes.

## Hard rules

- **Never** commit `.tmp/sso-e2e-*` files.
- **Never** commit `apps/web/.env.production` (Bug 1 negative-test artifact).
- **Never** leave instrumentation `console.log` in `auth.controller.ts`
  if you added it for Method A debugging.
- **Never** silently widen the cookie-domain algorithm to permit
  public-suffix scopes (`.io`, `.com`, `.co.uk`). The 2-label minimum
  is a deliberate safeguard.
- **Never** run `mkcert -install` yourself — it requires sudo and
  must be the user's explicit decision.
