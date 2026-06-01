# Quality Gates v2 — Pending Work

> **Temporary file.** Tracks what was left unfinished when `chore/quality-gates`
> was split: the merge-to-main branch (`chore/quality-gates`) ships the E2E
> framework + scripts + app-side fixes **without** the CI workflow files, and
> this branch (`quality-gates-v2`) continues from here with the workflows and
> the open items below. Delete this file once the items are triaged into real
> issues / done.

Last updated: 2026-05-23.

---

## Branch split summary

- `chore/quality-gates` → **merging to main.** Contains: the `tests/e2e/`
  framework, `scripts/selfhosted/*`, `scripts/e2e/*`, all the app-side
  reliability fixes (see "App-side fixes already landed"), and the matrix
  YAMLs. The 5 CI workflow files were **removed** from it (reverted to main's
  state) so half-stabilized CI doesn't land on main.
- `quality-gates-v2` → **this branch.** Carries the 5 workflow files forward
  and is where the pending work below continues.

### Workflow files that live here (not on main)

| File | State vs main | Purpose |
|---|---|---|
| `.github/workflows/e2e-cloud.yml` | new | Cloud E2E matrix runner |
| `.github/workflows/e2e-self-hosted-matrix.yml` | new | Self-hosted E2E matrix runner |
| `.github/workflows/e2e-suite-tests.yml` | new | Unit/integration suite for the E2E framework |
| `.github/workflows/selfhosted-promote.yml` | new | Retag RC → customer-visible tag after E2E green |
| `.github/workflows/selfhosted-build-push.yml` | modified (~401 lines) | RC-tagging build/push |

These were intentionally kept off main because the self-hosted matrix is not
yet 100% green in CI shape (see Bitbucket item below) and the promote workflow
gates releases on that matrix.

---

## Open items

### 1. Bitbucket cell fails in the full matrix (BLOCKER for green CI)

**Status:** ✅ root-caused; fixed at the **production** layer (not
test-only); **validated** on the `repaired-cells` matrix (2026-05-25).

**Validation result (2026-05-25, self-hosted droplet running the fix):**
Bitbucket cell went **0/5 → 4/5** with a **fresh-per-run tenant** (the
real customer path, not the persistent-tenant band-aid). **Zero 429s in
the entire run** (worker logs). github 5/5, gitlab 5/5. The single
remaining Bitbucket failure is `kody-rules`, an **unrelated** pre-existing
bug — the AST repo clone uses an unauthenticated `git fetch` against
private Bitbucket repos (`could not read Username`), starving the rule
pipeline of repo content → 0 suggestions. Filed as **#1168**. github/gitlab
kody-rules passed; the 429-sensitive Bitbucket scenarios all passed.

Bitbucket passes in isolation (single-cell `bitbucket-only.yml` probe = 5/6,
the 6th fixed by the 5s branch-create wait; `smoke` = pass) but failed 0/5 in
the full matrix. Cause: the matrix creates a **fresh tenant per cell**, so the
Bitbucket cell's `registerRepo` triggers a historical-PR backfill in
background; that backfill + the review pipeline + the scenario's own polling
all hit the **same** Bitbucket app-password token concurrently and blew the
per-endpoint burst window → `429` cascade.

GitHub/GitLab are unaffected (much higher API budgets).

**Rejected band-aid:** using a **persistent** tenant for the Bitbucket cell
(like `smoke`) so `registerRepo` doesn't re-trigger backfill. This only hides
the bug in the test — a real customer's first repo registration still 429s.

**Applied fix (production-level, fixes the test as a consequence):**
- Per-credential **rate gate** at the single Bitbucket HTTP chokepoint
  (`libs/core/infrastructure/http/per-key-rate-gate.ts`, wired into
  `BitbucketCloudService.safeFetch`): single-slot + min-interval queue keyed
  by the `Authorization` header, so backfill + review + polling serialize per
  token and *proactively* park on 429 (`Retry-After`). Composes with the
  existing reactive `with429Retry`.
- Backfill **single-flight** guard in `create-repositories.ts` (no two
  concurrent backfills for the same org/team on double-save/retry).
- In-memory / per-process — see item #6b for the distributed follow-up.

Alternatives considered (now moot): (a) two rotating BB tokens; (b) accept BB
as quarantined/flaky. Parallelizing the matrix does NOT help — all droplets
share the one BB token; the gate is what bounds the load.

### 2. Production bug — Bitbucket backfill rate-limit (FILED)

GitHub issue **kodustech/kodus-ai#1165**. Backfill can silently 429 against
Bitbucket, dropping dashboard history + degrading the first review.

Progress on the proper fix:
- **per-token rate limiter** — DONE (per-process gate, item #1). Distributed
  version is item #6b.
- **don't re-trigger backfill needlessly** — partially DONE: single-flight
  guard (item #1) + the existing PR-level idempotency (backfill skips PRs
  already saved, so re-registering an existing repo costs ~1 list call). A
  strict "diff only newly-added repos" was deemed low-value given that and
  left out.
- **stop masking 429 as "0 commits"** — still open. Backfill's per-PR
  `catch` (`backfill-historical-prs.use-case.ts:303`) swallows fetch errors
  into empty stats; the live review path now re-throws. Revisit in the issue.

### 3. Parallel matrix architecture — ✅ DONE & validated (2026-05-25)

One droplet per provider; provider units run in parallel, cells within a
provider stay serial. Cross-provider license-state pollution is now
impossible and wall-time dropped (matrix execution ~15min vs ~50-60min
serial). Shipped on `quality-gates-v2` (commit `d9cf90835`):

- `envForTarget(target, provider)` resolves `SELFHOSTED_*_<PROVIDER>` with
  fallback to the shared `SELFHOSTED_*` then `TARGET_*`. `selfhostedEnvSuffix`
  (uppercase, non-alnum→_) is unit-tested.
- `run-matrix.ts` splits into units: cloud = 1, self-hosted = 1 per provider,
  all via `Promise.allSettled`.
- `run.sh --auto-provision-per-provider` provisions `matrix-<provider>` per
  provider and exports `SELFHOSTED_*_<SUFFIX>` (+ refreshed tunnel) each.
  Build-once: a prior deploy's cached override propagates to fresh droplets.
- `selfhosted:deploy-all` (build once, distribute) + `selfhosted:destroy-all`.

**Validated**: `full-no-sso.yml --target self-hosted
--auto-provision-per-provider` ran github/gitlab/bitbucket/azure-devops in
parallel — **6/6 each, 0 failures** (Azure exercised for the first time).
Provisioning is still serial (parallelizing it is a minor future add). Does
not change the Bitbucket single-token story — the per-credential gate
(item #1) bounds that.

> Note: SSO cells need `SH_LICENSE_KEY`, which is **empty** in
> `~/.kodus-dev/config` — so `full.yml` (with sso-*) fail-fasts. Use
> `full-no-sso.yml` until a license JWT is seeded. (`op read` confirms len 0;
> don't be fooled by masked dumps showing `SH_LICENSE_KEY=<...>`.)

### 4. `MCP_MANAGER_URL` hostname wrong on self-hosted (COSMETIC)

Worker logs `ECONNREFUSED 127.0.0.1:3101` because the env points at
`localhost` instead of `kodus-mcp-manager:3101`. `errorSeverity='partial'` so
the pipeline continues and `BusinessLogicValidationStage` just skips ("no
task-management MCP connected"). No test impact today, but a self-hosted
customer who connects Jira/Linear via MCP would silently get no
business-logic validation. Fix the compose/env var.

### 5. license-attribution × license-free coverage

`license-free` was removed from `license-attribution.appliesTo` for
self-hosted (commit `6902865b9`) because the "trial ended" notice is
structurally unreachable on self-hosted (only the cloud path emits it). The
**cloud** `free`/`trial` notice path is still asserted but has not been
re-validated end-to-end recently. Confirm a cloud run exercises it.

### 6b. Distributed limiter for the Bitbucket rate gate (FOLLOW-UP)

The item #1 fix (per-credential rate gate in `safeFetch`, plus backfill
single-flight in `create-repositories.ts`) is **in-memory / per-process**.
Production runs N-replica workers on AWS, so each replica gates
independently — a single tenant's review traffic spread across replicas
can still collectively exceed Bitbucket's per-token limit (the reactive
`with429Retry` then absorbs it, degrading to "slower" not "failed").

This is acceptable for now and strictly better than the prior state (no
coordination at all). The dominant burst source — the backfill — runs
entirely in one API process, so it's fully gated. The residual gap is the
review pipeline across worker replicas.

**Real future fix:** coordinate on shared state. Recommended path is a
per-tenant RabbitMQ queue with `prefetch=1` (serialize provider calls
across replicas, no new infra — Rabbit is already in the stack). Redis
token-bucket is the classic alternative but would add infra to both cloud
and self-hosted (against the simple/identical-topology principle).
Track alongside #1165.

### 6. authMode App matrix coverage

From the project plan: App authMode coverage was "next" and is not yet in the
matrix. Add a self-hosted github-app cell (the cloud github-app cell exists in
`full.yml`).

### 7. Bitbucket AST clone git-auth (#1168) — ✅ FIXED & validated

Surfaced by the 2026-05-25 `repaired-cells` run. The AST graph build's
`git fetch` against Bitbucket failed with `could not read Username`, so
the repo got no AST graph. **Root cause:** Atlassian API tokens (ATATT…)
authenticate to git-over-HTTPS ONLY with the literal username
`x-bitbucket-api-token-auth` — the REST API accepts `<email>:<token>`
(why every other Bitbucket call worked), but git rejects it. **Fixed** in
`buildAuthHeader` (local + E2B sandbox) — commit `0b2b03d03`. Validated:
AST build now COMPLETES on Bitbucket. (The AST failure was a *red herring*
for the kody-rules 0-suggestions symptom — see item #8.)

### 8. kody-rules drops LLM-corrupted rule UUID (#1170) — ✅ MITIGATED

Once #1168 was fixed, kody-rules × bitbucket *still* gave 0 suggestions.
Real cause: the agent validates each suggestion's `ruleUuid` with an exact
match, and the LLM occasionally drops a character echoing the 36-char UUID
(`…cc9eb8773a92` → `…cceb8773a92`), discarding a correct finding. Not
provider-specific — github/gitlab passed only because the LLM happened to
echo it correctly. **Mitigated** in `base-code-review-agent.provider.ts`
(`recoverRuleUuid`, edit-distance ≤2 unique match) — commit `2869fd57f`.
Stronger follow-up (index-based rule refs so the model never echoes a
UUID) tracked in **#1170**.

---

## App-side fixes already landed (on `chore/quality-gates`, will reach main)

| Commit | Fix |
|---|---|
| `188eff487` | per-seat-license-toggle teardown clears install-wide license (CE mode) so the next cell isn't blocked; kody-rules rule reworded to defeat LLM "intentional fixture" excuse; sso preflight fail-fast |
| `6902865b9` | drop `license-free` from license-attribution on self-hosted (notice unreachable there) |
| `97842c63f` | `with429Retry` helper (honours Retry-After + jittered backoff); wrap hot BB/GitLab calls; cut kody-rules PR fan-out 5→2 |
| `2c3203695` | remove redundant synchronous `generateKodyRules` from `finishOnboarding` (was holding the HTTP request open while hammering the provider) |
| `cda9c4457` | cap historical backfill to 10 PRs, 2s apart, patient retry |
| `08bd7918f` | wait 5s after BB throwaway-branch create before opening the PR (dodge BB commits-indexing race that made ValidateNewCommitsStage skip with "0 commits") |

## Test status snapshot (2026-05-25, `repaired-cells` matrix w/ rate-gate fix)

Single-droplet `repaired-cells` run on a droplet running the rate-gate +
single-flight fix (image tag `dev-matrix`). Fresh-per-run tenants. Final:
**14/20 passed (1 failed, 5 skipped)**.

| Cell | Result |
|---|---|
| github × {code-review, onboarding-webhook, kody-rules, license-attribution, per-seat} | 5/5 PASS |
| gitlab × same 5 | 5/5 PASS |
| **bitbucket × same 5** | **4/5** — was 0/5 (item #1 fixed). Only `kody-rules` failed: unrelated AST-clone auth bug (#1168, item #7). **Zero 429s in the whole run.** |
| github × license-free | 5 SKIP (item #5, by design) |

Earlier (2026-05-23, pre-fix): bitbucket was 0/5 in the full matrix (429
cascade), 5/6 in `bitbucket-only.yml` isolation.

## Useful artifacts

- `tests/e2e/matrix/bitbucket-only.yml` — single-cell BB isolation probe (added here).
- `tests/e2e/matrix/repaired-cells.yml` — focused set covering the cells that failed on 2026-05-23.
- `tests/e2e/matrix/full-no-sso.yml` — full matrix minus SSO (for when `SH_LICENSE_KEY` is absent).
