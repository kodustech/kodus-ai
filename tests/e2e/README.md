# E2E quality gates

End-to-end validation suite for Kodus releases. Exercises the product against real Git providers and real environments, in both **cloud** and **self-hosted** targets.

## Why this exists

Quality bugs that hurt customers fall into a few classes:

1. **Provider-specific** — fix in code shared by all providers, only tested against GitHub, ships broken to GitLab/Bitbucket/Azure DevOps customers.
2. **License/plan-specific** — entitlement gate has different code paths for free/trial/paid (cloud) and license-paid/license-free (self-hosted).
3. **Target-specific** — `API_CLOUD_MODE=true` and `=false` exercise different code paths.
4. **Upgrade-specific** — fresh install works, upgrade from N-1 breaks (migrations, env vars, compose changes).

This suite runs a **matrix of scenarios** that covers each of those axes, so a regression in any cell fails the release before customers see it.

## Structure

```text
tests/e2e/
├── providers/             Git provider API clients (one interface, 4 impls)
│   ├── base.ts            Provider interface
│   ├── github.ts
│   ├── gitlab.ts
│   ├── bitbucket.ts
│   └── azure-devops.ts
├── scenarios/             Test scenarios (what we validate)
│   ├── code-review-basic.ts
│   ├── kody-rules.ts
│   ├── license-attribution.ts
│   └── upgrade.ts
├── provisioning/          How we get a target ready
│   ├── self-hosted/
│   │   ├── vm.sh          Provision droplet (DO/Hetzner) + tunnel + install
│   │   └── local.sh       Local docker-compose + ngrok
│   └── cloud/
│       └── target.sh      Resolve cloud QA URL + tenant credentials
├── playwright/            UI-driving headless browser flows
│   ├── signup.mjs
│   ├── ui-smoke.mjs
│   └── kody-rules.mjs
├── lib/                   Shared runtime
│   ├── types.ts           Target, Provider, License, Scenario, Result types
│   ├── onboarding.ts      Kodus-side: login + register integration + add repo
│   ├── runner.ts          Executes scenario(s) × matrix, emits evidence
│   ├── evidence.ts        JSON + Markdown evidence formatter
│   └── log.ts             Color logging
├── cli/                   Entry points
│   ├── run-scenario.ts    Run a single scenario against a target
│   └── run-matrix.ts      Run multiple scenarios × matrix
├── matrix/                Pre-defined matrix configurations
│   ├── fast.yml           Fast tier — PR / push gates
│   └── full.yml           Full tier — superset of fast + lifecycle scenarios
└── fixtures/              Diff fixtures used to open PRs
    └── basic-diff.md
```

## Matrix axes

A scenario runs against a **cell** of the matrix:

| Axis | Values |
|---|---|
| `target` | `cloud` \| `self-hosted` |
| `provider` | `github` \| `gitlab` \| `bitbucket` \| `azure-devops` |
| `license` | `free` \| `trial` \| `paid` (cloud) \| `license-paid` \| `license-free` (self-hosted) |

Each scenario declares which cells it applies to. Cells where the scenario doesn't apply are skipped automatically.

## Test layers (what is validated without external infra)

The suite ships with 37 automated tests organized in three layers — all run in CI on every PR via `npm test`.

| Layer | Files | Tests | What it proves |
|---|---|---|---|
| Unit (deterministic) | `lib/__tests__/applies-to.test.ts`, `evidence.test.ts`, `scenarios.test.ts`, `matrix-loader.test.ts`, `providers.test.ts` | 32 | Filter logic, matrix YAML schema, evidence format, scenario catalog, provider factory |
| Integration — GitHub (happy path + negative path) | `lib/__tests__/integration.test.ts` | 2 | Runner executes onboarding + trigger + poll against mock Kodus + GitHub HTTP servers, parses JWT, asserts expected endpoints were called |
| Integration — multi-provider | `lib/__tests__/integration-providers.test.ts` | 3 | Same as above but for GitLab, Bitbucket, Azure DevOps — each provider's actual `triggerReviewOnExistingPR` / `pollForReview` / `repoRef` / auth code is exercised against a per-provider mock |

Plus the **dry-run** mode (`npm run dry-run`) walks the entire 33-cell P0 matrix in <1s, validating that `appliesTo` filtering, cell expansion, evidence emission, and exit codes are all wired correctly.

What this does NOT cover (requires real infra):

- Real provider authentication (real PATs, app passwords)
- Real droplet provisioning via DigitalOcean/Hetzner
- Real Cloudflare tunnel
- Real Kodus stack boot via `install.sh`
- Real webhook delivery from provider → tunnel → API
- Real license key validation
- Real cloud tenant entitlement

These can only be validated by triggering an actual release. See `docs-internal/release-quality-gates-secrets.md` for the setup checklist.

## Running

### A single scenario

```bash
# Cloud, GitHub, paid tenant
pnpm run e2e:scenario code-review-basic --target cloud --provider github --license paid

# Self-hosted, GitLab, license-paid
pnpm run e2e:scenario code-review-basic --target self-hosted --provider gitlab --license license-paid
```

### A full matrix

```bash
# Run all P0 scenarios across the full matrix
pnpm run e2e:matrix matrix/fast.yml

# Release validation (all scenarios, all cells)
pnpm run e2e:matrix matrix/full.yml
```

## Environment variables

| Var | Purpose | Required when |
|---|---|---|
| `TARGET_BASE_URL` | URL of the API to test against | Always |
| `TARGET_WEB_URL` | URL of the dashboard | Always |
| `TARGET_TUNNEL_URL` | Public tunnel URL for webhooks (self-hosted only) | `target=self-hosted` |
| `GH_TEST_TOKEN` | GitHub PAT, `repo` + `admin:repo_hook`. Must be a token whose FIRST org is `kodus-e2e` (a fine-grained PAT with resource owner `kodus-e2e`, Repository access = All repositories) — the Kodus integration binds to `orgs[0]` (github.service.ts), so a personal token whose first org is `kodustech` binds the wrong org. | `provider=github` |
| `GH_REPO_ADMIN_TOKEN` | Token with org Administration on `kodus-e2e` (create + delete repos). Used ONLY by `trial-managed-review` to mint/delete its throwaway repo per run; everything else stays on `GH_TEST_TOKEN`. Falls back to `GH_TEST_TOKEN` if unset (a single fully-privileged token also works). | `scenario=trial-managed-review` |
| `GH_TEST_REPO` | GitHub test repo `owner/repo` | `provider=github` |
| `CENTRALIZED_CONFIG_TEST_REPO` (+ `_CLOUD`) | Writable centralized-config source repo `owner/repo`, per target (self-hosted: `kodus-e2e/kodus-config-e2e`, cloud: `kodus-e2e/kodus-config-e2e-cloud`) — the scenario seeds it via the GitHub API each run | scenario `centralized-config-sync` (else it skips) |
| `GL_TEST_TOKEN` | GitLab PAT, `api` + `write_repository` | `provider=gitlab` |
| `GL_TEST_REPO` | GitLab project path | `provider=gitlab` |
| `BB_TEST_USER`, `BB_TEST_APP_PASSWORD` | Bitbucket app password | `provider=bitbucket` |
| `BB_TEST_REPO` | Bitbucket repo `workspace/slug` | `provider=bitbucket` |
| `AZ_TEST_TOKEN` | Azure DevOps PAT | `provider=azure-devops` |
| `AZ_TEST_ORG`, `AZ_TEST_PROJECT`, `AZ_TEST_REPO` | Azure DevOps coords | `provider=azure-devops` |
| `CLOUD_TENANT_FREE_EMAIL`, `CLOUD_TENANT_FREE_PASSWORD` | Free tenant creds | `target=cloud, license=free` |
| `CLOUD_TENANT_TRIAL_*` | Trial tenant creds | `target=cloud, license=trial` |
| `CLOUD_TENANT_PAID_*` | Paid tenant creds | `target=cloud, license=paid` |
| `SH_LICENSE_KEY_PAID` | Self-hosted paid license | `target=self-hosted, license=license-paid` |
| `SH_LICENSE_KEY_FREE` | Self-hosted free license | `target=self-hosted, license=license-free` |

## Evidence

Each run produces:

- `evidence/<run-id>/result.json` — structured result per cell
- `evidence/<run-id>/summary.md` — human-readable summary
- `evidence/<run-id>/screenshots/` — Playwright captures
- `evidence/<run-id>/logs/` — container/worker logs from failures

The release workflow uploads these as artifacts.

## Adding a new scenario

1. Create `scenarios/<name>.ts` exporting a `Scenario` object.
2. Declare the matrix axes it applies to (`appliesTo: { target, provider, license }`).
3. Implement `run(ctx)` using `ctx.provider`, `ctx.kodus`, `ctx.assert`.
4. Add it to `matrix/fast.yml` or `matrix/full.yml`.

## Adding a new provider

1. Implement `providers/<name>.ts` against the `Provider` interface in `providers/base.ts`.
2. Register it in `providers/index.ts`.
3. Set the required env vars (see above).
4. Add the provider to the matrix YAML where appropriate.
