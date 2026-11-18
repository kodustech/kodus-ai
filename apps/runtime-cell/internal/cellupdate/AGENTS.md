# apps/runtime-cell/internal/cellupdate

`cell update`: installs a cell release on a host only after its `SHA256SUMS` signature verifies offline against a pinned key (S-17, [isolation-p3-snapshots.md](../../../../docs/runtime/isolation-p3-snapshots.md)), and swaps `current` and `previous` in the installer's layout so the release before stays one rollback away. It runs as a subcommand of the cell binary (`cmd/cell/main.go`), never as part of a serving cell.

## Owns
- `cellupdate.go` `Install`: copy each `Required` command into `<root>/releases/<release>-<id>/bin/`, match every file against the signed manifest, then swap the links. `Options.VerifyOnly` checks and installs nothing.
- `Run`: the command's flags and exit codes (0 installed or verified, 1 refused, 2 usage).
- `preflight.go` `StagedPreflight`: before the swap, the staged release's `cell preflight -config <-preflight-config>` (default `$KODUS_CELL_CONFIG`); a non-zero exit keeps the installed release current and leaves the staged one for the next try. With no config `Run` refuses (exit 2), naming `-preflight-config`, `KODUS_CELL_CONFIG` and `-skip-preflight`, the only way to swap without it (said on stderr). `-verify-only` needs none.
- `index_state.go`: the release index gate. A release installs only under a current signed index (`releasesig.VerifyIndex`, `-index`, default `-from`) that allows it (`allowedByIndex`: between `minimum` and `latest`, or exactly `latest` when not semver), signed by a key no index ever revoked. `<root>/release-index.state` keeps the latest `issued`, every revoked key the host saw, the highest `minimum` (the security floor) and the key that signed each installed release: an older index is refused, a revocation is never forgotten, the floor never drops, an unreadable state is refused rather than read as empty.
- `protocol.go` `checkProtocol`: the hub's skew policy before the swap. The release's signed `PROTOCOL` (`releasesig.ReadProtocol`) against the cell's `hub-protocol.state` (`internal/hubprotocol`, `Options.HubState`): a highest protocol above the hub's highest (`cell_too_new`) or below its lowest (`cell_too_old`) is refused, naming both and the fix. `Run` finds the state under the cell's `-state-dir`, given or resolved from `-preflight-config` by the cell's own settings (`stateDirOf`, `cmd/cell` `cellStateDir`). No `PROTOCOL` (an older release) or no state (never connected): installed with a note on stderr; `-require-protocol` refuses the first, `-skip-protocol-check` skips the check.
- `watch.go`, the automatic rollback. `Install` with `Options.RollbackWindow` (`-rollback-window`, default 10 minutes) writes `<root>/update-pending.json` right before the swap, when there is a release to return to: the release, its directory, the one before, the swap time, the deadline and the cell's `hub-protocol.state` (`Options.HelloState`, under the same `-state-dir`). `Watch` (`RunWatch`, `cell update-watch`, run every minute by the host's `kodus-cell-update-watch.timer` from `previous/bin/cell`) keeps the release once the state's `at` is after the swap, waits inside the window, and otherwise lists it in `<root>/rolled-back.json`, swaps `current` back, puts back the release's own `cell.env` and `systemd/` units, restarts `kodus-cell.target` and prints one line naming both releases and the reason. A marker whose release is no longer current (moved by hand) is dropped. The watch never returns to a release below the state's floor (or not semver while a floor is set) or signed with a key revoked since (`belowFloor`): it keeps the new release, drops the marker, says why and exits 1 (`HeldAtFloor`). `checkProbation` (in `Install`, before anything changes) refuses a listed release unless `-retry-rolled-back`, and any other release while the current one has not connected since its swap.
- `order.go` `checkOrder`: downgrade protection. Release names are ordered as semver; a lower release, or one that cannot be ordered against the installed one, is refused unless `-allow-downgrade`.

## Does not own
- The signature format and the pinned keys: `internal/releasesig` (`releasesig/keys`).
- Signing a release: `cmd/release-sign`, which never ships to a host.
- The layout and the manual rollback (`cell-host.sh rollback`, which drops the marker): the installer's host script. The timer and service that run the watch: the host's units (the installer's, from `deploy/docker-gvisor/kodus-cell-update-watch.*`).

## Rules and limits
- The release already installed runs the update: a binary never vouches for itself. The staged release judges the host (its requirements may be new) only after every file matched the signed manifest.
- Nothing under the root changes until every file was copied and matched; a refusal names the file.
- A release installed before is reused only when it still matches the manifest.
- A dev build (`v0.0.0-dev+<sha>`) sorts below every release; an installed binary that is not semver (a local build) refuses nothing.
- It never dials the hub: the skew check reads what the hub said at the cell's last accepted hello. A state that does not read is refused, never taken for none; a hub upgraded while the cell was down is seen only after the cell reconnects ([cell-distribution.md](../../../../docs/runtime/cell-distribution.md), "Keeping hub, worker, API and cell compatible").
- The protocol check runs before anything under the root changes, `-verify-only` included.
- The watch never runs from the release on probation (a cell that crashes at start cannot keep itself), never dials anything (two local files, two links, local copies, `systemctl`), and only moves `current` back. The health signal is the agent's own `hub-protocol.state`: a hello before the swap does not count; a state this cell cannot parse (a newer release may add a field) counts by its modification time. A rolled-back release is remembered before the links move, so no stop makes it retried by itself; a rollback cut short (the restart failed) is finished by the next look.
- Known limit: the window starts at the swap, not at the restart. A hello the old process makes between the two counts for the new release, and a release left un-restarted past the window is rolled back; `cell-host.sh upgrade` restarts at once.

## Where new code goes
- A new command shipped with the cell: `Required`, and the release workflow's assets.

## Tests
- `go test ./internal/cellupdate` (temporary directories, generated keys). With the real agent and a hub stub: `test/integration` `TestTheWatchReadsTheAgentsHelloAfterTheSwap`.

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (6, tests apart): `cellupdate.go`, `index_state.go`, `order.go`, `preflight.go`, `protocol.go`, `watch.go`

Imports these Runtime modules:

- [`apps/runtime-cell/internal/hubprotocol`](../hubprotocol/AGENTS.md)
- [`apps/runtime-cell/internal/releasesig`](../releasesig/AGENTS.md)
- [`apps/runtime-cell/internal/version`](../version/AGENTS.md)

Imported by:

- [`apps/runtime-cell/cmd/cell`](../../cmd/cell/AGENTS.md)

<!-- module-map:end -->
