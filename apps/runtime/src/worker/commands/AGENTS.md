# apps/runtime/src/worker/commands

One handler per command the product sends through the outbox: they turn a parsed message into a store write, a hub push or a call on the workflow engine. They run in the runtime-worker, behind `worker/consumer`, and are the application layer between the broker and DBOS; the API never writes the Runtime database, so these handlers are where its commands land.

## Owns
- The handler list and its wiring: `runtime-command-handlers.ts` `runtimeCommandHandlers` (one handler per event) and `runtimeCommandHandlersProvider` (every dependency injected, so a lost provider fails at boot).
- Run requests: `run-requested.handler.ts` `RunRequestedHandler` registers the delivery with the PR generation fence, under the per-PR lock (`prLockKey`), supersedes live Runs of older heads, keeps one live Run per org, repo, PR, SHA and environment, refuses when the org is stopped, writes the `queued` projection and calls `engine.start`.
- What a Run boots with: `RunRequestedHandler.withRecordedRecipe` replaces the request's recipe, expose list, size and ready check with the environment setup's record (default branch, of the primary repository); a store that cannot be read fails the message.
- `RunCancelRequestedHandler`: a cancel (`pr_closed`, or `superseded` keeping one head) fences the PR's generation and stops the live Runs it may cancel; after the Runs it hands `SuiteCancelPort.cancelPullRequest` (`worker/suite/suite-canceller.ts`) the PR and, for a new head, the head to keep: the PR's running CI-mode suites for another head (all of them when it closed) are cancelled, and a failure there never fails the Runs' cancel; a closed PR also forgets its sessions and ends its previews. It needs the delivery's `messageId`.
- `command-handlers.ts`: `ForkApprovedHandler` (bound to the Run's own head and org), `EgressApprovedHandler`, `EgressRevokedHandler`, `EgressSettingsChangedHandler`, `MachineMinutesChangedHandler` (the org's own daily machine minutes, newest change wins), `StopRequestedHandler`, `StopClearedHandler`, `EnvironmentSetupRequestedHandler` (seals a plain token, then only enqueues), `EnvironmentPoolRequestedHandler`, `CellTokenIssuedHandler`, `CellTokenRevokedHandler`, `CellRevokeRequestedHandler`, `LessonUpdateRequestedHandler`.
- `organization-purge.handler.ts` `OrganizationPurgeRequestedHandler` (`runtime.organization.purge_requested`): cancels the organization's live Runs (`engine.stop`), releases its live claims through the hub, and once none is live deletes its evidence (`{orgId}/`) and every Runtime Postgres row; while a Run or claim is still live it throws, so the control lane retries it with a delay. After the claims and before the evidence it asks the connected cells to remove the organization's data at rest (`CellDataPurger`, `HubCellDataPurger` over the hub's `POST /internal/organizations/:id/cell-data-purge`) and throws `OrganizationPurgeNotReadyError` with `cellsPending` until each has acknowledged; a cell that is offline is not waited for.
- `suite-baseline-skipped.handler.ts` `SuiteBaselineSkippedHandler` (`runtime.suite.baseline_skipped`, control lane): the product found a queued baseline request cannot run (no suite at its commit); the request ends `skipped` with the reason (`PgSuiteBaselineRequests.markSkipped`).
- `suite-selection-changed.handler.ts` `SuiteSelectionChangedHandler` (`runtime.suite.selection_changed`, control lane): a person's on lifts the shadow check's brake and starts its window afresh (`PgSuiteSelectionState.reenable`), off makes every PR run the whole suite (`turnOff`); the state write names the organization again.
- `suite-requested.handler.ts` `SuiteRequestedHandler` (`runtime.suite.requested`): validates the request and hands it to the `SuiteStarter` port (`start`), returning without waiting; in production the starter is `RunEngine.startSuite` (the `runtime.suite` workflow). `suite-retried.handler.ts` `SuiteRetriedHandler` (`runtime.suite.retried`): a retry of one shard or of every spec that did not pass in the first pass is a new suite run of the same commits limited to those specs (`RuntimeSuiteRequested.specs`), under an id derived from the retry's key; it needs the original run to have ended and the tokens the product sends with the retry. Both are registered when `CommandHandlerDeps.suites` is given (the retry also `suiteRuns`), which the production provider always does.
- The engine port the handlers call: `run-engine.port.ts` `RunEngine`.

## Does not own
- Lanes, envelopes, dead-lettering and broker retry: `worker/consumer`.
- Workflows: `worker/dbos/run-engine.service.ts`. The PR generation records: `shared/admission/pr-admission-store.ts`. Stops, approvals, cell tokens and revocations in Postgres: `shared/persistence/pg-command-store.ts`.
- Pushing an allowlist or a pool size to a cell: `worker/env/hub-environment-runtime.ts` (`HubEgressPolicyPusher`, `HubPoolTargetSender`).

## Rules and limits
- A handler never waits on a workflow: `engine.stop` and `engine.start` return once DBOS holds the work ([apps/runtime/AGENTS.md](../../../AGENTS.md) "Workflow code (DBOS)").
- A malformed message returns `{ invalid, detail }`, which the consumer dead-letters; a store that cannot be read throws, so the message is retried.
- Slow setup reads run outside the PR lock; the fence is checked again under the lock before any effect.
- Every command is scoped by its org: a fork approval must match the Run record, a pool size only goes to the cell of that org's last setup, a lesson or a token of another org is left alone ([apps/runtime/AGENTS.md](../../../AGENTS.md) "Tenant scope").
- Size, ready check and authored recipe files never come from the request, only from the setup record (S-19).
- Ending previews is best effort: a failure is logged and the Run never waits on it.

## Where new code goes
- A new command: a class implementing `CommandHandler` in `command-handlers.ts` (or its own file when it is as large as the Run handler), added to `runtimeCommandHandlers`, its dependency to `CommandHandlerDeps` and the provider's `inject`, its lane in `libs/runtime/contracts/runtime-commands.ts`, a case in `commands.spec.ts`.

## Tests
- `API_NODE_ENV=test npx jest apps/runtime/src/worker/commands` (in-memory stores and locks; `runtime-command-handlers.spec.ts` boots the Nest wiring).

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (8, tests apart): `command-handlers.ts`, `organization-purge.handler.ts`, `run-engine.port.ts`, `run-requested.handler.ts`, `runtime-command-handlers.ts`, `suite-requested.handler.ts`, `suite-retried.handler.ts`, `suite-selection-changed.handler.ts`

Imports these Runtime modules:

- [`apps/runtime/src/shared`](../../shared/AGENTS.md)
- [`apps/runtime/src/shared/admission`](../../shared/admission/AGENTS.md)
- [`apps/runtime/src/shared/evidence`](../../shared/evidence/AGENTS.md)
- [`apps/runtime/src/shared/persistence`](../../shared/persistence/AGENTS.md)
- [`apps/runtime/src/worker/dbos`](../dbos/AGENTS.md)
- [`apps/runtime/src/worker/env`](../env/AGENTS.md)
- [`apps/runtime/src/worker/evidence`](../evidence/AGENTS.md)
- [`apps/runtime/src/worker/preview`](../preview/AGENTS.md)
- [`apps/runtime/src/worker/run`](../run/AGENTS.md)
- [`apps/runtime/src/worker/sandbox`](../sandbox/AGENTS.md)
- [`apps/runtime/src/worker/secrets`](../secrets/AGENTS.md)
- [`apps/runtime/src/worker/setup`](../setup/AGENTS.md)
- [`apps/runtime/src/worker/suite`](../suite/AGENTS.md)
- [`libs/runtime/contracts`](../../../../../libs/runtime/contracts/AGENTS.md)
- [`libs/runtime/protocol`](../../../../../libs/runtime/protocol/AGENTS.md)
- [`libs/runtime/run`](../../../../../libs/runtime/run/AGENTS.md)
- [`libs/runtime/telemetry`](../../../../../libs/runtime/telemetry/AGENTS.md)

Imported by:

- [`apps/runtime/src/worker`](../AGENTS.md)
- [`apps/runtime/src/worker/consumer`](../consumer/AGENTS.md)

<!-- module-map:end -->
