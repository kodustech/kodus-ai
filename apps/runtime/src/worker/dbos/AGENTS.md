# apps/runtime/src/worker/dbos

The runtime-worker's engine: it registers the DBOS workflows and queues, starts, stops and approves them, and runs the per-cluster maintenance tick. It runs in the runtime-worker and is the boundary between the broker handlers (`worker/commands`) and the workflow code (`worker/run`, `worker/setup`), which it calls with a `step` built on `DBOS.runStep`.

## Owns
- Workflow registration and launch: `run-engine.service.ts` `RunEngineService.onModuleInit` registers `runtimeRun`, `runtimeForkGate`, `runtimeRunStop`, `runtimeEnvironmentSetup` (when a setup service is wired), `runtimeSuite` (its `suite:run` step reads the step's cancel signal; `cancelSuite` cancels it, so the engine stops its commands and releases its claims and demand) (when a suite service is wired: `startSuite`, workflow id `suite:<suiteRunId>`, queue `runtime-suites` partitioned by org, `RUNTIME_SUITE_PER_ORG` and `RUNTIME_SUITE_CONCURRENCY`; a suite does not go through durable admission, its hosts are fleet demand) and `runtimeAdmission` (durable admission), sets `applicationVersion` from `RUNTIME_RELEASE_VERSION`, and declares the queues.
- Queues and workflow ids: `queue-limits.ts` `queueRegistrations` sizes them and polls the machine-work queues every `MACHINE_QUEUE_POLL_MS` (5 s) (limits clamped to each queue's global one, which DBOS requires; `RUNTIME_WORKER_CONCURRENCY` per replica): `RUN_QUEUE` and `SETUP_QUEUE` partitioned by org (`RUNTIME_ORG_CONCURRENCY`, `RUNTIME_SETUP_PER_ORG`, `RUNTIME_SETUP_CONCURRENCY`), or `EXECUTION_QUEUE`, `ADMISSION_QUEUE`, `ADMISSION_FINALIZE_QUEUE` with durable admission; the sweep asks DBOS about the workflows of the live Runs in batches (`SWEEP_BATCH`); `workflowID = runId` for a Run, `approvedRunWorkflowId`, `setupWorkflowId`, `admissionAttemptWorkflowId`. One live setup per environment: a setup whose workflow id is `setup:<environmentId>:<requestedAt>` first waits (step `setup:turn`, `waitForEarlierSetups`) for every earlier running setup of that environment; a still-queued earlier one never holds it back (it could hold the slot the running one needs). The same step answers `setupTurn` (`setup-turn.ts`): an earlier setup that starts after a newer one already runs or ended is superseded and ends without building or writing a record (`{ superseded: true }`), and the store drops a save whose `requestedAt` is older than the row's (`pg-environment-setup.store.ts`). The step is new in the workflow, so ship it with a new `RUNTIME_RELEASE_VERSION`.
- Entry points the handlers call (`commands/run-engine.port.ts` `RunEngine`): `start`, `startSetup`, `approve` (sends on `APPROVAL_TOPIC`), `stop` (cancels, then starts the stop workflow and returns); `status` and `result` read a Run workflow by runId.
- The step wrapper `dbosStep`: one try per step, except publish steps (`isPublishStep`), which retry with `PUBLISH_STEP_RETRY` for about ten minutes.
- Maintenance: `RunEngineService.maintenanceTick` every 15 s under the `runtime-worker/maintenance` lock: `repairAdmission`, `sweep` (`runPastLimit`, `queuedPastLimit`), the reaper, hourly retention (the Runtime schema's, then DBOS's own history), then the stuck pass (`worker/maintenance`).
- DBOS history retention: `shared/persistence/workflow-retention.ts` `pruneWorkflowHistory` (shared with the fleet's own history) deletes terminal workflows (`TERMINAL_WORKFLOW_STATUSES`) created more than 30 days ago, with their inputs and step outputs, in batches of 100 and at most 20 pages and 30 s per hourly pass (`WORKFLOW_RETENTION_DEFAULTS`, overridable through `RUN_ENGINE_WORKFLOW_RETENTION`), never one whose Run is live in the projection (its own id, `:run`, `:stop`).
- The Run's dependencies: `run-deps.factory.ts` `RunDependenciesFactory` (`forRun`, `forStop`, `envForSetup`, `envForSuite`, `envForSession`, `reap`), `hubEnvironments`, `poolCellOf`, the canary-guarded LLM gateway and the lease keeper.
- Durable admission: `admission-coordinator.ts` `AdmissionCoordinator` (`begin`, `attempt`, `finish`, `cleanupTicket`) over the admission store and the cells' physical tickets.

## Does not own
- What a Run or a setup does, step by step: `worker/run/run-orchestrator.ts` (`runRuntimeRun`, `awaitForkApproval`, `finalizeStoppedRun`), `worker/setup/environment-setup.service.ts`.
- Parsing commands and the per-PR start and supersede decision: `worker/consumer`, `worker/commands`.
- The admission records and limits: `shared/admission`. The hub client: `worker/env`.

## Rules and limits
- DBOS determinism, stable step ids, safe re-runs and never waiting on a workflow from a broker handler: [apps/runtime/AGENTS.md](../../../AGENTS.md) "Workflow code (DBOS)". The step order is part of the release: a change needs a new `RUNTIME_RELEASE_VERSION`.
- A fork never holds a queue slot while it waits: the gate runs off the queue and waits up to 7 days for an approval.
- `sweep` stops a live Run whose workflow was cancelled, errored or queued past 30 min, and one booting or testing past 45 min counted from when both sides had room (`runPastLimit`, ADR-070). A queued projection with no workflow behind it is finalized `errored` only past the queue limit plus 5 min (`queuedPastLimit`).
- The stuck pass only reports; it never acts.
- A workflow id is idempotent only while DBOS keeps the workflow: `start` answers a Run already final from the projection, so a request redelivered after retention never runs it again. Retention refuses an age under 8 days (a fork's gate waits 7).
- Durable admission (`RUNTIME_DURABLE_ADMISSION`) is opt-in and changes which queues exist; `onModuleInit` refuses to start without the coordinator.

## Where new code goes
- A new workflow: registered in `RunEngineService.onModuleInit`, its entry point on `RunEngine` (`worker/commands/run-engine.port.ts`), a case in `run-engine.integration.spec.ts`.
- A new dependency of a Run: a field of `RunDeps` (`worker/run/ports.ts`), built in `RunDependenciesFactory.forRun`, wired in `worker/runtime-worker.module.ts`.
- New maintenance work: a call inside `maintenanceTick`, bounded per tick.

## Tests
- Unit: `API_NODE_ENV=test npx jest apps/runtime/src/worker/dbos` (`run-engine.*.spec.ts`, `run-deps.factory.spec.ts`, `admission-coordinator.spec.ts`).
- DBOS on Postgres: `run-engine.integration.spec.ts`, `setup-workflow.integration.spec.ts`, `admission-workflow.integration.spec.ts`, `release-version.integration.spec.ts`, with `RUNTIME_IT_DATABASE_URL` and `--runInBand`.

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (5, tests apart): `admission-coordinator.ts`, `queue-limits.ts`, `run-deps.factory.ts`, `run-engine.service.ts`, `setup-turn.ts`

Imports these Runtime modules:

- [`apps/runtime/src/shared`](../../shared/AGENTS.md)
- [`apps/runtime/src/shared/admission`](../../shared/admission/AGENTS.md)
- [`apps/runtime/src/shared/evidence`](../../shared/evidence/AGENTS.md)
- [`apps/runtime/src/shared/persistence`](../../shared/persistence/AGENTS.md)
- [`apps/runtime/src/worker`](../AGENTS.md)
- [`apps/runtime/src/worker/agent`](../agent/AGENTS.md)
- [`apps/runtime/src/worker/canary`](../canary/AGENTS.md)
- [`apps/runtime/src/worker/env`](../env/AGENTS.md)
- [`apps/runtime/src/worker/intent`](../intent/AGENTS.md)
- [`apps/runtime/src/worker/maintenance`](../maintenance/AGENTS.md)
- [`apps/runtime/src/worker/run`](../run/AGENTS.md)
- [`apps/runtime/src/worker/secrets`](../secrets/AGENTS.md)
- [`apps/runtime/src/worker/setup`](../setup/AGENTS.md)
- [`apps/runtime/src/worker/suite`](../suite/AGENTS.md)
- [`libs/runtime/canary`](../../../../../libs/runtime/canary/AGENTS.md)
- [`libs/runtime/contracts`](../../../../../libs/runtime/contracts/AGENTS.md)
- [`libs/runtime/environment`](../../../../../libs/runtime/environment/AGENTS.md)
- [`libs/runtime/protocol`](../../../../../libs/runtime/protocol/AGENTS.md)
- [`libs/runtime/run`](../../../../../libs/runtime/run/AGENTS.md)
- [`libs/runtime/telemetry`](../../../../../libs/runtime/telemetry/AGENTS.md)

Imported by:

- [`apps/runtime/src/worker`](../AGENTS.md)
- [`apps/runtime/src/worker/commands`](../commands/AGENTS.md)
- [`apps/runtime/src/worker/persistence`](../persistence/AGENTS.md)
- [`apps/runtime/src/worker/suite`](../suite/AGENTS.md)

<!-- module-map:end -->
