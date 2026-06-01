# SSO E2E — Agent / Developer Guide

Read this **before** modifying anything in `scripts/sso-e2e/` or
`docker/sso-e2e/`. This setup exists for one specific purpose and has
non-obvious failure modes that are easy to re-introduce.

## Why this exists

The SSO cookie-domain regression (Dmitry's `*.web.scorpion.co` bug) is
guarded at three layers:

1. **Unit tests** — `apps/api/src/utils/__tests__/derive-sso-cookie-domain.spec.ts` (16 cases)
2. **Integration tests** — `apps/api/src/controllers/__tests__/auth.controller.sso-cookie.spec.ts` (12 cases)
3. **This E2E setup** — full SAML round-trip in a real browser, validating
   the cookie domain exits the API correctly *and* the browser stores it.

Layers 1+2 are CI-cheap; this one is opt-in (requires mkcert + sudo)
and is meant for manual confirmation when the SSO flow is touched.

## When to invoke this setup

Run `./scripts/sso-e2e/test-all.sh --e2e` (or `./scripts/sso-e2e/run.sh`
directly) when:

- Modifying `auth.controller.ts` SSO callback path
- Modifying `derive-sso-cookie-domain.ts` (logic or signature)
- Modifying `apps/web/src/app/(auth)/sso-callback/page.tsx`
- Modifying `libs/ee/sso/strategies/saml-auth.strategy.ts`
- Bumping `passport-saml`, `next-auth`, `@nestjs/passport`

Do **not** invoke this setup as part of CI — it requires sudo for
mkcert, manual browser interaction, and ~5min wall time.

## When NOT to invoke

- Routine regression checks → `./scripts/sso-e2e/test-all.sh` (no `--e2e`)
  covers cloud + self-hosted shapes via prod-image smoke and
  unit/integration tests in ~10s.
- Anything that doesn't touch SSO callback / cookie / handoff.

## Two test shapes — what they prove

| Shape | Hosts | Cookie domain | Real-world analog |
|---|---|---|---|
| `kodus.lvh.me` (default) | `api.kodus.lvh.me` ↔ `app.kodus.lvh.me` | `.kodus.lvh.me` | SaaS (`.kodus.io`) — 3-label common parent |
| `web.scorpion.lvh.me` | `api.web.scorpion.lvh.me` ↔ `app.web.scorpion.lvh.me` | `.web.scorpion.lvh.me` | Dmitry self-hosted (`.web.scorpion.co`) — 4-label common parent |

Switch via `SSO_E2E_DOMAIN=<shape> ./scripts/sso-e2e/run.sh`.
The mkcert wildcard cert covers both shapes in one SAN list, and Caddy
serves both name patterns from the same TLS material.

## Non-obvious behaviours — read these before debugging

### `secure: true` cookie + http drops silently

If you see `Set-Cookie` in the API response but
`document.cookie` in the browser is empty, you're hitting an http URL
in production-mode. The `Secure` flag tells Chrome to drop on receive.
This stack uses Caddy + mkcert exactly to avoid this. If you build a
variant without TLS, instrument the controller with a `console.log`
(see "Method A" in README) instead of trying to read the cookie.

### Keycloak session sticks across user-switches

Logging out of Kodus does not log out of Keycloak. If the next user
clicks "Continue with SSO" and Keycloak sees a live session, it
auto-asserts the previous user's identity — not what was typed. This
manifests as "I'm logged in as the wrong user". Fix:

```sh
TOKEN=$(curl -sf -X POST http://localhost:8080/realms/master/protocol/openid-connect/token \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=admin&password=admin&grant_type=password&client_id=admin-cli" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'],end='')")
curl -s -X POST "http://localhost:8080/admin/realms/kodus-sso-e2e/logout-all" \
    -H "Authorization: Bearer $TOKEN"
```

Or revoke the realm volume entirely: `docker compose down -v`.

### Web container needs `NODE_EXTRA_CA_CERTS`

Server Components in `apps/web` make server-side fetches to
`https://api.kodus.lvh.me` during SSR. Node's TLS stack rejects
mkcert's self-signed CA by default. The compose mounts the host's
mkcert root via `MKCERT_CAROOT_HOST` and points
`NODE_EXTRA_CA_CERTS` at it. If you forget this, `/setup` and other
RSC pages return "Network error while requesting…" with no obvious
cause.

### Caddy network alias does double duty

`api.kodus.lvh.me` resolves to `127.0.0.1` from the host (browser path)
and to the Caddy container IP from inside the docker network (SSR
path, container-to-container). The compose `aliases` list under
`caddy.networks` makes the latter work. Without it, the Web container
tries `api.kodus.lvh.me` → resolves to its own loopback → ECONNREFUSED.

### `active=false` keeps the front-end "Continue with SSO" button hidden

The front-end gate is:
```ts
if (ssoResponse?.active && ssoResponse.organizationId) setStep("sso-choice");
```
The bootstrap script seeds `active: false` because the API rejects
`active: true` without a successful connection-test session. To
demonstrate the user-facing button you have two choices:

- Bypass the gate by navigating to `/auth/sso/login/<orgId>` directly
  (`run.sh` instructions do this — exercises the same code path).
- Patch the DB directly (`UPDATE sso_config SET active = true`) only
  for demo runs that need the front-end button visible.

Both are documented bypasses, **not bugs**. Don't "fix" the gate to
allow `active: true` without a test session — that's a deliberate
production safeguard.

## Bypass cheat-sheet (when and why)

These shortcuts trade strictness for demo speed. They are only OK
in this E2E setup, **never** in real test code or production paths.

| Bypass | Why it's needed | Where it's documented |
|---|---|---|
| Domain verification via SQL `UPDATE sso_config SET domain_verification = …` | No SMTP; can't receive verification email | `README.md` "Verification" |
| `active=true` via SQL | Production gate requires connection-test session that's tedious to fully replay | This file ↑ |
| Logout-all via Keycloak admin REST | Per-user logout doesn't terminate session in test realm | This file ↑ |
| `console.log` in `auth.controller.ts` for one run | `Set-Cookie` header is filtered by Playwright network panel | `README.md` "Method A" |

When applying any of these, leave a brief comment so the next person
knows it's intentional. Always revert before commit.

## Common failure modes when modifying

- **"Invalid redirect uri" from Keycloak** → ACS URL in SAMLRequest
  doesn't match the redirectUri registered on the SAML client. Check
  `API_URL` env on the API container — `buildApiUrl` uses it to
  assemble the ACS in `libs/ee/sso/strategies/saml-auth.strategy.ts`.
  Re-run `bootstrap-keycloak.sh` to update the client.
- **"client_not_found / Cannot_match_source_hash"** → SP issuer
  (`saml-auth.strategy.ts: issuer || 'kodus-orchestrator'`) doesn't
  match Keycloak `clientId`. Both must be `kodus-orchestrator`.
- **Cookie domain shows `undefined` instead of `.kodus.lvh.me`** →
  `req.get('host')` is missing the port-stripped public host. Check
  Caddy's `header_up Host {host}` is preserved, or that
  `req.get('host')?.split(':')[0]` runs before passing to
  `deriveSsoCookieDomain`.

## Adding a third shape

The `SSO_E2E_DOMAIN` parameterization is shallow on purpose — only
the Caddyfile, the network aliases in `docker-compose.yml`, and the
mkcert SAN list are hardcoded for the two existing shapes. Adding a
third (e.g. `internal.acme.local`) requires:

1. Append the wildcard to `mkcert -cert-file …` invocation in `run.sh`.
2. Append the host pattern to the Caddy `app.X:443, app.Y:443 { … }`
   line in `Caddyfile`.
3. Append the alias to `caddy.networks.kodus-backend-services.aliases`
   in `docker-compose.yml`.

If you find yourself doing this often, consider promoting
`SSO_E2E_DOMAIN` to a list and templating these three places.

## Commit hygiene

- Never commit `.tmp/sso-e2e-*.{env,json,txt}` or
  `.tmp/sso-e2e-tls/*` — gitignored, regenerated per run.
- Never commit `apps/web/.env.production` — that's the Bug 1
  negative-test artifact, must always be regenerated.
- Never leave instrumentation `console.log` in `auth.controller.ts`.
- The bypass SQL patches above are only for runtime demos — do not
  commit them as scripts.
