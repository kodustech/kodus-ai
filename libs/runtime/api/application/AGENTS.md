# libs/runtime/api/application

The application layer of the product's Runtime API: the services the use cases share (building and enqueuing a Run, requesting a setup, access checks, sealing, budgets, costs, the webhook reconciler, the /mcp/env tools, external findings). Nest injectables over the ports of `../domain/`, run in the product API and the product worker. The use cases themselves are in `use-cases/` ([its AGENTS.md](use-cases/AGENTS.md)); Kody's recipe author is in `recipe-author/` ([its AGENTS.md](recipe-author/AGENTS.md)).

## Owns
- The one builder of `RuntimeRunRequested`: `run-request-builder.service.ts` `RuntimeRunRequestBuilder` (diff and repo token from the Git API, Run token signed here, both sealed), used by the PR trigger, Run again, Run on this PR, fork approval and simulate.
- The one way a Run is enqueued: `runtime-run-enqueuer.service.ts` `RuntimeRunEnqueuer` (the publish target first, then the outbox row).
- Setup commands: `runtime-setup-requester.service.ts` `RuntimeSetupRequester` (recipe read and refused with the broken rule named, pool size and machine size under the plan).
- Baseline suite commands: `suite-baseline-requests.service.ts` `RuntimeSuiteBaselineRequests` (run on the pool scheduler's lock after the template setups): reads the queued baseline requests of the fleet (`RuntimeSuiteBaselineReader`, the read-only role; the worker marks a request started), checks the recipe at that commit still declares a suite with a baseline, mints one sealed download token per claim (the cell revokes a token once it fetched with it: the listing and each shard of the recipe's ceiling) and writes `runtime.suite.requested` under the request's `suiteRunId`.
- Shadow suite commands (build-plan step 19, D14): `suite-shadow-requests.service.ts` `RuntimeSuiteShadowRequests` (same pass as the baselines): reads the shadows of selected PR runs the worker recorded (`RuntimeSuiteShadowReader`, read-only; the worker marks one started), checks main's recipe still declares a suite, mints one sealed download token per claim (`RuntimeSuiteInputs.tokensFor`) and writes `runtime.suite.requested` of mode `shadow` under the shadow's id, with the PR's head, merge base and the files it changed and removed.

- The e2e suite's screens (docs/runtime/e2e-suites.md section 13): `suite-retrier.service.ts` `RuntimeSuiteRetrier` ("Re-run failed": mints one sealed token per claim like CI mode, stores the Run's publish target under the retry's id, then `runtime.suite.retried` of scope `failed`; the same minute is one retry) and `suite-selection.service.ts` `RuntimeSuiteSelection` (`runtime.suite.selection_changed` on or off through the outbox: the selection state is the Runtime's table and the product never writes it); the use cases are in `use-cases/suite.use-cases.ts`. `evidence-url.ts` `signedEvidenceUrlOf` signs a key the caller was already allowed to read (a step's evidence and a suite artifact).
- Suite inputs: `suite-inputs.service.ts` `RuntimeSuiteInputs`, shared by both modes: `changesOf` (the PR's changed files from the Git API diff, a rename as both paths, and the files it removes, a rename's old path included, which `CodeManagementRuntimeGitAdapter.getPullRequestDiff` names from the whole file list; none of either when the diff was cut), `standingOf` (where the PR stands against main by the platform's compare API, one call through `RuntimeGitPort.compareWithMain`, the count never the commits: the true merge base and `mainBehind`, the commits main is past it, cut at `SUITE_MAIN_BEHIND_MAX` 21, one past a baseline's 20-commit reach; a platform with no compare, unknown commits or a failing API give nothing and the caller keeps the PR's own base with no drift claimed; CI mode puts both in the command, a Run in its `suite` section) , `tokensFor` (one sealed download token per claim: the listing, each shard of the recipe's ceiling, the fresh host and the main host, bound to the command's key or the Run) and `forRun` (the whole `suite` section of a Run request: the setup's main commit, the files and the tokens; nothing when the environment was never set up or its recipe at that commit declares no suite). `RuntimeRunRequestBuilder` fills `RuntimeRunRequested.suite` with it for the environment's primary repository, never for a fork (its tokens would expire while it waits for a maintainer), an external finding's closed plan or a simulation.
- CI mode: `suite-requester.service.ts` `RuntimeSuiteRequester.requestCi` (the PR's head and files from the Git API, never the webhook; the template's commit from the environment's setup record as the main side; the recipe at that commit for how many claims, so how many sealed tokens (`suite-recipe.ts` `suiteOfRecipeAt`: the recipe's `shards` only when the customer committed it, `source: repository`; an environment recipe gets `SUITE_LIMITS.shards`, as the worker's `suiteConfigOf` does) (listing, each shard, the fresh host, the main host); the publish target stored under the suite run id, then `runtime.suite.requested` of mode `ci`; a fork, a draft, a closed PR, an environment with no suite or no setup is skipped and nothing is minted; the suite run id derives from the PR and the head, so a push asks once), `suite-ci-trigger.service.ts` `RuntimeSuiteCiTrigger` (called by the PR trigger after its own decision on opened, reopened, ready_for_review and synchronize; whether it runs is the environment's own `suiteCi` switch (Settings, e2e suite), and where that is null `RUNTIME_SUITE_CI=true` is the default, off otherwise; never throws), `suite-recipe.ts` `suiteOfRecipeAt`.
- Access: `run-access.service.ts` `RuntimeRunAccessService` (load the Run, then org, team and repo; another tenant's Run is 404), `egress-access.service.ts` `RuntimeEgressAccess`, `environment-members.service.ts` `RuntimeEnvironmentMembers`.
- Worker credentials: `runtime-worker-scope.ts` `verifyRuntimeWorkerToken`, `runtimeWorkerScope` (Run token, rechecked against the live Run on every call); `setup-token.ts` `openSetupToken`; `secret-sealer.ts` `sealForRuntime` (503 without the seal key).
- Model call budgets: `llm-run-budget.ts` `liveRunFor`, `withReservation`; `model-input-bytes.ts`.
- Costs and the warm pool: `run-cost.service.ts` `RuntimeRunCostService`, `pool-controller.service.ts` `RuntimePoolController`.
- Default-branch pushes: `default-branch-push-setup.service.ts` `RuntimeDefaultBranchPushSetup` (a push to the default branch of a repository in an environment asks for one setup of it, R6: Git API facts, coalesced and budgeted per environment through `PushSetupLedger`; never a PR, a fork, a tag or another branch).
- Lost webhooks: `webhook-reconciler.service.ts` `RuntimeWebhookReconciler` (hands the PR trigger a missed head; never decides a Run).
- The /mcp/env tools: `env-tools.service.ts` `RuntimeEnvToolsService` (team keys only); `env_blockers` carries the failed step and its output as evidence (`blockerGroups` with `fullEvidence`); `env_status` is `environmentHealthOf` over the org's setup record (read-only Runtime Postgres), never a cell call; `env_upload` passes the files to the worker (which keeps them as evidence and has the cell write them), audited with paths and sizes only and counted with `env_exec` in `ENV_EXEC_QUOTA` (`admit`). External findings and their verification: `external-findings.service.ts`, `external-verification-reconciler.ts`.
- Small shared rules: `asked-runs.ts` (one limit on Runs asked by hand), `recipe-inference.reader.ts`, `run-public-view.ts`, `failure-context.ts`.

## Does not own
- Ports and pure rules: `../domain/`. Adapters: `../infrastructure/`. HTTP routes: `apps/api/src/controllers/runtime/`.

## Rules and limits
- May import `../domain/`, `libs/runtime` pure modules, `libs/runtime-publish/domain` and product services (`AuthorizationService`); never `../infrastructure/` (the composition root binds adapters to ports).
- Every read and write is org-scoped through the ports, and object checks answer 404 across tenants ([`AGENTS.md`](../../AGENTS.md) "Facts and state").
- Nothing that carries a token is enqueued without `RUNTIME_SECRET_SEAL_KEY`; never log a token, a prompt or a platform error message.
- `runtime-run-enqueuer.service.ts`'s comment still says the PR trigger will use it "next"; the PR trigger already does.

## Where new code goes
- Logic two or more use cases share: a service here. Logic of one route: its use case.
- A new way to start a Run: through `RuntimeRunRequestBuilder` and `RuntimeRunEnqueuer`, never a hand-built message.

## Tests
- `API_NODE_ENV=test npx jest libs/runtime/api` (specs in `../__tests__/`, doubles in `../__tests__/fixtures.ts`).

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (32, tests apart): `asked-runs.ts`, `default-branch-push-setup.service.ts`, `egress-access.service.ts`, `env-tools.service.ts`, `environment-members.service.ts`, `evidence-url.ts`, `external-findings.service.ts`, `external-verification-reconciler.ts`, `failure-context.ts`, `llm-run-budget.ts`, `model-input-bytes.ts`, `pool-controller.service.ts`, `recipe-inference.reader.ts`, `run-access.service.ts`, `run-cost.service.ts`, `run-public-view.ts`, `run-request-builder.service.ts`, `runtime-run-enqueuer.service.ts`, `runtime-setup-requester.service.ts`, `runtime-worker-scope.ts`, `secret-sealer.ts`, `setup-token.ts`, `suite-baseline-requests.service.ts`, `suite-ci-trigger.service.ts`, `suite-inputs.service.ts`, `suite-recipe.ts`, `suite-requester.service.ts`, `suite-retrier.service.ts`, `suite-selection.service.ts`, `suite-shadow-requests.service.ts`, `template-setup-requests.service.ts`, `webhook-reconciler.service.ts`

Imports these Runtime modules:

- [`libs/runtime-publish/domain`](../../../runtime-publish/domain/AGENTS.md)
- [`libs/runtime/api/application/recipe-author`](recipe-author/AGENTS.md)
- [`libs/runtime/api/application/use-cases`](use-cases/AGENTS.md)
- [`libs/runtime/api/domain`](../domain/AGENTS.md)
- [`libs/runtime/blockers`](../../blockers/AGENTS.md)
- [`libs/runtime/contracts`](../../contracts/AGENTS.md)
- [`libs/runtime/environment`](../../environment/AGENTS.md)
- [`libs/runtime/placement`](../../placement/AGENTS.md)
- [`libs/runtime/probe`](../../probe/AGENTS.md)
- [`libs/runtime/protocol`](../../protocol/AGENTS.md)
- [`libs/runtime/redaction`](../../redaction/AGENTS.md)
- [`libs/runtime/run`](../../run/AGENTS.md)
- [`libs/runtime/suite`](../../suite/AGENTS.md)
- [`libs/runtime/telemetry`](../../telemetry/AGENTS.md)

Imported by:

- [`libs/runtime-publish/domain`](../../../runtime-publish/domain/AGENTS.md)
- [`libs/runtime/api`](../AGENTS.md)
- [`libs/runtime/api/application/use-cases`](use-cases/AGENTS.md)
- [`libs/runtime/api/infrastructure`](../infrastructure/AGENTS.md)
- [`libs/runtime/api/infrastructure/a2a`](../infrastructure/a2a/AGENTS.md)

<!-- module-map:end -->
