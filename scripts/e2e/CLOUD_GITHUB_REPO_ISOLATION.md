# Cloud GitHub repo isolation (1 org : 1 repo)

## Why

On cloud, every license tier (`paid`, `free`, `trial`, `community-byok`,
the two `stripe-checkout` tenants) is a **separate Kodus organization**.
They all used to share **one** GitHub fixture repo (`tiny-url-cloud`).

The GitHub PAT webhook is a bare `POST /github/webhook` with no per-org
discriminator. When a PR opens, the backend resolves repo → org by taking
the **first** `IntegrationConfig` ordered by `updatedAt DESC`
(`webhook-context.service.getContext` and `pullRequests/save.use-case`).
With N orgs on one repo, the review fires for whichever org most recently
touched its repo config — **not reliably the org under test** — or gets
silently dropped if none has an active automation at that instant. The
scenario then times out waiting for a review that landed on a sibling org
(or nowhere). Non-deterministic ⇒ flaky (`github × paid` failed while
`github × trial` passed in the same run). GitLab/Bitbucket/Azure never hit
this because each has only one cloud tenant ⇒ one org per repo.

QA evidence (2026-06-01 run): a single PR #73 webhook created PR docs in
**4 orgs** at once; **9 orgs** total had been connected to `tiny-url-cloud`
over time.

## The fix

Give every cloud **GitHub PAT** tenant its **own** repo, restoring the
1 org : 1 repo invariant the other providers already have. `github-app` is
already isolated on its App-bound repo; GitLab/Bitbucket/Azure keep their
env-resolved cloud repos.

Code wiring (already merged with this doc):
- `tests/e2e/cli/cloud/setup-tenants.ts` — each github tenant has a
  dedicated `repoFullName`; a load-time `validateGithubRepoIsolation`
  invariant fails the seed if two github tenants share a repo or one lacks
  its own. `connectProvider` forwards `repoFullName` to the provider.
- `tests/e2e/providers/index.ts` — `makeProvider(name, target, repoOverride?)`
  (GitHub honours it; others ignore it).
- `tests/e2e/lib/runner.ts` — `CloudTenantEntry.repoFullName` is read and
  passed to `makeProvider` at run time; the pre-flight stale-PR cleanup
  now dedupes by `(provider, repo)` so a sibling tenant's repo is cleaned
  too.

## One-time rollout (live steps — need the QA/GitHub creds)

1. **Provision the repos** (PAT with create rights in `kodus-e2e`):
   ```
   GH_TEST_TOKEN=<pat> ./scripts/e2e/provision-cloud-github-repos.sh
   ```
   Creates the six `tiny-url-cloud-{paid,free,trial,community,stripe-free,stripe-trial}`
   repos, mirroring content from `GH_TEST_REPO_CLOUD` (default
   `kodus-e2e/tiny-url-cloud`).

2. **Re-seed tenants** so each connects its dedicated repo. The
   `/code-management/repositories` call uses `type:"replace"`, which
   removes the old shared repo from each tenant's config in the same step:
   ```
   pnpm run cloud:setup-tenants
   ```
   This rewrites `~/.kodus-dev/cloud-tenants.json` with `repoFullName` per
   tenant.

3. **Refresh the CI secret** — the cloud matrix restores
   `~/.kodus-dev/cloud-tenants.json` from the `CLOUD_TENANTS_JSON` secret
   (it does NOT re-seed), so push the new file up:
   ```
   gh secret set CLOUD_TENANTS_JSON < ~/.kodus-dev/cloud-tenants.json
   ```

4. **Re-run** the cloud matrix — `github × *` cells are now deterministic.

After step 2, the old `tiny-url-cloud` keeps only the ~3 truly-orphan orgs
from earlier generations; they never receive PRs again, so no destructive
DB cleanup is required. (Optional: disconnect them via
`DELETE /code-management/delete-integration-and-repositories` per org.)
