# apps/runtime/src/worker/run

The body of a Run: the DBOS workflow code that boots base and PR, plans probes, replays them round by round, classifies intent, decides the verdict and asks the product to publish. It runs in the runtime-worker, started by `worker/dbos/run-engine.service.ts`; it is a use case over ports (`ports.ts` `RunDeps`), and reaches cells only through `EnvironmentRuntime` (`libs/runtime/environment`). The sequence is in [apps/runtime/README.md](../../../README.md) "A Run, end to end".

## Owns
- The workflow: `run-orchestrator.ts` `runRuntimeRun` (`startRun`, `endBeforeBoot`, `bootSides`, `settleBoot`, `testSides`, `reportVerdict`, `finishRun`), the fork gate `awaitForkApproval` and `finalizeStoppedRun` for a stopped Run. `QUEUE_TIMEOUT_MS` (30 min, the default of `RunDeps.queueTimeoutMs`, RUNTIME_QUEUE_TIMEOUT_MS) and `RUN_TIMEOUT_MS` (45 min).
- Boot: `acquireRequest` (carries the Run's canaries, derived again on every replay, and the Run's drawn identity, `run-identity.ts` `runIdentityOf`: an HMAC of the runId under the runToken, the same on both sides, S-36), `bootBoth` (base first, `BASE_FIRST_MAX_MS`), waiting for room on a cell (ADR-070; at most `RunDeps.capacityWaitMaxMs`, RUNTIME_CAPACITY_WAIT_MAX_MS, then `timed_out` with the last refusal as the projection's `bootFailure`, `waitedPastBudget`), one more try per side on a lost cell, the image pin from the acquired manifests, `releaseClaims`.
- Planning while the PR boots: `early-plan.ts` (the plan step and the base's first rounds, `FirstBaseRounds`); reusing a past accepted plan: `plan-reuse.ts` `planReuseKey`, `StepPastPlans`; an external finding's closed plan: `external-verification.ts` `externalVerificationPlan`.
- Replay: `replay.ts` (base twice and PR once per probe, plus the gate's extra rounds; `runBatch` plays base and PR side by side; `playFirstBaseRound`; browser probes on a fixed clock), `probe-fields.ts` `toGateStep`.
- Stability history (ADR-050): `run-orchestrator.ts` `replayProbes` reads it in one step (`stability:read`) before the first replay and records each probe's outcome in one step (`stability:record`) after the last verdict, only when `RunDeps.stability` is wired; every verdict carries `normalizerVersion` and `stabilityPolicy`. Port `ports.ts` `StabilityHistory`; Postgres store `pg-stability-history.ts` (`runtime.runtime_stability`, org + environment + probe key, 90 days).
- Kept checks (docs/runtime/kept-checks.md): `kept-checks.ts` `playKeptChecks`, called by `run-orchestrator.ts` `replayKeptChecks` after the plan's probes and before intent, only when the request carries `keptChecks`: one `kept:start` step, one `kept:<n>:budget` step per check (`KEPT_CHECKS_BUDGET_MS`), each check replayed as `kept:<id>` at the indexes after the plan's, with the default stability policy and never written to the stability history. `keptOutcomesOf` settles each outcome after intent; `decideRunVerdict` gets `keptChecksNotRun`; the `verdict` step writes the projection's `keptChecks`; `kept:record` writes the results (port `ports.ts` `KeptCheckResults`, store `pg-kept-check-results.ts`, `runtime.runtime_kept_check_results`), never for a simulation.
- The intent oracle (docs/runtime/intent-oracle.md): `run-orchestrator.ts` `authorIntent` (step `intent:author` after the plan, only with the request's `intentChecks` not false, an HTTP target and a description or linked task) and `replayIntentProbes` after the kept checks (`phase:intent_probes`): the author gets the planner's requests to the diff's routes as templates (`requestTemplatesOf`); an intent probe whose request a planned probe sent is not played again and may only make that probe a `described_change`, and the rules over response fields of the intent probes of a planned probe's route may explain it too (gate `statedIntentChecksFor`); any other plays at index `plan + keptChecks + n` with the default stability policy and never enters the history. The `verdict` step writes the projection's `intentChecks`; `report.ts` builds the report's `intent`.
- The e2e suite as a stage (docs/runtime/e2e-suites.md sections 10.2 and 12): `run-orchestrator.ts` `startSuiteStage`, called right after `endBeforeBoot` and before `bootSides`, so the suite runs beside the Run's boot, probes and intent phases; `reportVerdict` joins it (`joinSuiteStage`) before the exercised lines. Only for a request that carries `suite`, on a worker whose `RunDeps.suite` (`ports.ts` `SuiteStage`) is set. DBOS-safe by construction: the whole stage is ONE step (`suite:stage`) started at a fixed place, like the early plan; the suite's own steps run inside it as plain calls (`suiteInnerStep`, publish steps retried), never as steps of the Run, so their timing cannot reorder the Run's step ids. A stage that throws (a cancellation aside) is a suite that did not run (`unavailable`), recorded by the step. A Run that ends before its verdict, or halts, aborts the stage (`stopSuiteStage`, in the `finally`) and waits for it; its result is dropped. `suiteVerdictParts` turns the result into findings of kind `e2e_regression`, `suiteUnclassified` and `suiteNotRun`, which `decideRunVerdict` reads: a regression is the verdict `regression`, an undecided or missing suite makes a green Run `partly_tested`. The stage's `deadlineAt` is the Run's start plus the 45 minutes (`RUN_TIMEOUT_MS`) less `SUITE_STAGE_MARGIN_MS` (5 min); its `cancellationSignal` combines `deps.cancellationSignal` (a stopped Run, a newer push) with the Run's own abort.
- The structured result: `report.ts` `buildReport`, `uncoveredOf`, `bootBlockerOf`; `comment.ts` `buildComment`; `publish` and the progress comment in `run-orchestrator.ts`; `run-estimates.ts` `phaseEstimates`; `build-steps.ts`.
- Drawn identity: a probe names the seeded user, the seed's e-mail domain and the hostname by `RUN_IDENTITY_TOKENS` (`{{run.user}}`, `{{run.domain}}`, `{{run.hostname}}`), never by value; the replay swaps in the base claim's `Claim.identity` (`withRunIdentity`) for every round of both sides, so a reused plan stays right. A claim from a cell without `runIdentity` has none, and the tokens stay. After both acquires `settleBoot` compares the two claims' identities (`runIdentityMismatchOf`: `base_unset`, `pr_unset`, `differ`); on a mismatch it logs `run.identity_mismatch` (side, cells), every probe that uses a token is `inconclusive` (`skewedByIdentity`) and stays out of the stability history, and `decideRunVerdict` gets `identityMismatch` (partly tested at best, a finding still wins). Derived from the two acquire outputs, never a step of its own.
- Halts: `security-violation.ts` `SecurityViolationError` (a cell's `security_violation` from boot, a step or a hub blocker) and canary leaks (`worker/canary`), both a failing check.
- Leases while the Run works: `lease-keeper.ts` `ClaimLeaseKeeper`, outside the DBOS journal by design.
- Recipe facts of the request: `recipe-change.ts` `recipeChangedInPr`, `changesOnlyTheRecipe`, `memberNotBootedOf`.
- Step ids: `step-id.ts` `stableStepId`. The Run's log lines: `run-log.ts` (`run.phase`, `run.finished`). Evidence of each step: `run-evidence.ts`.

## Does not own
- Registering the workflows, queues, retries of publish steps, the sweep: `worker/dbos`. Starting and superseding Runs: `worker/commands`.
- The verdict rules: `libs/runtime/gate` (`decideProbe`), `libs/runtime/run` (`decideRunVerdict`, run state). The agent's plan: `worker/agent`. Intent: `worker/intent`.
- The hub client and claim renewal calls: `worker/env`. Rendering the comment and check: `libs/runtime-publish`.

## Rules and limits
- Determinism, step ids, concurrent steps in a fixed order, safe re-runs: [apps/runtime/AGENTS.md](../../../AGENTS.md) "Workflow code (DBOS)". Changing the order or names of steps needs a new `RUNTIME_RELEASE_VERSION`.
- No canary, token or plain secret in a step's input or output ([apps/runtime/AGENTS.md](../../../AGENTS.md) "Secrets"); the canaries step records only their slots.
- The report holds structured fields only (verdicts, entry points, probe ids, status or exit per side): never a response body, the agent's prose or test output.
- A fork PR boots only with `forkApproved`, which only the gate sets. Intent can only downgrade a finding.
- Everything a cell sends is untrusted: build step names and evidence are cleaned again here.
- `cell_unavailable` and `transport_lost` are not VM-health facts; only explicit VM-health observations support `pr_destabilizes_machine`.
- A PR side that does not boot while the base does is `pr_destabilizes_machine`, unless every blocker is a signature the cell or the hub declares about itself (`report.ts` `infraBootBlocker`), or the proxy's record shows a host it denied the PR's claims and not the base's (`deniedEgressOfRun`, `prOnlyDeniedHosts`; step `egress:pr-boot`): then the Run is partly tested with the approve-host card and an `action_required` check (D7, 2026-11-18). The PR's log lines, exit codes, memory, disk and boot time never excuse it: the PR controls them.
- Gap: an unexpected error ends the Run `errored` with the error's message as its reason (`runRuntimeRun`).

## Where new code goes
- A new phase or step: in `run-orchestrator.ts` (or a file of its own here when it is more than a function), named for `stableStepId`, with a case in `run-orchestrator.step-ids.spec.ts`.
- A new port the Run needs: a field of `RunDeps` in `ports.ts`, its double in `testing.ts` `inMemoryRunDeps`, its wiring in `worker/dbos/run-deps.factory.ts`.
- A new report field: `report.ts` and the schema in `libs/runtime/run` (run-report), then the publisher's wording.

## Tests
- `API_NODE_ENV=test npx jest apps/runtime/src/worker/run`: no services; `testing.ts` `inMemoryRunDeps` wires a Run with no database, broker or LLM.
- The whole Run on real frames: `fake-cell/hub-cell.contract.spec.ts`; on DBOS and Postgres: `worker/dbos/run-engine.integration.spec.ts` (`RUNTIME_IT_DATABASE_URL`).

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (22, tests apart): `build-steps.ts`, `comment.ts`, `early-plan.ts`, `external-verification.ts`, `kept-checks.ts`, `lease-keeper.ts`, `pg-kept-check-results.ts`, `pg-stability-history.ts`, `plan-reuse.ts`, `ports.ts`, `probe-fields.ts`, `recipe-change.ts`, `replay.ts`, `report.ts`, `run-estimates.ts`, `run-evidence.ts`, `run-identity.ts`, `run-log.ts`, `run-orchestrator.ts`, `security-violation.ts`, `step-id.ts`, `testing.ts`

Imports these Runtime modules:

- [`apps/runtime/src/fake-cell`](../../fake-cell/AGENTS.md)
- [`apps/runtime/src/shared`](../../shared/AGENTS.md)
- [`apps/runtime/src/shared/admission`](../../shared/admission/AGENTS.md)
- [`apps/runtime/src/shared/evidence`](../../shared/evidence/AGENTS.md)
- [`apps/runtime/src/worker`](../AGENTS.md)
- [`apps/runtime/src/worker/agent`](../agent/AGENTS.md)
- [`apps/runtime/src/worker/canary`](../canary/AGENTS.md)
- [`apps/runtime/src/worker/env`](../env/AGENTS.md)
- [`apps/runtime/src/worker/intent`](../intent/AGENTS.md)
- [`libs/runtime/blockers`](../../../../../libs/runtime/blockers/AGENTS.md)
- [`libs/runtime/contracts`](../../../../../libs/runtime/contracts/AGENTS.md)
- [`libs/runtime/entry-points`](../../../../../libs/runtime/entry-points/AGENTS.md)
- [`libs/runtime/environment`](../../../../../libs/runtime/environment/AGENTS.md)
- [`libs/runtime/gate`](../../../../../libs/runtime/gate/AGENTS.md)
- [`libs/runtime/planner`](../../../../../libs/runtime/planner/AGENTS.md)
- [`libs/runtime/probe`](../../../../../libs/runtime/probe/AGENTS.md)
- [`libs/runtime/protocol`](../../../../../libs/runtime/protocol/AGENTS.md)
- [`libs/runtime/redaction`](../../../../../libs/runtime/redaction/AGENTS.md)
- [`libs/runtime/run`](../../../../../libs/runtime/run/AGENTS.md)
- [`libs/runtime/run/testing`](../../../../../libs/runtime/run/testing/AGENTS.md)
- [`libs/runtime/telemetry`](../../../../../libs/runtime/telemetry/AGENTS.md)

Imported by:

- [`apps/runtime/src/worker`](../AGENTS.md)
- [`apps/runtime/src/worker/agent`](../agent/AGENTS.md)
- [`apps/runtime/src/worker/commands`](../commands/AGENTS.md)
- [`apps/runtime/src/worker/dbos`](../dbos/AGENTS.md)
- [`apps/runtime/src/worker/env`](../env/AGENTS.md)
- [`apps/runtime/src/worker/intent`](../intent/AGENTS.md)
- [`apps/runtime/src/worker/persistence`](../persistence/AGENTS.md)
- [`apps/runtime/src/worker/publish`](../publish/AGENTS.md)
- [`apps/runtime/src/worker/setup`](../setup/AGENTS.md)
- [`apps/runtime/src/worker/suite`](../suite/AGENTS.md)

<!-- module-map:end -->
