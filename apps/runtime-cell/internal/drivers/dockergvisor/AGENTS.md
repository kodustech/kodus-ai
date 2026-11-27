# apps/runtime-cell/internal/drivers/dockergvisor

The cell's driver for self-hosted Linux hosts (`-driver docker-gvisor`, the default of `-driver auto` on a host): an adapter of the `internal/driver` port where each side of a Run is a compose project whose services run under gVisor (`runsc`) in the host's Docker. It holds the gVisor backend (`internal/isolation/gvisor`) on the docker placement (`internal/placement/docker`) and keeps claims, egress wiring, the build path, the registry, data copies and the sandbox pool itself. It runs in the cell process (`cmd/cell/wire.go` `wireDockerGVisor`) and, as `Reaper`, in `cmd/reaper` on the host.

## Owns
- Configuration and construction: `driver.go` `Config`, `New`, `Parts` (nearly every part: bake, reset, compose, recipes, pool, memory, diagnosis, SQL observers, sweep, sandboxes when a sandbox image is set).
- The host's Docker as split ports: `docker.go` `Docker` (`daemonPort`, `backendPort`, …); `dockercli.CLI` implements them all.
- A claim's network: `network.go` `PrepareClaim`, `ReleaseClaim`. Machines: `lifecycle.go` `Create`, `Suspend`, `Resume`, `Reset`, `Destroy`, `List`, `SetExpiry`; per-machine state `machines.go`; sizes `size.go` `ClaimMemory`; cgroup limits `claim_limits.go`; a ready claim's lowered ceiling and machine health under them, `settle.go` `SettleReady` (`Parts.ReadyMemory`), `MachineHealth` (`Parts.Health`), both only with `Config.ClaimBudgets`.
- A project's boot: `up.go` `Up`, seven steps on one `projectBoot` (sandbox, build, coverage, render, data, up, record); coverage instruments a Run's built services whose image runs Node and keeps every instrumented one (`coverage.go` `CoverageServices`, `FlushCoverage`). The compose file is rewritten and checked by `internal/compose/sandbox` before anything starts.
- Builds with rootless BuildKit under runsc: `build.go`; a claim's builds run side by side in lanes (`build_lanes.go`: a builder and registry address pair and a share of the claim's memory each, `Config.ClaimBuilds`, 4 at most, one for a seeding setup, the cell's `MaxBuilds` slots still bound them all; services naming the same build make one image; the first failing service in order is the one reported; a build killed for memory in a lane runs once more alone in the claim, and a RUN step that exits 139 runs the build once more, `docs/runtime/build-cache.md`); the image transfer (`registry.go`, subpackage `registry`); BuildKit state and exported cache (`build_states.go`, `cache.go`, `cache_remote.go`, subpackages `buildstate`, `buildcache`, `remotecache`); host directories only the cell and builder can write (`hostdirs.go`, `owner_*.go`).
- Bakes and their generations: `bake.go` `PinBakeSource`, `Bake`; `generation.go` `AcknowledgeBake`, `RecoverBakes` over `internal/bakecatalog`; data kept by a bake (`data.go`; `helper_image.go` `HelperImage`, the helper image it runs, for `cell preflight -network`) and golden data for fast resets (`golden.go`).
- Bakes shared across the org's cells (`share.go`, `Config.BakeShare`, [`docs/runtime/shared-baked-environments.md`](../../../../../docs/runtime/shared-baked-environments.md)): a published generation's images saved, checked for the setup claim's secret values and pushed off the bake's path (`shareGeneration`); a build pulls another cell's by the hub's digest (`takeShared`, from `BakeSharePull` when set) into `kodus-shared/<cell>/<org>/<env>:<fp>` and skips building; any failure builds.
- The warm fork reset (`spare.go`, `Parts.Spares`, `-gvisor-warm-fork-reset`): a machine's project runs under its own name in address block 0 or `<machine>-w` in block 1 (`projectOf`), its warm spare boots in the other from the machine's images, the bake's and the golden data (`BootSpare`), and a reset swaps it in (`TakeSpare`: kill the used copy, take its place, down it in the background). Refused with claim limits.
- The warm pool (`pool.go` `PoolCreate`, `Adopt`), code sandboxes (`sandbox.go`), exec in a service (`exec.go`, `workspace_exec.go`; `kodyexec.Request.Service` runs in that compose service's container, from its workdir, `ErrNoServiceTarget` for one the project lacks, never the public one), recipe steps (`recipe_steps.go`), a Run's decoy file (`decoy.go`), the observer's targets and SQL account (`observer.go`, `observer_sql.go`), the browser runner (`browser.go`, `browser_explore.go`).
- Expiry and cleanup: `sweep.go` `SweepExpired`, `Sweep`, `ReclaimDisk`; orphans `orphans.go`; the independent reaper `reap.go` `NewForReaper`; background work and its end `lifetime.go` `Shutdown`, `Close`.
- Diagnosis: `diagnose.go`, `service_logs.go`.
- Tool layers (`toollayers.go`, `Config.ToolLayers`, subpackage `toollayer`): the sandbox image resolved to its content digest at start (no digest, no layers), a verified layer bound read-only at `/opt/kcli/<id>` into a review sandbox and held until it ends (label `kodus.tool-layers`), the tmpfs of a layer builder, the tar stream that carries a builder's layer into the store, and the sweep that releases vanished sandboxes' holds and collects the store. `PurgeOrg` is on the part; the agent's `org.purge` handler calls it.

## Does not own
- The compose allowlist: `internal/compose/sandbox`. The docker binary and compose argv: `internal/dockercli`, `internal/composecmd`.
- runsc and the per-machine container: `internal/isolation/gvisor`. Docker networks as a placement: `internal/placement/docker`.
- Build fingerprints, the mirror's build args, trust files: `internal/buildfingerprint`, `internal/buildmirror`, `internal/machinetrust`.
- Firecracker VMs: `internal/drivers/microvm`, never a branch here.

## Rules and limits
- Root on a shared host is the threat (S-10): docker runs with a minimal environment and no interpolation file, and compose's canonical output is checked a second time before `up`.
- The boundaries of [`../../../AGENTS.md`](../../../AGENTS.md) apply in full: subpackages never import each other (the driver composes them), the bake and build-cache one-way rules, canaries only in a Run's workload, cell trust only on a claim that gets it, background work in the driver's own group ("Package boundaries", "Untrusted input").
- The agent must add the sources `Up` returns to the claim's egress policy.
- A build never shares a fixed address or a container name with another build of its claim: a new thing a build holds on the claim network takes its lane's address, or it breaks builds running together. A seeding build stays alone in its claim (the environment's one state and registry seed).
- A build section needs a builder image (`ErrNoBuilder`); the image it leaves is bounded (`-gvisor-max-image-gb`).

## Where new code goes
- A new stage of a boot: a step in `Up`'s list, in its place, with its phase.
- A new Docker call: the narrowest port in `docker.go`, `dockercli`, and `memdocker_test.go`.
- A part that stands on its own with its own lock: a new subpackage, held as a field and handed what it reads of the driver.
- A new flag: `cmd/cell`, under the `gvisor-` prefix of `flagOwners`, and the README table.

## Tests
- `go test ./internal/drivers/dockergvisor`: an in-memory Docker (`memdocker_test.go`), `drivertest.Run` and `drivertest.RunRequests`.
- Real Docker behind `dockersmoke` (`*_smoke_test.go`); under runsc on Linux, `test/gvisoregress` with `KODY_E2E_GVISOR=1`.

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (45, tests apart): `bake.go`, `browser.go`, `browser_explore.go`, `build.go`, `build_lanes.go`, `build_states.go`, `cache.go`, `cache_remote.go`, `claim_limits.go`, `coverage.go`, `data.go`, `datareset.go`, `decoy.go`, `diagnose.go`, `diskfloor.go`, `docker.go`, `driver.go`, `exec.go`, `generation.go`, `golden.go`, `helper_image.go`, `hostdirs.go`, `lifecycle.go`, `lifetime.go`, `machines.go`, `network.go`, `observer.go`, `observer_sql.go`, `orphans.go`, `owner_other.go`, `owner_unix.go`, `pool.go`, `reap.go`, `recipe_steps.go`, `registry.go`, `sandbox.go`, `service_logs.go`, `settle.go`, `share.go`, `size.go`, … and 5 more

Imports these Runtime modules:

- [`apps/runtime-cell/internal/bakecatalog`](../../bakecatalog/AGENTS.md)
- [`apps/runtime-cell/internal/browser`](../../browser/AGENTS.md)
- [`apps/runtime-cell/internal/buildfingerprint`](../../buildfingerprint/AGENTS.md)
- [`apps/runtime-cell/internal/buildmirror`](../../buildmirror/AGENTS.md)
- [`apps/runtime-cell/internal/buildprogress`](../../buildprogress/AGENTS.md)
- [`apps/runtime-cell/internal/checkoutfs`](../../checkoutfs/AGENTS.md)
- [`apps/runtime-cell/internal/claimlimits`](../../claimlimits/AGENTS.md)
- [`apps/runtime-cell/internal/clock`](../../clock/AGENTS.md)
- [`apps/runtime-cell/internal/compose`](../../compose/AGENTS.md)
- [`apps/runtime-cell/internal/compose/sandbox`](../../compose/sandbox/AGENTS.md)
- [`apps/runtime-cell/internal/composecmd`](../../composecmd/AGENTS.md)
- [`apps/runtime-cell/internal/dockercli`](../../dockercli/AGENTS.md)
- [`apps/runtime-cell/internal/driver`](../../driver/AGENTS.md)
- [`apps/runtime-cell/internal/drivers/dockergvisor/buildcache`](buildcache/AGENTS.md)
- [`apps/runtime-cell/internal/drivers/dockergvisor/buildstate`](buildstate/AGENTS.md)
- [`apps/runtime-cell/internal/drivers/dockergvisor/registry`](registry/AGENTS.md)
- [`apps/runtime-cell/internal/drivers/dockergvisor/remotecache`](remotecache/AGENTS.md)
- [`apps/runtime-cell/internal/drivers/dockergvisor/toollayer`](toollayer/AGENTS.md)
- [`apps/runtime-cell/internal/isolation`](../../isolation/AGENTS.md)
- [`apps/runtime-cell/internal/isolation/gvisor`](../../isolation/gvisor/AGENTS.md)
- [`apps/runtime-cell/internal/kodyexec`](../../kodyexec/AGENTS.md)
- [`apps/runtime-cell/internal/lifecycle`](../../lifecycle/AGENTS.md)
- [`apps/runtime-cell/internal/machinetrust`](../../machinetrust/AGENTS.md)
- [`apps/runtime-cell/internal/observer`](../../observer/AGENTS.md)
- [`apps/runtime-cell/internal/observerauth`](../../observerauth/AGENTS.md)
- [`apps/runtime-cell/internal/placement`](../../placement/AGENTS.md)
- [`apps/runtime-cell/internal/placement/docker`](../../placement/docker/AGENTS.md)
- [`apps/runtime-cell/internal/protocol`](../../protocol/AGENTS.md)
- [`apps/runtime-cell/internal/recipe`](../../recipe/AGENTS.md)
- [`apps/runtime-cell/internal/redact`](../../redact/AGENTS.md)

Imported by:

- [`apps/runtime-cell/cmd/cell`](../../../cmd/cell/AGENTS.md)
- [`apps/runtime-cell/cmd/reaper`](../../../cmd/reaper/AGENTS.md)

<!-- module-map:end -->
