# E2E quality gates — local runner

Run the same scenarios CI runs, from your laptop. Three modes, escalating in cost and coverage:

| Command | Time | Cost | Provisions? | When to use |
|---|---|---|---|---|
| `pnpm run e2e:dry-run` | seconds | $0 | no | After any change to scenarios/providers/runner. Validates wiring. |
| `pnpm run e2e:smoke` | ~3 min | $0 (reuses your droplet) | no | Before pushing — confirm one combo actually passes end-to-end. |
| `pnpm run e2e:matrix` | ~30-45 min | ~$1-2 | yes (per cell) | Before a release branch. Catches cross-provider regressions. |

## `pnpm run e2e:dry-run`

Loads scenarios, instantiates providers with no env vars set, walks the matrix without executing any real step. Catches: broken imports, missing scenario id, type errors. Doesn't catch: bugs that need real provider state.

## `pnpm run e2e:smoke`

Runs **one** scenario × provider against the droplet you already have alive from `pnpm run selfhosted:provision` (reads `.kodus-dev/selfhosted-vm-default.json` for the target URLs + tenant creds).

```bash
pnpm run e2e:smoke                                       # github × code-review-basic
pnpm run e2e:smoke --provider gitlab                     # different provider
pnpm run e2e:smoke --scenario kody-rules-create-and-apply
pnpm run e2e:smoke --name junior                         # against a named instance
```

Fails fast if no droplet is alive — telling you to run `pnpm run selfhosted:provision` first.

## `pnpm run e2e:matrix`

Runs the full matrix from `tests/e2e/matrix/fast.yml` (or another file you pass). Each self-hosted cell provisions a fresh droplet; each cell hits real provider APIs.

```bash
pnpm run e2e:matrix                          # tests/e2e/matrix/fast.yml
pnpm run e2e:matrix matrix/full.yml       # different matrix
pnpm run e2e:matrix -y                       # skip the cost/duration confirmation
```

**Skips cells with missing tokens** — if you only have GitHub + GitLab tokens, the Bitbucket and Azure DevOps cells are reported as skipped, not failed.

## Where the secrets come from

Same priority order as `scripts/selfhosted/`:

1. Inline env (`GH_TEST_TOKEN=... pnpm run e2e:smoke`)
2. `scripts/e2e/.env` (gitignored, per-repo override)
3. `~/.kodus-dev/config` (managed by `pnpm run selfhosted:setup`, shared with selfhosted scripts)

`op://Vault/Item/field` references resolve via 1Password CLI — same flow the selfhosted scripts use.

### Provider test tokens needed

Each provider is independent — set only the ones you want to test.

| Provider | Required vars |
|---|---|
| github | `GH_TEST_TOKEN`, `GH_TEST_REPO` (e.g. `myorg/test-repo`) — optional: `GH_TEST_PR_NUMBER` |
| gitlab | `GL_TEST_TOKEN`, `GL_TEST_REPO` — optional: `GL_TEST_MR_IID` |
| bitbucket | `BB_TEST_USER`, `BB_TEST_APP_PASSWORD`, `BB_TEST_REPO` — optional: `BB_TEST_PR_ID` |
| azure-devops | `AZ_TEST_TOKEN`, `AZ_TEST_ORG`, `AZ_TEST_PROJECT`, `AZ_TEST_REPO` — optional: `AZ_TEST_PR_ID` |

Without `*_PR_*` numbers set, the scenario creates a fresh PR/MR on each run.

## Where evidence lands

```text
tests/e2e/evidence/<runId>/
  summary.json
  results.json
  *.log
```

Same path CI uploads — local runs use the identical artifact format.

## Troubleshooting

- **"No alive self-hosted instance"** (smoke): you need `pnpm run selfhosted:provision` first. Smoke doesn't provision.
- **All cells skipped** (matrix): no provider tokens set. Add at least one (`GH_TEST_TOKEN` + `GH_TEST_REPO` is the simplest).
- **Cell fails on `DIGITALOCEAN_TOKEN`** (matrix, self-hosted): matrix's own provisioning needs DO access. Already required by `pnpm run selfhosted:provision`, so usually already set.
- **`op` not authenticated**: enable Settings → Developer → "Integrate with 1Password CLI" in the 1Password app, or `eval $(op signin)`.

## How this fits

| | local helper | CI workflow |
|---|---|---|
| 1 droplet alive for manual work | `scripts/selfhosted/` | — |
| 1-combo smoke | `pnpm run e2e:smoke` | always part of full matrix run |
| Full matrix | `pnpm run e2e:matrix` | `.github/workflows/e2e-self-hosted-matrix.yml` + `.github/workflows/e2e-cloud.yml` |
| Release promotion gate | — | `.github/workflows/selfhosted-promote.yml` (only retags RC → final if matrix is green) |
