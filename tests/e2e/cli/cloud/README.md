# Cloud QA setup

Seeds the persistent E2E tenants on `qa.web.kodus.io` that the cloud
matrix smoke runs against. Each tenant is single-provider and
single-tier so it mirrors the self-hosted isolation pattern.

Use `setup-tenants.ts` once (or after a QA reset). Credentials are
written to `~/.kodus-dev/cloud-tenants.json` (gitignored, chmod 600)
and consumed by `tests/e2e/lib/runner.ts:resolveTenantForCell` on
cloud cells.

## How it works

Pure HTTP, no Playwright (the original blocker — QA `/auth/signup`
returning 500 — was fixed upstream by the ResendEmailProvider lazy
init in PR #1112). The script reuses the same `lib/onboarding.ts`
helpers the self-hosted matrix uses (`signUp`, `login`,
`registerIntegration`, `registerRepo`, `finishOnboarding`), pointed at
`https://qa.web.kodus.io/api/proxy/api`.

## Tenants seeded

| Email                       | Tier  | Provider     | Repo                                          |
| --------------------------- | ----- | ------------ | --------------------------------------------- |
| e2e-paid-gh@kodus.io        | paid  | GitHub       | kodus-e2e/tiny-url                            |
| e2e-free-gh@kodus.io        | free  | GitHub       | kodus-e2e/tiny-url                            |
| e2e-trial-gh@kodus.io       | trial | GitHub       | kodus-e2e/tiny-url                            |
| e2e-paid-gl@kodus.io        | paid  | GitLab       | kodus-e2e/tiny-url                            |
| e2e-paid-bb@kodus.io        | paid  | Bitbucket    | kodustech/tiny-url                            |
| e2e-paid-az@kodus.io        | paid  | Azure DevOps | kodustech/kodus-e2e/tiny-url                  |

Repos are shared across tiers of the same provider — license tier is
per-org on cloud, so each tier needs its own organization, but
webhook deliveries on a single repo can be disambiguated by Kodus per
integration (App installation id for GitHub, PAT integration uuid
for the others). One downside: `generateKodyRulesUseCase` at
finish-onboarding reads PR history regardless of which org is
onboarding, so rules generated for tier B can be shaped by traffic
from tier A. Acceptable for the QA matrix where the
license-attribution and per-seat gates are the real signal.

## Flow per tenant

1. **Signup** via `POST /auth/signUp` (idempotent — 409 on duplicate
   is treated as "already created"). No email verification on fresh
   signups.
2. **Login** via `POST /auth/login` to get the access token + resolve
   the org/team uuids.
3. **Connect provider** via `POST /code-management/auth-integration`
   with the same PAT/app-password the self-hosted matrix uses
   (`GH_TEST_TOKEN`, `GL_TEST_TOKEN`, `BB_TEST_USER` +
   `BB_TEST_APP_PASSWORD`, `AZ_TEST_TOKEN`).
4. **Register repo** via `POST /code-management/repositories`. The
   tenant's `repoFullName` is patched into the provider's env override
   (`GH_TEST_REPO` etc.) for the duration of this step.
5. **Finish onboarding** via `POST /code-management/finish-onboarding`
   — triggers Kody-rules generation (uses LLM tokens).
6. **Persist** to `~/.kodus-dev/cloud-tenants.json`.

## Usage

    pnpm run cloud:setup-tenants                          # all tenants
    CLOUD_SETUP_ONLY=e2e-free-gh@kodus.io \           # one tenant
      pnpm run cloud:setup-tenants
    CLOUD_SETUP_PASSWORD='your-pass' \                # override default
      pnpm run cloud:setup-tenants

Env overrides:

* `CLOUD_WEB_URL` — defaults to `https://qa.web.kodus.io`
* `CLOUD_API_URL` — defaults to `${CLOUD_WEB_URL}/api/proxy/api`
* `CLOUD_SETUP_ONLY` — comma-separated emails to target
* `CLOUD_SETUP_PASSWORD` — shared tenant password (default
  `E2eCloud!2026Smoke`)

## Prerequisites

* `qa.web.kodus.io` reachable
* Provider tokens in `~/.kodus-dev/config` (same as self-hosted matrix)
* Fixture repos exist with the expected branches (`feature/add-stats`,
  `refactor/use-map-storage`, etc.) — see `tests/e2e/scenarios/*.ts`
  for the per-scenario branch pairs

## Idempotency

* `signUp` — 409 on duplicate email is silent success; reuses the
  tenant
* `registerIntegration` — POST upserts in place; rotates the token
  if a different one is configured
* `registerRepo` — Kodus is idempotent here; safe to re-run
* `finishOnboarding` — POST can be re-issued; LLM rule-gen will run
  again but writes idempotently

## License tier — TODO

`paid` and `trial` tenants currently stay on the default (free) tier
until Stripe Checkout automation lands. The matrix cell for
`cloud × paid` will fail the license-attribution scenario for the
right reason — the gate reports `free` instead of `paid`.

Once we have either (a) a QA admin endpoint to mutate tier directly
or (b) a Playwright path for the Stripe test-card checkout, plumb it
into `ensureLicenseTier` in `setup-tenants.ts`.

## Wiring the matrix runner — TODO

`lib/runner.ts:resolveTenantForCell` still expects credentials via
env vars (`CLOUD_TENANT_PAID_EMAIL`, etc.). It needs to be taught to
read from `~/.kodus-dev/cloud-tenants.json` keyed by
`(provider, license)` so the matrix can drive multiple cloud cells
without setting six env-var pairs.
