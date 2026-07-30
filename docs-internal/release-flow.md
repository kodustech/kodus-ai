# Release flow — Kodus CI

How code goes from a PR to a customer release, with concrete procedures
for the humans involved. Locked **2026-05-28**.

For visual layout, see `docs/diagrams/ci-flow-files.excalidraw`.

---

## TL;DR

| Phase | When | What happens |
|---|---|---|
| **PR** | PR opened / synchronize | Lint, tests, env-drift, preview deploy, Kody review (3 rules), human approves → merge |
| **Continuous QA** | Push to `main` (paths-filtered) | Per-component deploys to QA cloud + auto-fire `e2e-cloud.yml` (fast.yml) + benchmark FULL if engine paths touched |
| **Release** | Every **Friday** (dispatch by you) | Freeze main → build RC → matrix on `full.yml` → human approve → promote → cloud + SH ship together |
| **Hotfix** | Any time, P0 only | Same chain as release, **skips freeze + human gate**, ships in ~1h |

> **One human gate per release**: approving the `promote` job around 13h on Friday.
> **One human dispatch per hotfix**: clicking Run workflow with `hotfix=true`.

---

## Triggers — what fires when

| Event | Workflow(s) | Notes |
|---|---|---|
| `pull_request` opened/synchronize | `pr-title-check`, `tests`, `env-drift-check`, `permissions-matrix-check`, `feature-gate-check`, `preview-deploy` | All run in parallel. Kody also reviews the diff (3 global rules). |
| `push` to `main` matching `apps/{api,worker,webhooks}/**` or `libs/**` or `packages/**` | `qa-build-push-and-pr-green` → `e2e-cloud` (workflow_call, `fast.yml`) | Backend deploy + cloud matrix on the new image |
| `push` to `main` matching `apps/web/**` or `libs/feature-gate/**` | `web-qa-deploy` | Web deploy to QA ECS |
| `push` to `main` matching `apps/mcp-manager/**` or relevant `docker/`/`tsconfig*` | `qa-mcp-manager-deploy` | MCP deploy via SSH start-app.sh |
| `push` to `main` matching `docker/rabbitMQ/**` | `rabbitmq-build-push` | Rare |
| `push` to `main` matching engine paths (10 patterns) | `code-review-model-benchmark` (FULL) | 5 models, ~$17, ~40min, notify-only |
| Schedule cron `17 5 * * *` UTC | `e2e-cloud` (nightly) | Catch-all drift/flaky regardless of merges |
| `workflow_dispatch` on `selfhosted-build-push` | Full release chain (or hotfix variant) | See procedures below |

---

## Friday release — your procedure

### 03h BRT (06h UTC) — auto-trigger

GitHub Actions fires `selfhosted-build-push.yml` via cron `0 6 * * 5`.
You sleep through it. By the time you arrive in the morning, the
Discord channel already shows whether the matrix is green or red.

The scheduled run uses `version_type: patch`. For minor/major/custom
releases you still need to dispatch manually (typically before 03h on
Friday or you let the patch run go and dispatch the bigger version
yourself).

What happens automatically:

```
freeze-main       ←  Ruleset release-freeze activates. New PR merges are blocked
                     for feat/fix/perf/refactor titles; chore/ci/docs/build/test/style
                     still flow. Admins can "Bypass and merge" (auditable).
plan-release      ←  computes the next X.Y.Z + rc.N from the latest tag
create-rc-tag     ←  pushes selfhosted-X.Y.Z-rc.N
build-and-push    ←  ~10–15 min, builds 5 images, pushes :rc.N only (NOT :latest)
e2e-matrix        ←  ~75–120 min, calls e2e-self-hosted-matrix.yml with full.yml
                     (5 providers × license, full.yml = fast.yml + upgrade-n-1→n
                      + sso-cookie-domain + sso-multi-user + stripe-billing)
                     ↓
                  matrix green
                     ↓
promote PAUSES    ←  env=production · waits for required reviewer approval
                     (you, Wellington, Junior)
```

By ~05:30 BRT the matrix should be done and Discord shows the result.
You wake up to a verdict, not a question.

### 09h — arrive informed

Open Discord. If the matrix posted a failure overnight, the meeting at
10h is already framed around that. If silence, matrix is green — meeting
is about prioritization.

### 10h — weekly meeting

Discuss the week. If the matrix flagged something the team agrees to
fix-forward (not block), proceed. If the team decides not to ship this
week, just don't click Approve — the promote job will expire after a
few hours without affecting anything.

### 11h–12h — manual QA day

Hit the QA cloud at https://qa.web.kodus.io as a real user. Exercise the features
that landed during the week — anything automation can't reach (UX feel, weird flows,
new integrations from the perspective of a customer signing up cold). The
matrix tells you "does it boot", QA day tells you "does it feel right".

### ~12h30 — checkpoint

Open the run in Actions. The `promote` job should be paused with a
**"Review deployments"** banner. The matrix is finished (and was already
finished hours ago).

### 13h — approve (the one click)

1. Click the **promote** job
2. Click **Review deployments** → check ☑ `production` → **Approve and deploy**
3. From here it's automatic (~5 min):
   - retag rc → `:X.Y.Z` + `:latest` on GHCR
   - push git tag `selfhosted-X.Y.Z`
   - create GitHub Release (this triggers cloud prod deploys via `release:published`)
   - `cli-release`, `changelog-publish`, `env-sync-installer`, `trigger-installer-e2e`,
     `cleanup-rc-tag` (all parallel)
   - `unfreeze-main` runs at the end → main accepting PRs again

### 13h30 — confirm

Customer should be receiving the new version on both cloud (ECS rolling) and
self-hosted (next `docker pull :latest`).

Watch Discord and incident channels until 17h or so.

### If you need to abort mid-flight

- During build/matrix: top-right of the run → **Cancel run**. `unfreeze-main`
  fires via `if: always()` and main unfreezes.
- After clicking Approve: it's too late. Promote is fast. If something looks
  wrong after promote, it's hotfix territory.

---

## Hotfix — emergency procedure

### When to use it

Only when one of these is true:

- 🔒 Authentication is broken (customers cannot log in)
- 💀 Data loss or corruption is happening
- 🚨 Active security incident (breach, leak)
- 🔥 Service is down for >50% of customers
- 💸 Billing is broken (wrong charges, duplicates)

Everything else **waits for next Friday**. Do not negotiate "kind of P0".

### Procedure

1. Land the fix in `main` as fast as is responsible (still goes through PR + review).
2. Open https://github.com/kodustech/kodus-ai/actions/workflows/selfhosted-build-push.yml
3. **Run workflow** with **`hotfix`: ☑ true**.
4. The pipeline runs the same as Friday **except**:
   - `freeze-main` is skipped (main stays open — you may need follow-up fixes)
   - `promote` uses env `production-hotfix` (no required reviewers → ships as soon as matrix passes)
5. End-to-end: ~1 hour.

There is no human gate inside the hotfix run. The matrix is the only quality gate.

---

## Code freeze (release-freeze ruleset)

A Repository Ruleset named **`release-freeze`** (id `17004627`) lives in repo
settings, default state `enforcement=disabled`. The Friday release flips it
to `active` at the start and back to `disabled` at the end. While active,
the ruleset requires every PR to `main` to have a green
**`release-freeze-eligible`** status check.

That status check is posted by `.github/workflows/release-freeze-check.yml`
based on the PR title's Conventional Commits type:

| PR title prefix | Status | Can merge during freeze? |
|---|---|---|
| `chore:` `ci:` `docs:` `build:` `test:` `style:` | ✓ success | Yes — exempt (not user-facing, no runtime impact) |
| `feat:` `fix:` `perf:` `refactor:` | ✗ failure | No — touches runtime, wait for unfreeze or admin bypass |
| Anything else | ✗ failure | Fix the title (also caught by `pr-title-check.yml`) |

Why `refactor` is blocked: although the convention treats it as "hidden from
changelog", a refactor in `libs/code-review/` etc. can still change runtime
behaviour. Conservative default; admin can bypass if truly safe.

**Bypass**: any repo Admin (currently malinosqui, Wellington01, sartorijr92,
jairo-litman) can click **"Bypass and merge"** on any PR — including
`feat`/`fix`/`perf`/`refactor` PRs they judge safe to land mid-release. The
bypass is logged in repo Insights → Rule insights.

**Failsafe** (if the runner dies mid-release with the freeze still active):

```bash
gh api -X PUT repos/kodustech/kodus-ai/rulesets/17004627 \
  --input <(jq '.enforcement="disabled"' <(gh api repos/kodustech/kodus-ai/rulesets/17004627))
```

---

## Local testing

Three layers, escalating in cost and coverage. Each has its own README with
detailed env vars, secrets, and edge cases — links below.

| What | Command | Time | Cost | Use when |
|---|---|---|---|---|
| Dry-run | `yarn e2e:dry-run` | seconds | $0 | After changing scenarios/providers/runner. Validates wiring without hitting providers. |
| Smoke | `yarn e2e:smoke` | ~3 min | $0 (reuses your droplet) | Before pushing — confirm one combo passes end-to-end. |
| Matrix | `yarn e2e:matrix` | ~30–45 min | ~$1–2 | Before a release branch. Catches cross-provider regressions. |

- Local runner details: [`scripts/e2e/README.md`](../scripts/e2e/README.md)
- Suite architecture: [`tests/e2e/README.md`](../tests/e2e/README.md)
- Local self-hosted dev VM (for smoke / manual): [`scripts/selfhosted/README.md`](../scripts/selfhosted/README.md)
- Benchmark (model code-review quality): [`tests/e2e/benchmark/`](../tests/e2e/benchmark/) + `scripts/benchmark/`

### Matrix tiers

- `tests/e2e/matrix/fast.yml` — 7 scenarios × 13 cells (~30–45 min, ~$1–2). What
  the e2e-cloud workflow runs continuously per merge.
- `tests/e2e/matrix/full.yml` — fast + 4 lifecycle scenarios (upgrade N-1→N,
  SSO cookie-domain, SSO multi-user, Stripe billing). What the Friday release
  matrix runs (~75–120 min, ~$3–5). Strict superset of fast.yml.

Both are the **single source of truth**. CI reads scenarios/cells directly from
them — adding a scenario to fast.yml automatically reaches CI.

---

## Discord notifications

Two channels, one private, one public.

| Webhook secret | Channel | Audience | What goes there |
|---|---|---|---|
| `DISCORD_WEBHOOK_INTERNAL` | private (team only) | Devs + founders | Everything operational: CI/PR test failures, QA deploys (backend/web/mcp), `e2e-cloud` per-deploy + nightly failures, `e2e-self-hosted-matrix` failures, model benchmark failures, SH release pipeline failures, cloud prod deploy success + failure |
| `DISCORD_WEBHOOK_COMMUNITY` | public (Kodus community) | Customers, prospects | Only the changelog published per self-hosted release — cloud + SH ship the same image, so one announcement covers both audiences |

The split is sharp because the audiences don't overlap: customers don't
need to know QA was flaky, and devs don't need a separate copy of the
release notes.

**Graceful fallback chain**:

| Use case | Webhook resolution |
|---|---|
| Composite action `discord-notify` (most workflows) | `DISCORD_WEBHOOK_INTERNAL ?? DISCORD_WEBHOOK` |
| `selfhosted-build-push.yml notify-discord-failure` | `DISCORD_WEBHOOK_INTERNAL ?? DISCORD_WEBHOOK_SELFHOSTED ?? DISCORD_WEBHOOK` |
| `publish-changelog.ts` (community announcement) | `DISCORD_WEBHOOK_COMMUNITY ?? DISCORD_WEBHOOK_SELFHOSTED ?? DISCORD_WEBHOOK` |

Until you create the two new secrets, every notification routes to the
historical `DISCORD_WEBHOOK_SELFHOSTED` / `DISCORD_WEBHOOK` channels — so
nothing goes silent. When you create `DISCORD_WEBHOOK_INTERNAL` and
`DISCORD_WEBHOOK_COMMUNITY`, routing shifts automatically.

**Setup to fully activate**: in Discord, create webhooks for each
channel, then:

```bash
gh secret set DISCORD_WEBHOOK_INTERNAL  -R kodustech/kodus-ai --body '<url for team channel>'
gh secret set DISCORD_WEBHOOK_COMMUNITY -R kodustech/kodus-ai --body '<url for community channel>'
```

After that, `DISCORD_WEBHOOK` and `DISCORD_WEBHOOK_SELFHOSTED` are
deprecated — kept as fallbacks during transition but no new workflows
should reference them.

## Troubleshooting

### Matrix cells fail with "Repo X not in integration's available list"

The cloud target tenant doesn't have the right repo registered in its provider
integration. This is a tenant state issue, not a workflow bug. Re-seed:

```bash
yarn cloud:setup-tenants   # idempotent, signs up + onboards if missing
```

Check `~/.kodus-dev/cloud-tenants.json` afterwards — every row should have
`registered: true` and `onboardingFinished: true`.

### Matrix cells fail with "Pipeline ack but 0 findings"

Almost always [`project_qa_mongo_quota`] — Atlas free 512MB is over. Reviews
ack at the queue level but writes to the findings collection fail silently.

Confirm by checking the Atlas dashboard. Mitigate by purging old review
documents or upgrading the Atlas plan.

### Promote job is paused but nobody got notified

GitHub doesn't email by default. Set up:

- GitHub mobile app push notifications (Settings → Notifications → Deployment review)
- Or a workflow that pings Discord when the job hits the gate

### Freeze didn't lift after a failed release

The `unfreeze-main` job has `if: always()` and runs whenever `freeze-main` ran.
If it didn't fire (runner died mid-flight), use the failsafe command in the
freeze section above.

### Hotfix bypassed something it shouldn't have

The hotfix path skips `freeze-main` and the human gate at `promote`, but it
**does not** skip the matrix. If the matrix doesn't catch a regression, the
hotfix ships it. The matrix is the only gate that remains, so it must stay
green.

---

## References

- Workflows: [`.github/workflows/`](../.github/workflows/)
  - Friday release dispatch: `selfhosted-build-push.yml`
  - Matrix called by release: `e2e-self-hosted-matrix.yml`
  - Promote (retag + GitHub Release): `selfhosted-promote.yml`
  - Cloud matrix (continuous QA): `e2e-cloud.yml`
  - Backend deploy (per merge): `qa-build-push-and-pr-green.yml`
  - Cloud prod fan-out (triggered by `release:published`):
    `prod-build-push-and-pr-green.yml`, `web-build-push-production.yml`,
    `prod-mcp-manager-deploy.yml`
  - Model benchmark: `code-review-model-benchmark.yml`
- Matrix definitions: [`tests/e2e/matrix/fast.yml`](../tests/e2e/matrix/fast.yml),
  [`full.yml`](../tests/e2e/matrix/full.yml)
- Visual diagram: [`docs/diagrams/ci-flow-files.excalidraw`](../docs/diagrams/ci-flow-files.excalidraw)
- Older release-flow notes (historical): [`docs-internal/release-quality-gates.md`](release-quality-gates.md)
