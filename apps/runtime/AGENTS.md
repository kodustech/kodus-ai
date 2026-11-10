# apps/runtime: rules for changing it

Read `README.md` first for how the hub and the worker fit together.

## Layering

- `src/shared/` (config, stores both apps use, locks, logger, tracing, migrations) imports only `libs/*` and itself. Never `hub/` or `worker/`.
- `src/hub/` imports `shared/` and `libs/*`. Never `worker/`.
- `src/worker/` imports `shared/` and `libs/*`. Never `hub/`. It reaches the hub over HTTP (`worker/env/hub-environment-runtime.ts`) and finds cells through `CellDirectory` (`shared/cell-directory.ts`).
- `src/fake-cell/`, `src/testing/` and `src/e2e/` are test and dev code. Production code imports them only behind the dev-only fake driver (`fakeEnvironments` in `worker/runtime-worker.module.ts`), which the production image refuses. The test wiring `worker/run/in-memory-deps.ts` is the other importer; keep it out of production modules.
- Domain rules (protocol, gate, run state, sealed secrets, metrics names) belong in `libs/runtime`. Do not copy them here.
- Read the process environment only in `shared/config.ts` (the standard `OTEL_*` variables in `shared/otel.ts` are the one exception). Add new settings to `RuntimeConfig` / `WorkerConfig` with validation, and to the README table.

## Claims

- Change a claim's state only with `transitionClaim(claimId, from, to, cause)` or `rebindClaim` (`hub/hub-store.ts`); in `ClaimService`, through `move`, which also counts and logs it. Name the states the claim may leave; act only when the call returns true. Never write `runtime_claims.state` any other way.
- A cause is a `ClaimReason` (a closed set: dashboards and alerts match on it) and, when the cell gave one, its own code as `detail`. A new way for a claim to move gets a new reason, never free text in the reason.
- The hub is the writer of `runtime_claims`. The worker only reads it (`worker/persistence/pg-run-claims.ts`) and releases through the hub (`HubClaimReleaser`). The one other write is the revocation transaction in `shared/pg-command-store.ts`.
- Keep the in-memory store (`InMemoryHubStore`) in step with the Pg store. Every new store method gets the same semantics in both, plus a case in `hub/pg-hub-store.integration.spec.ts`.

## Tenant scope

- Every query or route that takes a claim, run or step id also takes `organizationId` and filters or checks by it. Internal claim routes take `ClaimRef` (`claimId`, `organizationId`, optional `runId`), and `ClaimService.scoped` checks them against the row.
- A mismatch is `ClaimScopeError`, mapped to 404. Never act on the claim first and check after.
- Claim ids derive from the org and the idempotency key (`claimIdFor`); keep the org in any new derived id.

## Secrets

- Workflow inputs and step outputs never hold a usable secret. Tokens enter sealed (`libs/runtime/run/sealed-secret.ts`). Open them with `SecretOpener` inside the one call that needs them, and never return, store or log the plain value.
- A new secret the worker needs is sealed by its producer and bound to the Run (or the setup key). Add the opening point to the README's sealed-tokens section.

## Workflow code (DBOS)

- Code in `runRuntimeRun`, `awaitForkApproval`, `finalizeStoppedRun` and `EnvironmentSetupService.run` must be deterministic.
  - Read clocks, random ids and I/O only inside a `step(...)`.
  - Derive step ids with `stableStepId`.
- Start steps that run concurrently in a fixed order (see `bootBoth`).
- A step must be safe to run twice: give events a key, give publications their `publishKey`, and make cell steps idempotent by stepId.
- Never make a broker handler wait for a workflow's result. Start it and return (`RunEngineService.stop`).
- Work that must run once per cluster takes a `DistributedLocks` lock (`shared/locks.ts`). It does not run on every replica.

## Protocol and schema

- Change hub ↔ cell messages in `libs/runtime/protocol` first; the Go cell implements the same schema. The hub may only send frames that `decodeFrame` accepts: claim-scoped types carry `claimId`, and replies carry `re`.
- Change the Runtime database only with a new entry in `RUNTIME_MIGRATIONS` (`shared/runtime-schema.ts`).

## Tests

- Every bug fix comes with a spec that fails without it.
- Prefer real frames (`fake-cell/hub-cell.contract.spec.ts`) and real Postgres (`*.integration.spec.ts`, opt-in with `RUNTIME_IT_DATABASE_URL`) over mocks of the stores.
- Run `npx tsc --noEmit -p apps/runtime/tsconfig.json` and `API_NODE_ENV=test npx jest apps/runtime` before a PR. Run the integration specs with `--runInBand` when touching the stores, the workflows or the hub listeners.

## Naming

- Name things for what they do: `ClaimService`, `StepDispatcher`, `reserveCell`, `findActiveClaim`, `HubEnvironmentClient`.
- Use one word per concept:
  - **cell**: the agent process.
  - **machine**: a VM in a cell.
  - **claim**: machines held for one side of a Run.
  - **lease**: a claim's renewable expiry; **hard expiry**: its absolute one.
  - **session**: a cell's connection to one hub replica.
- DI tokens are `Symbol`s next to the provider they name.

## Logs and metrics

- Log through `RuntimeLogger` or Nest's `Logger` with an object message: `{ msg: 'claim.ready', claimId, ... }`. `msg` is a dotted event name, and the fields are ids and numbers.
- Never log a token, a certificate, a key, a canary, request bodies, or command output.
- Metric labels come from closed sets (state, kind, outcome, consumer, org, cell). Never use a host, a URL, a stepId or free text as a label; put those in the event tables or the logs.
- A background failure (pin reload, stream append, disconnect) is logged and counted in `runtime.hub.background_error{op}`, never swallowed silently.
