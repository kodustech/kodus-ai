# apps/runtime/src/fleet

runtime-fleet (docs/runtime/host-providers.md §4.1, §7.0): the process that makes and removes the hosts cells run on. A reconcile loop under the cluster lock reads the Runs that asked a `perRun` pool for room (`runtime_pool_demand`), and one DBOS workflow per host (`fleet.perRun:<hostId>`, in its own DBOS application `kody-runtime-fleet` and system database) creates it from the environment's template, waits for its cell to register, serves the Run, then retires the cell and destroys the host.

## Owns
- `main.ts`, `runtime-fleet.module.ts`: the entrypoint and wiring (config from `shared/config.ts` `loadFleetConfig`). With arguments, `main.ts` runs a one-shot command instead (`fleet-command.ts`, config `loadFleetApplyConfig`: the database only).
- `fleet-command.ts` `runFleetCommand`, `pool-apply.ts`: `runtime-fleet apply -f <file|dir> [--dry-run]` (§5.2), the one way to create or change a pool. `resolvePoolDocuments` checks the whole file set (classes resolved by name, the schema, an adapter for the provider, a boat pool's `admission.allowOrgs` and cell base, no duplicate id) and `PgPoolSpecWriter` writes it in one transaction: spec, spec hash, weight. It never writes status, cordon or hosts, never deletes a pool, and refuses a provider change under the same pool id.
- Deploy: the `runtime-fleet` project in `nest-cli.json`, the `runtime-fleet` stage of `docker/Dockerfile` and bake target, the `runtime-fleet` compose profile (client certificate `fleet.pem`, CN `runtime-fleet`, from `scripts/runtime/dev-ca.sh`). `deployable.spec.ts` checks all of them.
- `per-run-host.ts` `runPerRunHost`: the perRun lifecycle as a deterministic workflow body (steps and durable sleeps injected).
- `fleet-engine.ts` `FleetEngine`: the DBOS registration and launch; `perRunWorkflowId`.
- `reconcile.ts` `reconcileOnce`: demand to workflows, pool status (breaker, provider quotas), the orphan pass. `fleet-reconciler.ts`: its timer under `DistributedLocks`.
- `fleet-store.ts` `PgFleetStore`: hosts, host events, pool status, the fleet's side of demand; `fleetHostId`, `HOST_FAILURES`, `HOST_REASONS`.
- `hub-fleet-client.ts`: the hub's `/internal/fleet/*` routes over mTLS with the fleet's own certificate.
- `providers/`: the provider registry and the adapters.

## Does not own
- Which cell takes a claim and the demand row's writer: `shared/persistence/cell-directory.ts` (the worker).
- Cell identity: the hub mints `kcf_` tokens and registers cells (`hub/enrollment/fleet-enrollment.ts`).
- The port, schemas and fake provider: `libs/runtime/fleet`.

## Rules and limits
- Imports `shared/` and `libs/*` only, never `hub/` or `worker/` (`shared/module-resolution.spec.ts`).
- The only process that holds a provider credential. The worker never calls a provider.
- Workflow code is deterministic: clocks and I/O inside a step, step names from the loop index. A step output never holds a usable secret: the fleet token is sealed to the host (`sealSecret`) in the step that mints it and opened only inside the create step.
- The host row is written before any provider call; every host is tagged with the installation, pool and host id; the orphan pass lists the provider first, then reads the rows, and destroys a tagged host no live row names (the other order destroys a host made between the reads).
- A boat Run host starts from its environment's template, else from its class's cell base (`boat.base`, `kodus-cell-…`, never an environment template); a boat pool whose base is missing or not a ready saved image is not scalable (`base_missing`), so placement moves Runs on.
- Destroy on any failure, and say why on the demand row (`HOST_FAILURES`), so the Run gets `host_unavailable` instead of waiting.
- Teardown runs on every way out of the workflow (a `finally`). Retire and destroy are tried on their own, each step retried (`FLEET_STEP_RETRY`, which every row, poll and hub step of the workflow uses, so a blip never costs a Run its host), and what did not go through is tried again after a durable sleep for `TEARDOWN_BOUND_MS`; past it the host row is `failed` with `teardown_failed` and the workflow ends in error.
- A durable workflow change ships with a new `RUNTIME_RELEASE_VERSION`.
- The `pooled` lifecycle (warm, consolidation, drift, drain) is documented, not built: reconcile marks such a pool `lifecycle_not_built`.

## Where new code goes
- A provider: `providers/<kind>/`, registered in `runtime-fleet.module.ts` `providersOf`, with a conformance spec.
- A new reason a host fails: `HOST_FAILURES`, and the Run's blocker card (`libs/runtime/blockers/rules/cell.ts` `hostUnavailableRule`) if it needs its own words.

## Tests
- `per-run-host.spec.ts`, `reconcile.spec.ts`, `pool-apply.spec.ts`, `fleet-command.spec.ts`, `deployable.spec.ts` (pure, with `testing.ts`); `fleet-engine.integration.spec.ts`, `pool-apply.integration.spec.ts` (real Postgres, `RUNTIME_IT_DATABASE_URL`).
- `deployable.spec.ts` keeps one `it.failing` for the package.json build scripts until they build `runtime-fleet`; turn it into `it` then.

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (11, tests apart): `fleet-command.ts`, `fleet-engine.ts`, `fleet-reconciler.ts`, `fleet-store.ts`, `hub-fleet-client.ts`, `main.ts`, `per-run-host.ts`, `pool-apply.ts`, `reconcile.ts`, `runtime-fleet.module.ts`, `testing.ts`

Imports these Runtime modules:

- [`apps/runtime/src/fleet/providers`](providers/AGENTS.md)
- [`apps/runtime/src/fleet/providers/boat`](providers/boat/AGENTS.md)
- [`apps/runtime/src/fleet/template`](template/AGENTS.md)
- [`apps/runtime/src/shared`](../shared/AGENTS.md)
- [`apps/runtime/src/shared/observability`](../shared/observability/AGENTS.md)
- [`apps/runtime/src/shared/persistence`](../shared/persistence/AGENTS.md)
- [`libs/runtime/contracts`](../../../../libs/runtime/contracts/AGENTS.md)
- [`libs/runtime/fleet`](../../../../libs/runtime/fleet/AGENTS.md)
- [`libs/runtime/run`](../../../../libs/runtime/run/AGENTS.md)

Imported by:

- [`apps/runtime/src/fleet/template`](template/AGENTS.md)

<!-- module-map:end -->
