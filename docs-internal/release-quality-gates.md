# Release quality gates

This document describes the new self-hosted and cloud release flow with mandatory E2E validation before any customer-visible tag is published.

## TL;DR

- A self-hosted release builds an **RC image** first (`X.Y.Z-rc.N`).
- The RC is validated against a **matrix of provider × license cells** on ephemeral droplets.
- Only after the matrix passes does the **promote** job retag the digest to the final `X.Y.Z` + `:latest` tag, create the git tag `selfhosted-X.Y.Z`, and publish the GitHub Release.
- The changelog and CLI release are gated on a successful promote.
- Cloud has an equivalent matrix (4 providers × 3 plans) that runs against the existing cloud QA URL.

## Self-hosted release flow

```text
selfhosted-build-push.yml  (workflow_dispatch)
        │
        ├─ plan-release            compute version + RC version
        ├─ create-rc-tag           push selfhosted-X.Y.Z-rc.N
        ├─ build-and-push          push GHCR :X.Y.Z-rc.N  (no :latest!)
        ├─ e2e-matrix              calls e2e-self-hosted-matrix.yml
        │       │
        │       ├─ shard: github × license-paid       (droplet, 20-25 min)
        │       ├─ shard: gitlab × license-paid       (droplet, 20-25 min)
        │       ├─ shard: bitbucket × license-paid    (droplet, 20-25 min)
        │       ├─ shard: azure-devops × license-paid (droplet, 20-25 min)
        │       └─ shard: github × license-free       (droplet, 20-25 min)
        │
        ├─ promote                 calls selfhosted-promote.yml
        │   • retag GHCR :rc → :X.Y.Z + :latest (NO REBUILD)
        │   • push git tag selfhosted-X.Y.Z
        │   • create GitHub Release X.Y.Z
        │
        ├─ cli-changes / cli-release  (after promote)
        ├─ changelog-publish          (after promote, on FINAL tag)
        └─ cleanup-rc-tag             (delete selfhosted-X.Y.Z-rc.N git tag)
```

### What changed compared to the old flow

| Aspect | Before | After |
|---|---|---|
| What gets pushed first | `:X.Y.Z` + `:latest` | `:X.Y.Z-rc.N` only |
| When E2E runs | After tag push, async via `repository_dispatch` to kodus-installer | Inline in the release workflow, BEFORE promote |
| What does E2E cover | GitHub only, one droplet | 4 providers × license matrix, parallel droplets |
| Customer impact when E2E fails | Customer already sees broken tag in GHCR | Customer never sees the RC tag |
| Changelog timing | Right after build | Only after promote (validated) |

### Triggering a release

1. Go to Actions → "Self-Hosted: Release, Build, Validate and Publish".
2. Run workflow on `main`. Pick `version_type` (patch / minor / major / custom).
3. Wait. Total time ~35–50 min:
    - Build: ~10 min
    - E2E matrix: ~25 min (parallel shards)
    - Promote: ~1 min
    - CLI + Changelog: ~5 min
4. On success, `selfhosted-X.Y.Z` and `:latest` are live on GHCR; Discord gets a green notification via `changelog-publish`.
5. On failure, the **RC tag is still on GHCR** (for forensic inspection) but no customer-visible tag exists. Discord gets a red notification with the phase that failed.

### Rerunning after a failed E2E

If the matrix fails:

1. Inspect the failing shard's evidence artifact in the workflow run (downloadable `summary.md`).
2. Fix the bug.
3. Run the workflow again. A new RC tag `selfhosted-X.Y.Z-rc.<run+1>` is created.
4. If you must skip a known-flaky provider: edit `tests/e2e/matrix/p0.yml` to remove that cell (and open a ticket to bring it back).

### Re-promoting an RC manually

If `promote` fails after E2E passed (e.g., transient GHCR error), invoke `selfhosted-promote.yml` directly:

- Workflow → "Self-Hosted: Promote RC to final" → Run workflow
- Inputs:
    - `rc_version`: e.g. `1.42.0-rc.3`
    - `release_version`: `1.42.0`
    - `release_tag`: `selfhosted-1.42.0`

No rebuild happens — the existing RC digest is retagged.

## Cloud release flow

Cloud is permanent infrastructure. The release flow is:

```text
qa-build-push-and-pr-green.yml          prod-build-push-and-pr-green.yml
        │                                       │
        push main with backend changes          GitHub Release published
        │                                       │
        build :<sha> on ECR                     build :<tag> on ECR
        │                                       │
        open GitOps PR on kodus-infra           open GitOps PR on kodus-infra
        │                                       │
        PR merge → ECS rolls out                PR merge → ECS rolls out
        │                                       │
        cloud QA URL serves new image           prod serves new image
        │                                       │
        e2e-cloud.yml runs                       (synthetic monitor + rollback alarm)
        (4 providers × 3 plans)
```

### Running cloud E2E

```bash
# Locally (against cloud QA):
cd tests/e2e
export TARGET_BASE_URL=https://api-qa.kodus.io
export TARGET_WEB_URL=https://app-qa.kodus.io
export CLOUD_TENANT_PAID_EMAIL=... CLOUD_TENANT_PAID_PASSWORD=...
export GH_TEST_TOKEN=... GH_TEST_REPO=... GH_TEST_PR_NUMBER=...
./provisioning/cloud/target.sh
```

In CI, invoke `e2e-cloud.yml` (workflow_dispatch) after a cloud deploy. To gate cloud deploys behind it, wire `kodus-infra` to dispatch this workflow on PR-merge events.

## Local development

### Run a single scenario against an arbitrary stack

```bash
cd tests/e2e
npm install

# Self-hosted (already running locally, e.g. via kodus-installer's compose)
export TARGET_BASE_URL=http://localhost:3001
export TARGET_WEB_URL=http://localhost:3000
export TARGET_TUNNEL_URL=https://your-tunnel.trycloudflare.com
export SH_TENANT_EMAIL=test@kodus.test SH_TENANT_PASSWORD='your-pass'
export GH_TEST_TOKEN=ghp_xxx GH_TEST_REPO=kodustech/kodus-qa-fixtures GH_TEST_PR_NUMBER=1
npm run scenario -- --scenario code-review-basic --target self-hosted --provider github --license license-paid
```

### Provision a fresh droplet locally and run the whole matrix

```bash
cd tests/e2e
export DIGITALOCEAN_TOKEN=dop_v1_xxx
export KODUS_INSTALLER_PATH=$HOME/dev/kodus/kodus-installer
export IMAGE_TAG=selfhosted-1.42.0-rc.3
export MATRIX_FILE=matrix/p0.yml
export GH_TEST_TOKEN=... GH_TEST_REPO=... GH_TEST_PR_NUMBER=...
export GL_TEST_TOKEN=... # etc.
./provisioning/self-hosted/vm.sh
```

## Adding a new scenario

1. Create `tests/e2e/scenarios/<name>.ts`. Export a `Scenario` with `appliesTo` listing which cells it runs against.
2. Add the scenario id to `scenarios/index.ts`.
3. Add it to `matrix/p0.yml` (or `matrix/release.yml`) under `scenarios:`.
4. Wire it into the workflow shard's inline matrix YAML in `e2e-self-hosted-matrix.yml` / `e2e-cloud.yml` if the scenario should be part of the per-shard run.

## Adding a new provider

1. Implement `tests/e2e/providers/<name>.ts` extending `BaseProvider`.
2. Register in `providers/index.ts`.
3. Add a shard to `e2e-self-hosted-matrix.yml` `strategy.matrix.cell` and to `e2e-cloud.yml`.
4. Set the provider-specific secrets (see `release-quality-gates-secrets.md`).

## Triage when E2E fails

The aggregated `e2e-self-hosted-matrix` artifact contains:

- `result.json` — structured pass/fail per cell with error message and stack
- `summary.md` — human-readable summary with markdown tables
- `<scenario>-<target>-<provider>-<license>/` — per-cell artifact directory (screenshots, samples)

Common failure patterns:

| Symptom | Likely cause | Fix |
|---|---|---|
| `Login failed` in self-hosted | Signup didn't run / stack didn't start | Check provisioning script logs in the workflow output |
| `Repo not in integration's available list` | Provider token missing scopes | Regenerate token with `repo` + `webhook` scopes |
| `No review activity within timeout` | Webhook didn't reach API / worker crashed | Inspect cloudflared logs in evidence; check WORKER_ROLE env |
| Provider-specific API 4xx | API schema drift | Update the provider's TypeScript client |
| `license-attribution` failed for `free` (expected no review, got one) | Entitlement gate not enforced | Real bug — file ticket on license code path |
| `license-attribution` failed for `paid` (expected review, got none) | License key invalid / not propagated | Check `SH_LICENSE_KEY_PAID` secret |

## Migration notes for the team

- `kodus-installer/.github/workflows/e2e-self-hosted.yml` continues to exist and can still be invoked manually as a single-cell smoke check. It is **no longer** automatically dispatched by the release workflow. We will delete it after a few clean releases on the new flow.
- `tests/e2e/playwright/signup.mjs` and `ui-smoke.mjs` are copies of the ones in kodus-installer. Future updates should land in this repo; the installer copies will be deleted in a follow-up.
- The legacy `selfhosted-build-push.yml` is gone — replaced by the new RC-gated version with the same workflow file name. Any script or doc that referenced the old jobs may need updating.
