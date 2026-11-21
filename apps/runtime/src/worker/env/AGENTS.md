# apps/runtime/src/worker/env

How the runtime-worker reaches cells: the adapter of the `EnvironmentRuntime` port (`libs/runtime/environment`) over the hub's internal listener, and the waits around an acquire. It runs in the runtime-worker, inside the steps of Runs, setups, env sessions, previews and sandboxes; the worker never dials a cell, a cloud API or SSH (architecture.md, "Processes and their boundaries").

## Owns
- The HTTP client to the hub: `hub-environment-runtime.ts` `HubClient.post` (mTLS with the worker certificate, `mtlsPost`; per-route deadlines; a refused connection sent again for about a minute and a half, `HUB_REFUSED_RETRY_MS`; 409 as `HubRefused`, 502/503/504 as `CellUnavailableError`, a dropped connection as `HubUnreachableError`), and finding the replica that holds a cell or claim (`replicaForCell`, `replicaForClaim`, `reserveCell` over `CellDirectory`).
- One environment client per Run or setup: `HubEnvironmentClient` (`acquire`, `progress`, `probe`, `exec`, `exploreBrowser`, `reset`, `snapshotRound`, `renew`, `upload` (`/internal/claims/:id/upload`), `status` (only the client's own org, from `HubRunContext.health`, which `run-deps.factory.ts` `healthOfSetup` builds from the setup record of the same org), `release`, `bake`, `poolTarget`). The acquire picks the cell (the pool's cell first, the other side's backend for a Run's second side, `sameBackendAs`), opens the repo token, and blocks before sending anything when a workspace member has no token (`workspaceTokenMissing`), the primary's alias does not match (`workspacePrimaryAlias`) or no cell has room (`capacityBlocked`). Every blocked acquire it returns goes through `libs/runtime/environment/typed-blocker.ts` `typedBlocked`: a kind this worker does not know reads `unknown`, and each blocker carries the catalog's `title`, `evidence` and `fixes`.
- Hub calls that are not one claim: `HubEgressPolicyPusher` (egress allowlist to every replica), `HubPoolTargetSender`, `HubClaimReleaser`, `HubRunEventSink` (Run events to the hub's stream; dropped and counted after a few tries).
- Waiting for room: `capacity-wait.ts` `acquireWaitingForRoom` asks again with the same idempotency key on a capacity refusal and on `cell_lost` (`CELL_LOST_WAIT_MS`), and stops on cancellation or deadline. No host connected for the org on the first ask (`NoCellConnectedError`) ends the claim at once as `NO_CELL_CONNECTED` (the `cell_unavailable` card); later, a pause. A refusal for room carries `Blocked.capacity` `hosts`, `cap` and `nextFreeAt` (the earliest hard expiry of a live claim on the full cells, an upper bound) from `cell-directory.ts` `reserveCellFor`.
- A restored claim's lease: `claim-liveness.ts` `checkClaimLease` renews it inside the work step and records failures as closed data (`ClaimLeaseFailure`), thrown outside the checkpoint (`throwClaimLeaseFailure`).
- The ready check: `ready-check.ts` `waitUntilReady` (the health path under 500; in a Run, the same 5xx `STABLE_ERROR_TRIES` times in a row counts as up).
- Durable admission's placement: `physical-admission-client.ts` `HubPhysicalAdmissionClient` (`/internal/cells/:id/admission/*`).

## Does not own
- What the hub does with a claim: `apps/runtime/src/hub/claims`. Cell choice rules and slot reservation: `shared/persistence/cell-directory.ts`. Admission stores and contract: `shared/admission`.
- The port and its result types: `libs/runtime/environment`. Errors shared with the hub: `shared/errors.ts`.

## Rules and limits
- `upload` signs one read URL per file (`run-evidence.ts` `evidenceReadUrl`, the same store as the upload grants, at most 5 minutes) only for a `contentRef` that is a canonical evidence key of the client's own org; any other is `upload_failed` before the hub. No evidence store (`evidenceReads` unset): `upload_unavailable`.
- The repo token is opened only inside `HubEnvironmentClient.acquire`, and only after the tenant, the workspace and any admission ticket are checked ([apps/runtime/AGENTS.md](../../../AGENTS.md) "Secrets", [README "Sealed tokens"](../../../README.md#sealed-tokens)).
- Every claim route carries `organizationId` (and the Run) ([apps/runtime/AGENTS.md](../../../AGENTS.md) "Tenant scope").
- Only `ECONNREFUSED` is retried by `HubClient.post`: the request never reached the hub. Network errors are decided on the error `code`, never the message (`isNetworkError`).
- A hub answer over 4 MiB (`MAX_RESPONSE_BYTES`) or not a JSON object is an error; a 503 is `MemberCleanupPendingError` only for the strict structured cleanup body.
- `cell_unavailable` and `transport_lost` say nothing about the guest ([README "Transport and machine facts"](../../../README.md)).
- A refused admission ticket is capacity lost (`AdmissionCapacityLostError`), never a PR regression.

## Where new code goes
- A new hub route the worker calls: a method on `HubEnvironmentClient` (or its own small class over `HubClient`), the route in `hub/http/internal.controller.ts`, and the method on `EnvironmentRuntime` when Runs or setups use it.
- A new wait or retry around an acquire: `capacity-wait.ts`, keeping the same idempotency key on every round.

## Tests
- `API_NODE_ENV=test npx jest apps/runtime/src/worker/env` (no services; a fake `postImpl` stands for the hub). `hub-environment-workspace.spec.ts` covers multi-repository acquires, `admission-pinning.spec.ts` the admission ticket.

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (6, tests apart): `admission-errors.ts`, `capacity-wait.ts`, `claim-liveness.ts`, `hub-environment-runtime.ts`, `physical-admission-client.ts`, `ready-check.ts`

Imports these Runtime modules:

- [`apps/runtime/src/shared`](../../shared/AGENTS.md)
- [`apps/runtime/src/shared/admission`](../../shared/admission/AGENTS.md)
- [`apps/runtime/src/shared/evidence`](../../shared/evidence/AGENTS.md)
- [`apps/runtime/src/shared/persistence`](../../shared/persistence/AGENTS.md)
- [`apps/runtime/src/worker`](../AGENTS.md)
- [`apps/runtime/src/worker/run`](../run/AGENTS.md)
- [`apps/runtime/src/worker/secrets`](../secrets/AGENTS.md)
- [`libs/runtime/blockers`](../../../../../libs/runtime/blockers/AGENTS.md)
- [`libs/runtime/contracts`](../../../../../libs/runtime/contracts/AGENTS.md)
- [`libs/runtime/environment`](../../../../../libs/runtime/environment/AGENTS.md)
- [`libs/runtime/probe`](../../../../../libs/runtime/probe/AGENTS.md)
- [`libs/runtime/protocol`](../../../../../libs/runtime/protocol/AGENTS.md)
- [`libs/runtime/run`](../../../../../libs/runtime/run/AGENTS.md)
- [`libs/runtime/telemetry`](../../../../../libs/runtime/telemetry/AGENTS.md)

Imported by:

- [`apps/runtime/src/worker`](../AGENTS.md)
- [`apps/runtime/src/worker/commands`](../commands/AGENTS.md)
- [`apps/runtime/src/worker/dbos`](../dbos/AGENTS.md)
- [`apps/runtime/src/worker/env-session`](../env-session/AGENTS.md)
- [`apps/runtime/src/worker/intent`](../intent/AGENTS.md)
- [`apps/runtime/src/worker/preview`](../preview/AGENTS.md)
- [`apps/runtime/src/worker/run`](../run/AGENTS.md)
- [`apps/runtime/src/worker/sandbox`](../sandbox/AGENTS.md)
- [`apps/runtime/src/worker/setup`](../setup/AGENTS.md)

<!-- module-map:end -->
