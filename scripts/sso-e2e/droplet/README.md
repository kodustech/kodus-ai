# SSO E2E — droplet mode

Real-deployment regression for the SSO handoff-cookie `Domain` attribute.
Provisions a DigitalOcean droplet, layers Caddy (Let's Encrypt) + Keycloak
on top of the standard Kodus self-hosted stack, and drives the full SAML
round-trip with Playwright against the public sslip.io hostnames.

Why this exists alongside the local `scripts/sso-e2e/run.sh`:

- Local mode runs against `*.kodus.lvh.me` (which resolves to 127.0.0.1).
  Browsers happily store cookies on a loopback address, but the **public**
  cert chain, real DNS, and >4-label common-parent shapes are never exercised.
- Droplet mode lights up a 6-label common parent (`.<IP>.sslip.io`) which
  is the deepest production-realistic shape — strictly stricter than the
  3-label `.kodus.io` (SaaS) and 4-label `.web.scorpion.co` (Dmitry) cases.

## What you need before running

Already-required for the existing self-hosted droplet scripts. **No new
secrets**:

| Variable                       | Where it lives             | What it's used for                  |
|--------------------------------|----------------------------|-------------------------------------|
| `DIGITALOCEAN_TOKEN`           | `~/.kodus-dev/config`      | Provision the droplet               |
| `API_OPEN_AI_API_KEY`          | `~/.kodus-dev/config`      | Boot the Kodus API                  |
| `API_OPENAI_FORCE_BASE_URL`    | `~/.kodus-dev/config`      | Moonshot / other proxies (optional) |
| `API_LLM_PROVIDER_MODEL`       | `~/.kodus-dev/config`      | Default Kimi K2.6 (optional)        |
| `KODUS_INSTALLER_PATH`         | env or default `../kodus-installer` | Source for the base compose |

Local tooling:

- Docker (only used by the self-hosted scripts, not for this test).
- Node + npm (Playwright auto-installs Chromium on first `:provision` / `:run`).

## Commands

```sh
# Full happy path: provision + bootstrap + run the test (~7–8 min)
pnpm run sso-e2e:droplet:provision

# Provision only (no Playwright)
pnpm run sso-e2e:droplet:provision --skip-test

# Reuse an existing droplet (skip the 5-min provision)
pnpm run sso-e2e:droplet:provision --reuse

# Re-run Playwright against the already-provisioned droplet
pnpm run sso-e2e:droplet:run                # headless
pnpm run sso-e2e:droplet:run --headed       # visible Chromium

# Tear down (also cleans .tmp/sso-e2e-*)
pnpm run sso-e2e:droplet:destroy
```

## What it asserts

```
Set-Cookie: sso_handoff=<json>; Path=/; Domain=.<IP>.sslip.io; Secure; SameSite=Lax
```

with the matching values on `context.cookies()`. Anything else fails the
test with a clear breadcrumb.

## Failure modes

- **TLS chain not validated** — provision.sh detects this (`IGNORE_TLS=1`)
  and tells Playwright to ignore HTTPS errors. The cookie-domain assertion
  still runs; only the cert trust check is skipped. Caddy may have fallen
  back to its internal CA because of Let's Encrypt rate limits on
  `sslip.io`. Override with `CADDY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory`
  to use LE staging and re-provision.
- **Keycloak login form not found** — usually means Caddy hasn't routed to
  Keycloak yet. Re-run `pnpm run sso-e2e:droplet:run`.
- **Cookie has Domain=.sslip.io instead of .<IP>.sslip.io** — that would
  be a regression in `deriveSsoCookieDomain`; the unit suite would already
  fail at the `sslip.io / 5+ label common parent` describe block.
