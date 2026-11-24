# apps/runtime/src/hub/claims

Everything the runtime-hub does with a claim: acquire, the cell's outcome, release, heartbeat reconciliation, security violations, leases, memory admission, egress hosts, bakes and pool targets, previews, and the steps on a bound claim. It runs in the runtime-hub, behind `CellHub` (`hub/cell-hub.ts`), which builds these services and routes frames to them; the worker reaches them through `hub/http/internal.controller.ts`.

## Owns
- The claim lifecycle: `claim.service.ts` `ClaimService`. `acquire` (a duplicate joins the round in flight), `acquireRound` (refusals before admission, machine minutes, memory, `recordRound` with a rebind on retry, `sendAndAwaitReady`), `onOutcome`, `release`, `reconcile`, `onUnsolicitedBlocked`, `scoped` (the tenant check), `findActiveClaim`. Every state change goes through `move`.
- The deadlines of a round: `claim-deadlines.ts` `freshDeadlines`, `retryDeadlines` (a retry on the same cell keeps the first round's ceiling), `readyWaitMs`.
- Memory admission per cell (ADR-070): `cell-memory.ts` `CellMemoryBook` (`admit`, `report`, the waiting line, sibling reservations, physical tickets).
- Durable physical admission tickets (`RUNTIME_DURABLE_ADMISSION`): `ticket.service.ts` `TicketService` (`reserve`, `redeem`, `authorizeAcquire`, `retargetSetup`, `cancel`).
- Lease renewal: `claim-lease.ts` `ClaimLeaseService.renew`, only for `RENEWABLE_CLAIM_STATES` (`bound`), never past the hard ceiling.
- Approved egress hosts: `claim-egress.service.ts` `ClaimEgressService`, `receivesApprovedHosts`, `egressBodyFor`.
- Bakes, pool targets and session forgets: `claim-image.service.ts` `ClaimImageService`.
- Tool layers (feature `toolLayers`): `tool-layers.ts` `ToolLayerService` (`keyed`: the keys of a review's planned CLIs, computed with `computeToolLayerKey` from the chosen cell's image digest and arch, only for a cell that names the feature and sent a digest; `settle`: hit or miss per layer from `claim.ready`, the registry host of a held layer taken out of the sandbox's egress, the `tool_layers` audit row with keys and states and never a path) and `ToolLayerBuilds` (the builders a cell asks for with `build: true`: single-flight per org, cell and key, one per cell and two per org, queued behind reviews with a capacity retry, failures remembered 10 minutes, the cell's `unknown_claim` on the release of a builder that ended itself is normal).
- `exec.service` (a command in a named compose service, the suite's `service:`) goes only to a cell that names `execService`; otherwise `exec_service_unavailable` is answered and nothing is sent (`cell-hub.workspace.spec.ts`).
- A claim of consumer `suite` (docs/runtime/e2e-suites.md section 4) goes only to a cell that names the `suite` feature (`suite_unsupported` otherwise, before anything is recorded or sent), with the suite's ceiling (`HARD_EXPIRY_MINUTES.suite`) and a Run's lease, egress hosts and secrets (`cell-hub.suite.spec.ts`).
- Preview routes: `claim-preview.service.ts` `ClaimPreviewService` (`route`, `unroute`, the tunnel ticket).
- Steps at most once per `stepId`: `step-dispatcher.ts` `StepDispatcher` (`probe`, `exec`, `reset`, `exploreBrowser`, `sandboxOp`, `snapshot`, `upload` (a cell's `not_implemented`/`not_supported` answer is `upload_unavailable`, not a lost transport; a nonzero exec in its result is `upload_failed`; the command hash leaves out each file's read grant `url`), `onStepReply`, `onStepFrame`).
- Boot progress for the setup view: `claim-progress.ts` `ClaimProgressBook`.
- The org's daily machine minutes: `machine-minutes.ts` (port), `pg-machine-minutes.store.ts` `PgMachineMinuteStore`. `reserve` reads the org's own limit (`runtime_org_machine_budget`, written by the runtime-worker from `runtime.org.machine_minutes_changed`) under the org day's lock and holds the org to the lower of it and `RUNTIME_MACHINE_MINUTES_PER_ORG_DAY`.
- The org's secrets by reference: `org-secret-refs.ts` `PgOrgSecretRefs` (names and hosts, never a value).

## Does not own
- The `runtime_claims` writes themselves and `ClaimReason`: `hub/hub-store.ts`.
- The sockets, ack timeouts and backpressure: `hub/gateway/cell-connections.ts`.
- Which cell a Run goes to: `shared/persistence/cell-directory.ts` (the worker reserves; the hub admits).
- The admission store and ticket contract: `shared/admission/`.

## Rules and limits
- Claims, tenant scope and secrets rules: [apps/runtime/AGENTS.md](../../../AGENTS.md). A claim moves only through `ClaimService.move`; a new cause is a new `ClaimReason`.
- Refuse before anything is recorded or sent: a cell of another org (`ClaimScopeError`), an unmet isolation, a recipe or size or workspace the cell did not name, an exhausted machine-minute day, no memory. Machine minutes are given back on every way out before the frame leaves.
- A PR claim of a fork gets neither the approved hosts nor the org's secrets (`receivesApprovedHosts`).
- A bake comes only from a bound setup claim, never one that ran PR code (`bake`, S-52).
- A compromised claim takes no step, is never rebound or renewed, and reconciliation never releases it.
- A step's `stepId` is indexed before the frame goes out; a step lost with its connection is `lost`, never resent. Only known cell refusal codes (`STEP_REFUSALS`) reach logs or the stream.
- Text the cell sends about a claim is redacted of the claim's download tokens before it is recorded, logged or returned.
- `CellMemoryBook` is per replica and runs each admission without an await; the cell re-checks with its own ledger.

## Where new code goes
- Something the hub does with a claim: a method here, reached from `CellHub` and a route in `hub/http/internal.controller.ts` that takes `ClaimRef`.
- A new step kind: `StepDispatcher` (its `StepKind`, refusal codes), the protocol first.
- A new refusal before admission: `ClaimService.refusalBeforeAdmission`, with a blocker card in `libs/runtime/blockers/catalog.ts` when users see it.

## Tests
- `API_NODE_ENV=test npx jest apps/runtime/src/hub/claims` (in-memory store, no services). `claim-lifecycle.spec.ts` covers the races; `cell-memory.spec.ts` the admission line.
- `pg-machine-minutes.*.integration.spec.ts`: `RUNTIME_IT_DATABASE_URL`, `--runInBand`.

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (14, tests apart): `cell-memory.ts`, `claim-deadlines.ts`, `claim-egress.service.ts`, `claim-image.service.ts`, `claim-lease.ts`, `claim-preview.service.ts`, `claim-progress.ts`, `claim.service.ts`, `machine-minutes.ts`, `org-secret-refs.ts`, `pg-machine-minutes.store.ts`, `step-dispatcher.ts`, `ticket.service.ts`, `tool-layers.ts`

Imports these Runtime modules:

- [`apps/runtime/src/hub`](../AGENTS.md)
- [`apps/runtime/src/hub/gateway`](../gateway/AGENTS.md)
- [`apps/runtime/src/shared`](../../shared/AGENTS.md)
- [`apps/runtime/src/shared/admission`](../../shared/admission/AGENTS.md)
- [`apps/runtime/src/shared/observability`](../../shared/observability/AGENTS.md)
- [`libs/runtime/api/domain`](../../../../../libs/runtime/api/domain/AGENTS.md)
- [`libs/runtime/contracts`](../../../../../libs/runtime/contracts/AGENTS.md)
- [`libs/runtime/environment`](../../../../../libs/runtime/environment/AGENTS.md)
- [`libs/runtime/probe`](../../../../../libs/runtime/probe/AGENTS.md)
- [`libs/runtime/protocol`](../../../../../libs/runtime/protocol/AGENTS.md)
- [`libs/runtime/redaction`](../../../../../libs/runtime/redaction/AGENTS.md)
- [`libs/runtime/run`](../../../../../libs/runtime/run/AGENTS.md)
- [`libs/runtime/run/adapters`](../../../../../libs/runtime/run/adapters/AGENTS.md)
- [`libs/runtime/telemetry`](../../../../../libs/runtime/telemetry/AGENTS.md)

Imported by:

- [`apps/runtime/src/hub`](../AGENTS.md)

<!-- module-map:end -->
