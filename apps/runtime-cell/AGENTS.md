# Changing the cell

The cell runs code nobody trusts. Read `README.md` first for the package map and a claim's life. The root `AGENTS.md` writing rules apply to comments, PRs and issues here too.

## Package boundaries

- Dependency direction:
  - `cmd/*` wires;
  - `internal/agent` orchestrates;
  - the ports (`driver`, `transport`, `hubclient`, `policy/control`) sit under it;
  - `protocol`, `redact`, `clock` and `metrics` are leaves.

  A driver never imports `agent`. The data plane (`egress`, `resolver`, `injector`, `observer`) never imports the control side.
- The same roles as the product's hexagonal libs, in Go's idiom: `agent` is the application, the ports are the interfaces it is given (`driver`, `transport`, `hubclient`, `policy/control`), `drivers/*` are adapters, `cmd/*` is the composition root. A rule that needs no backend and no claim state is a pure package (`recipe`, `netguard`, `buildfingerprint`, `bakecatalog`, `agent/checkout`, `agent/admission`, `agent/provenance`): an adapter calls it, it never lives inside one. What only one driver needs but stands on its own is a subpackage of that driver (`drivers/dockergvisor/buildstate`, `buildcache`), with its own tests.
- The agent is a router over its parts: a part with state of its own is a package with its own lock (`agent/claims`, `outbox`, `pool`, `admission`, `provenance`), and a part without state takes a narrow view of the claim, never the claim (`agent/evidence`), given what it needs at construction. `Agent.mu` guards the hub session only. A new concern is a new part, not another field and method on `Agent`.
- A claim's preparation is a list of steps on one `preparation` (`agent/prepare.go`), and a project's boot on docker-gvisor a list of steps on one `projectBoot` (`drivers/dockergvisor/up.go`). A new stage is a new step in that list, in its place in the order, not more lines in another step.
- `driver.MachineDriver` is composed of small interfaces (`Describer`, `ClaimNetworker`, `MachineCreator`, `MachineKeeper`, `MachinePauser`, `MachineResetter`, `Baker`). A package that needs part of a driver asks for that part, in an interface of its own (`lease.Machines`, `pool.Machines`), never for the whole driver.
- `internal/archrules` tests these boundaries on the import graph. A new boundary is a new rule there, in the same change as its line here.
- `cmd/*/main.go` only wires. A function in it that is more than glue belongs in a package with a test.
- Optional capabilities are explicit fields of `agent.Config` (`Keys`, `Manifests`, `BootTimes`, `Diagnoser`, `Secrets`, `DeniedEgress`, `Composer`, `Recipes`, `Alerts`). Never discover them by type assertion.
- A claim's mutable state lives in `agent/claims` behind the claim's lock. Read it through its methods, never by copying fields across goroutines.
- `Agent.Handle` runs on the WebSocket read loop: it validates and answers at once. Work that needs I/O before the answer goes through `hubclient.Later`; anything else goes through `goTracked`.
- Test fakes live in `internal/testing/` or in `_test.go` files. `driver/fake` is selectable only with `-dev`.

## Protocol

- Every protocol change starts in `libs/runtime/protocol` (zod). Then dump the schema and run `go generate ./internal/protocol`.
- Never edit `internal/protocol/types_gen.go` or `schema/protocol.schema.json` by hand.
- A zod refinement the JSON Schema cannot carry is mirrored in `internal/protocol/codec.go` or `strictjson.go`, with the same error code.
- Every new rule gets a fixture in `libs/runtime/protocol/fixtures` (new files only). It must pass both `go test ./internal/protocol/` and `API_NODE_ENV=test npx jest libs/runtime/protocol`.
- Parse date-time fields with `protocol.ParseTime` and write them with `protocol.FormatTime`. Never use `time.Parse(time.RFC3339, ...)` on a frame field.

## Untrusted input

- Every value from the hub, the checkout, the VM or the observer is untrusted, even after the schema accepted it.
- Ids become names and paths only after `claims.ValidID` or `driver.ValidateClaimID`. Build paths with `claims.WorkDir`, never by joining an id.
- The cell writes into a checkout only through `internal/checkoutfs` or an `os.Root`. A plain `os.WriteFile` into a checkout is a bug.
- A compose file from a checkout reaches gVisor only after `compose/sandbox.Apply`, and is checked again with `VerifyCanonical` before it starts.
- `exec.cwd` stays inside the workspace (`agent/handle.go`). Repo URLs come from `gitsource`, built from validated parts.
- Nothing from the observer chooses a result's step, executor or image (`agent/steps.go`).
- `local-docker` reports isolation `none`. It must never run code you did not write, and never be enabled outside a developer's machine. Do not weaken its gate (`localdocker.Gate`) or the agent's isolation check (`agent.New`).
- Claim frames leave the cell only through `agent.deliver`, which redacts. Never send a body around it.
- A ceiling only goes down: `kodus:hard-expires` is written once (`driver.MachineSpec.AllTags`) and the reaper honors it whatever renews.
- A data snapshot belongs to one machine and dies with it. Nothing that must differ per round or per Run is made before the snapshot, and when pool machines are handed to claims, a snapshot never moves with a machine to another claim.
- A host denial lives in `netguard.DenyList`, which the proxy and the resolver both ask, never in one of them. Its zero value must keep refusing the Kodus list.
- A driver touches only this cell's machines and networks. `List` never returns another cell's, whatever the selector names. `Destroy`, `SetExpiry` and `ReleaseClaim` refuse another cell's with `driver.ErrNotOwned` after reading the owner from the backend, never from the caller's ref. What `Capabilities` says the driver cannot do fails with `driver.ErrUnsupported`.
- A bake takes only what a clean setup claim produced, and only through the pin the agent takes before it acks `image.bake`. Nothing from a PR claim is ever named `kodus-bake/...` (S-52). Reuse goes one way: a claim may take its environment's baked image when the fingerprint matches, never the reverse. A copy of an org's data (bake or restore) runs under the driver's runtime with no network. The build cache follows the same rule: everything reads the environment's, only a setup's workload (`MachineSpec.Setup`) writes. A setup that seeds the cache (`seedsCache`, the default branch's) promotes each build's cache when that build ends, so a setup that fails later still leaves the next one a warm build; a bake promotes only what a build left unpromoted (`promoteCache`).
- A Run's canaries (claim.acquire canaries, ADR-043) are planted only in a Run's workload: the config slot in the services' env, the npmrc slot as the decoy file at `sandbox.DecoyTarget`; never in a setup's, which a bake may keep. They never go into a label, a tag, a log or a frame, and the cell does not redact them: the worker checks for them.
- A recipe's env configures the app; it never changes what runs. A new rule of that kind goes in `recipe` (`isControlEnv`), so every cell enforces it, not in one driver.

## Tests

- Every driver passes `drivertest.Run` (`internal/driver/drivertest`) on a backend that keeps state: an in-memory cluster, daemon or account in its `_test.go`. A rule every driver must keep goes in the suite, not in one driver's tests.
- Every bug fix starts with a test that fails on the old code; say in the test's comment what it used to do.
- Run before pushing: `gofmt -l .`, `go vet ./...`, `go test -race -count=1 ./...`, `~/go/bin/staticcheck ./...`, and `GOOS=linux go vet ./...` for Linux-only files.
- Time-based logic takes a `clock.Clock` (or a `now` func). Tests use `clock.Fake`, never real sleeps for retries or expiries.
- Unit tests of the agent use `newHarness` (`internal/agent/harness_test.go`). End-to-end flows use `test/integration` against `testing/hubstub`.
- Anything that touches real Docker stays behind the `dockersmoke` build tag.

## Names, errors, logs

- Log events are `noun.verb[.outcome]` (`claim.acquire`, `step.result`, `hub.nack.sent`, `claim.renew.failed`). Log through the claim's logger (`claims.Claim.Log`), which carries cell, claim and run.
- Logs are structured (`log/slog`, JSON in production). Name the phase (`claim.phase` with `phase` and `ms`). Mark what an operator must act on with `"alarm", true`.
- Never log, return in an error, or send a token, a key, a credential or a command's raw output. Output goes through `redact`; error text sent to the hub is clipped with `redact.Clip`.
- Errors carry their package (`gitsource: ...`) and wrap with `%w`. A prepare failure is `blockerErr(kind, signature, err)`: the signature is a stable snake_case name, the kind a protocol `BlockerKind`.
- Metrics are `cell_<subject>_<unit>` and counters end in `_total`. Label values come from a fixed set (kind, outcome, code), never from a host or an id.
- Exported names say what they do: `FetchExtractRevoke`, `HasLiveLease`, `Admit`. A function that records state is not called `Check`.
