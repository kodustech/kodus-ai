# apps/runtime-cell/internal/agent

The cell agent: the application of the cell process ([architecture.md](../../../../docs/runtime/architecture.md), "Cell agent"). It holds the outbound session to the runtime-hub, turns each hub frame into work on the driver, the transport, the observer and the egress control it is given (`Config`), and keeps the leases and the dead-man switch. It is a router over its parts (`agent/claims`, `outbox`, `pool`, `admission`, `provenance`, `evidence`, `coverage`, `checkout`); it decides nothing about the PR.

## Owns
- The hub session: `session.go` `Agent.Run`, `session` (hello, version choice, housekeeping, heartbeat); a hello refused for the cell's version (`cell_too_new`, `cell_too_old`, an older hub's `unsupported_version`: `asVersionRefusal`) is logged `hub.refused_version` at error and retried only after `RunConfig.RefusedBackoff` (5 min); after an accepted hello, `recordHubProtocol` writes the chosen version and the ack's `cellProtocols` to `Config.HubProtocolState` (`internal/hubprotocol`) for `cell update`, and the hello names `cellProtocols` only when that path is set; `handle.go` `Agent.Handle` (one frame to one handler, ack or nack at once).
- A claim's life: `acquire.go` `acquire` (admission, ceiling per consumer `hardCeiling`, `rejoin`), `prepare.go` `prepare` (the steps on one `preparation`: network, machines, code, upload, compose, egress, recipeSteps, observerSQL, running), `settle.go` `bringUp` (`claim.ready` or `claim.failed`), `release.go` `release`, `cleanup`, `ReapDeadClaims`; `pending_cleanup.go` (a release the driver could not confirm keeps its memory held, and each sweep tick destroys its lease again until that is clean, then lets the hold go: no hold outlives its machines).
- Steps on a ready claim: `steps.go` `admitStep` (dedup by `stepId`, the claim's step limit), `runProbe`, `runExec`; `browser.go`, `browser_explore.go`; `snapshots.go` (memory snapshots, `machine.reset` to a round); `observer_sql.go`; `exercised.go` (`claim.exercised` through the `agent/coverage` part, and which claims' boots instrument their Node services: `collectsCoverage`, a Run's PR or base side only, on a driver with `Parts.Coverage`).
- Uploads into the checkout: `upload.go` (`checkUpload` before admission: paths out of the checkout, in `.git` or over the cell's `.kodus*`/`.kody*` files, grants that are not plain http(s), modes past 0777; `runUpload` GETs every file's read grant over `EvidenceHTTP`, at most `MaxUploadFileBytes` 4 MiB a file and `MaxUploadBytes` 16 MiB a step, digest-checked when `sha256` is set, then writes each through `Transport.Exec` as base64 env chunks into a staging file renamed over the path; `uploadCanon` leaves the grant URL out). No error, log or result names a grant.
- What a prepare failure says: `blocker.go` `blockerErr` (kind and stable signature), `bundle.go` `collectBundle` (a setup's failure bundle, 1 MiB) and `deniedEgressBundle` (any other claim's: its denied egress only), `hold.go` `startHold` (a failed clean setup kept until its ceiling).
- Egress: `egress_policy.go` `EgressRules.ClaimPolicy`, `PolicySpec`, `InspectRulesFor`; `egress_sync.go` (store and push the hub's allowlist); `recipe_requirements.go` `CheckRecipeEgress`.
- Images and the pool: `image_policy.go` (`bake`, `bakeSource`, `poolTarget`, taint checks), `pool_claims.go`, `sandbox_pool.go` (blank sandboxes).
- Sandboxes: `sandbox.go` (`sandbox.acquire`, the guest clients), `layer_build.go` (tool layers: the answer per requested layer in `claim.ready`, and a layer builder's install, signature audit, seal and read-out, driven by the cell with no `sandbox.op` for any caller; it reports `toollayer.built` or `toollayer.failed` and ends the claim), `org_purge.go` (`org.purge`: the org's data at rest goes, `org.purged` when done; refused while a claim of the org is live), `org_secrets.go` (placeholders per claim, cell trust), `canaries.go`, `run_identity.go` (a Run's drawn hostname, seed user and seed domain: every service's env under `KODUS_RUN_*`, after the recipe's, and the hostname of a service that names none; never on a setup claim).
- Memory and disk: `memory.go` (what a claim is counted for, the heartbeat's memory; `countReady` asks `Parts.ReadyMemory` to lower a ready claim's ceiling before counting it lower), `service_states.go` (a probe that got no HTTP answer carries the services that exited, with exit code and redacted log tail, to a hub that accepts feature `serviceStates`), `disk_watch.go` (free disk of Docker's data root; under the margin and at the floor it first drops build cache no live build holds, oldest first via `Parts.BuildCache`, and measures again before it stops a claim).
- Warm spares: `spares.go` (`Parts.Spares`, docker-gvisor's warm fork reset): a ready Run claim's spare, booted at ready and after each reset only when the ledger has room for it (`admission.Ledger.Spare`), its addresses in the claim's egress policy before it starts; `runReset` swaps a ready one in (`takeSpare`, `afterSwap`) and resets as before otherwise.
- Alerts and frames out: `alerts.go` `watchAlerts`, `onExfiltration`; `source_health.go` (work admitted only while every alert feed answers); `redaction.go` `claimRedactor`, `redactOutbound`; `settle.go` `deliver`, `deliverOnce`; `progress.go` (`claim.progress`); `manifest.go` `readyBody`.
- `exec.service` reaches the driver as `kodyexec.Request.Service` (refused together with `exec.repository`); the cell names `execService` only where `Capabilities.ExecService` is true (docker-gvisor). microvm and the local transport (local-docker, fake) refuse it with `kodyexec.ErrServiceUnsupported`.
- `claim.acquire skipBake` (a base built cold, to confirm a PR's boot failure): `skipsBake` keeps `latest` unresolved, takes no pool machine and no shared image; refused (`skip_bake_refused`) on a PR or setup claim. The cell names `skipBake` always, the newest feature.
- Suite claims: consumer `suite` (one shard of the repository's own e2e suite, docs/runtime/e2e-suites.md section 4) is a Run-like claim with the ceiling `hardCeiling` gives it (105 min: the PR build plus the suite total, `HARD_EXPIRY_MINUTES.suite`); the cell always names the `suite` feature, the newest, so a hello trimmed for an older hub drops it first. The suite's command runs through `exec`, detached and polled by the worker (`apps/runtime/src/worker/suite/detached-exec.ts`); the cell needs nothing else.
- Previews: `preview.go` (tunnel, routes, `previewTargetExposed`). Multi-repository claims: `workspace.go`.
- Construction: `config.go` `Config`, `Config.complete` (required ports, memory admission, isolation check); `agent.go` `New`, `recoverBakes`.

## Does not own
- Backends: `internal/driver` (the port) and `internal/drivers/*`. Commands to a machine: `internal/transport`. The hub connection: `internal/hubclient`. Leases and the dead-man: `internal/lease`. Step dedup: `internal/dedup`.
- Signed policies and their push: `internal/policy`, `internal/policy/control`. Recipe rules: `internal/recipe`. Compose rules: `internal/compose`, `internal/compose/sandbox`.
- Wiring a driver into `Config`: `cmd/cell`.

## Rules and limits
- The agent's boundaries (router over parts, `Agent.mu` for the hub session only, `Handle` on the read loop with `hubclient.Later` and `goTracked`, frames only through `deliver`) are in [`apps/runtime-cell/AGENTS.md`](../../AGENTS.md) "Package boundaries" and "Untrusted input".
- A driver with isolation `none` runs only with `DevAllowInsecureIsolation` (`Config.complete`, ADR-027). Never weaken it.
- Nothing from the observer chooses a result's step, executor or image (`steps.go`); `exec.cwd` stays inside the workspace (`handle.go`).
- A capability is a `Config.Parts` field, never found by type assertion.

## Where new code goes
- A new stage of a claim: a step of `prepare.go` in its place in the list. A new hub frame: a case in `handle.go` and a handler file. A new concern with state: a new package under `agent/`, held as a field.

## Tests
- `go test ./internal/agent` with `newHarness` (`harness_test.go`); no Docker. `org_secrets_smoke_test.go` needs real Docker (`-tags dockersmoke`). End-to-end: `test/integration` against `testing/hubstub`.

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (49, tests apart): `acquire.go`, `agent.go`, `alerts.go`, `blocker.go`, `browser.go`, `browser_explore.go`, `bundle.go`, `canaries.go`, `compose_boot.go`, `config.go`, `data_reset.go`, `disk_watch.go`, `egress_policy.go`, `egress_sync.go`, `evidence_claim.go`, `exercised.go`, `handle.go`, `hold.go`, `host_seal.go`, `image_policy.go`, `image_store.go`, `layer_build.go`, `manifest.go`, `memory.go`, `metrics.go`, `observer_sql.go`, `org_purge.go`, `org_secrets.go`, `pending_cleanup.go`, `pool_claims.go`, `prepare.go`, `preview.go`, `progress.go`, `recipe_fakes.go`, `recipe_requirements.go`, `redaction.go`, `release.go`, `run_identity.go`, `sandbox.go`, `sandbox_pool.go`, … and 9 more

Imports these Runtime modules:

- [`apps/runtime-cell/internal/agent/admission`](admission/AGENTS.md)
- [`apps/runtime-cell/internal/agent/checkout`](checkout/AGENTS.md)
- [`apps/runtime-cell/internal/agent/claims`](claims/AGENTS.md)
- [`apps/runtime-cell/internal/agent/coverage`](coverage/AGENTS.md)
- [`apps/runtime-cell/internal/agent/evidence`](evidence/AGENTS.md)
- [`apps/runtime-cell/internal/agent/outbox`](outbox/AGENTS.md)
- [`apps/runtime-cell/internal/agent/pool`](pool/AGENTS.md)
- [`apps/runtime-cell/internal/agent/provenance`](provenance/AGENTS.md)
- [`apps/runtime-cell/internal/browser`](../browser/AGENTS.md)
- [`apps/runtime-cell/internal/buildprogress`](../buildprogress/AGENTS.md)
- [`apps/runtime-cell/internal/clock`](../clock/AGENTS.md)
- [`apps/runtime-cell/internal/compose`](../compose/AGENTS.md)
- [`apps/runtime-cell/internal/compose/sandbox`](../compose/sandbox/AGENTS.md)
- [`apps/runtime-cell/internal/composecmd`](../composecmd/AGENTS.md)
- [`apps/runtime-cell/internal/dedup`](../dedup/AGENTS.md)
- [`apps/runtime-cell/internal/driver`](../driver/AGENTS.md)
- [`apps/runtime-cell/internal/eventlog`](../eventlog/AGENTS.md)
- [`apps/runtime-cell/internal/guest`](../guest/AGENTS.md)
- [`apps/runtime-cell/internal/hubclient`](../hubclient/AGENTS.md)
- [`apps/runtime-cell/internal/hubprotocol`](../hubprotocol/AGENTS.md)
- [`apps/runtime-cell/internal/isolation`](../isolation/AGENTS.md)
- [`apps/runtime-cell/internal/isolation/vmsnap`](../isolation/vmsnap/AGENTS.md)
- [`apps/runtime-cell/internal/kodyexec`](../kodyexec/AGENTS.md)
- [`apps/runtime-cell/internal/lease`](../lease/AGENTS.md)
- [`apps/runtime-cell/internal/machinetrust`](../machinetrust/AGENTS.md)
- [`apps/runtime-cell/internal/metrics`](../metrics/AGENTS.md)
- [`apps/runtime-cell/internal/netguard`](../netguard/AGENTS.md)
- [`apps/runtime-cell/internal/observer`](../observer/AGENTS.md)
- [`apps/runtime-cell/internal/observerauth`](../observerauth/AGENTS.md)
- [`apps/runtime-cell/internal/policy`](../policy/AGENTS.md)
- [`apps/runtime-cell/internal/preview`](../preview/AGENTS.md)
- [`apps/runtime-cell/internal/protocol`](../protocol/AGENTS.md)
- [`apps/runtime-cell/internal/recipe`](../recipe/AGENTS.md)
- [`apps/runtime-cell/internal/redact`](../redact/AGENTS.md)
- [`apps/runtime-cell/internal/tarball`](../tarball/AGENTS.md)
- [`apps/runtime-cell/internal/telemetry`](../telemetry/AGENTS.md)
- [`apps/runtime-cell/internal/transport`](../transport/AGENTS.md)
- [`apps/runtime-cell/internal/version`](../version/AGENTS.md)

Imported by:

- [`apps/runtime-cell/cmd/cell`](../../cmd/cell/AGENTS.md)

<!-- module-map:end -->
