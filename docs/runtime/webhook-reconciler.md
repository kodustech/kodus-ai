# Lost-webhook reconciler

A pull request event that never reaches the product never becomes a Run. The reconciler is a periodic pass in the product worker that
hands the PR trigger an open PR whose head a webhook should have started a Run on and did not. It decides nothing
itself: the trigger reads the PR from the Git API and applies the same rules as for a webhook. Off by default.

Code: `libs/runtime/api/application/webhook-reconciler.service.ts` (the pass),
`libs/runtime/api/domain/webhook-reconciler.ts` (settings, ledger port),
`libs/runtime/api/infrastructure/runtime-webhook-reconciler.cron.ts` (schedule, lock),
`libs/runtime/api/infrastructure/typeorm-reconciled-heads.store.ts` (ledger),
migration `CreateRuntimeReconciledHeads2026111500000000` (product Postgres).

## Behaviour

- An open PR whose head has no Run in an automatic environment gets one Run, the one its webhook would have
  started (the trigger's derived Run id: a webhook that arrives late enqueues the same Run).
- A head is handed to the trigger once. A second tick, a restarted worker and a second replica find the head in
  `runtime_reconciled_heads` and hand nothing. Of two replicas claiming one head at once, one gets it (one
  `INSERT … ON CONFLICT` statement).
- A head with any Run in that environment is left alone, whatever the Run's state: a Run superseded, stopped or
  cancelled with its PR is never started again.
- Only environments that run without anyone asking: the primary's mode is `rules` and its setup is active. Members
  that trigger are listed with their environment. `on_request` and `off` repositories are never read.
- A PR not updated within the window (default 24 h) is left alone. The listing's `updatedAt` is the PR's last change of
  any kind, never earlier than its head's push, so such a head is older than the window. The floor is also the
  settings row's last save and the setup's activation: a PR last updated before the mode or the environment was on
  would not have run from a webhook either. A head older than the window can still be handed when something else
  (a comment, a label) touched its PR within the window; the trigger then decides as for a push.
- A PR updated within the grace (default 10 min) is left to its webhook, which may still be on its way.
- A draft is left alone without a ledger row, so it is handed once it is ready.
- The trigger's own rules still decide after the hand-over: fork policy (a fork's default is a Run held for a
  maintainer's approval, as from a webhook), rules, agent authors, new pushes. A head the trigger skips is not
  handed again.
- A trigger call that throws leaves the head to a later tick, at most 3 attempts in all; a claim nobody settled is
  taken over after 15 minutes.
- An org whose Runtime is stopped, or whose stop cannot be read, is not read.
- At most 2 PRs per org and 10 per tick are handed, and 100 repositories listed per tick. Admission, org concurrency
  and machine-minute budgets apply to the Run as to any other. Reconciled Runs are `pull_request` Runs: they do not
  count towards the 10 Runs asked by hand per PR per day, as a webhook's do not.

## Platforms

The pass reconciles only platforms whose webhook handler writes Runtime pull request events: today GitHub
(`githubPullRequest.handler.ts`). On the others no webhook ever starts a Run, so there is nothing lost to make up
for; reconciling them would make the reconciler their trigger. What each listing gives, for when their handlers write
Runtime events (`CodeManagementService.getPullRequests`, one paginated call per repository, state open):

| Platform | Full head SHA in the list | Draft | `updated_at` | Ready to reconcile |
|---|---|---|---|---|
| GitHub | yes (`head.sha`) | yes | yes | yes (on) |
| GitLab | yes (`diff_refs.head_sha` or `sha`) | yes | yes | once its handler writes Runtime events |
| Forgejo | yes (`head.sha`) | yes | yes | once its handler writes Runtime events |
| Bitbucket Data Center | yes (`fromRef.latestCommit`) | — | yes | once its handler writes Runtime events |
| Bitbucket Cloud | no: the list abbreviates `source.commit.hash` (the adapter drops it) | yes | yes | needs one PR read per candidate |
| Azure Repos | yes (`lastMergeSourceCommit`) | yes | no: the creation date for an open PR | needs another freshness source |

A platform service that fails logs and returns an empty list: the pass then hands nothing for that repository.

## Settings (product worker)

| Name | Default | Meaning |
|---|---|---|
| `RUNTIME_WEBHOOK_RECONCILER_ENABLED` | unset (off) | `true` turns the pass on |
| `RUNTIME_CRON_WEBHOOK_RECONCILER` | `*/10 * * * *` | Interval |
| `RUNTIME_WEBHOOK_RECONCILER_WINDOW_MINUTES` | 1440 (max 10080) | PRs updated longer ago are left alone |
| `RUNTIME_WEBHOOK_RECONCILER_GRACE_MINUTES` | 10 | PRs updated more recently are left to their webhook |
| `RUNTIME_WEBHOOK_RECONCILER_PER_ORG_PER_TICK` | 2 | PRs handed per org per tick |
| `RUNTIME_WEBHOOK_RECONCILER_PER_TICK` | 10 | PRs handed per tick, all orgs |
| `RUNTIME_WEBHOOK_RECONCILER_REPOSITORIES_PER_TICK` | 100 | Repositories listed per tick |

## Counts

Each tick logs `Runtime reconciler: tick` with `organizations`, `repositories`, `pullRequests`, `handed`, `started`
and `skipped` by reason; each handed head logs its outcome. Counters `runtime.reconciler.started`,
`runtime.reconciler.handed{outcome}` and `runtime.reconciler.skipped{reason}` are recorded, but the product worker
registers no meter provider yet ([observability.md](observability.md)): until it does, the log lines are the counts.
`SELECT outcome, count(*) FROM runtime_reconciled_heads GROUP BY 1` gives the same per outcome (30 days kept).
