# Exercised lines: proving the change ran

Status: decided 2026-11-17. Node is built end to end (section 9 lists what is built and what
is left). Every claim about a tool cites its own documentation (Sources, at the end).

## 1. Problem

A Run says `no_regressions` when every probe agreed between base and PR. That says nothing about which changed lines
ran: a PR that edits a handler no probe called passes the same way as one whose every line ran. CodeRabbit's Runtime
Verification marks a finding "target exercised"; Greptile TREX runs the PR branch. We go one step further and count
it: for each Run, how many of the PR's changed executable lines ran on the PR side during the probes, and a Run whose
change barely ran is never `no_regressions`.

## 2. Mechanism per language

The rule for every language: no rebuild of the app the recipe builds, coverage switched on by what the cell injects
into the Run's services (env, a preload, an agent flag), flushed by the cell after the probes without stopping the
service, read inside the claim.

| Language | Switch (cell injects) | Flush without stopping | Output | Maps to source |
|---|---|---|---|---|
| Node | `NODE_V8_COVERAGE=<dir>` and `NODE_OPTIONS` += `--require <preload>` | preload: `SIGUSR2` calls `v8.takeCoverage()` | V8 JSON per process: `result[].functions[].ranges` (offsets, counts) | script url suffix = repo path; transpiled TS through the JSON's `source-map-cache` or the script's `sourceMappingURL` |
| Python | `COVERAGE_PROCESS_START=<rc>` and a `.pth`/`sitecustomize` that calls `coverage.process_startup()` | coverage.py saves at exit; the preload registers a signal handler that calls `Coverage.current().save()` | `.coverage` data file (SQLite, line numbers) | paths are source paths, no map needed |
| Go | needs a `go build -cover` binary; the cell sets `GOCOVERDIR=<dir>` | Go 1.20+ writes at exit; `runtime/coverage.WriteCountersDir` needs code in the app, so the cell stops the service (`SIGTERM`, grace) after the probes | `covmeta`/`covcounters`, read with `go tool covdata textfmt` | file paths are import paths, matched by suffix |
| JVM | `JAVA_TOOL_OPTIONS` += `-javaagent:<jacocoagent.jar>=destfile=…,output=tcpserver` | JaCoCo's tcpserver `dump` command | `jacoco.exec`, line counters need the class files | class files of the built image, sources by package path |

Go needs the build to change (`-cover`): that is a build arg the cell adds only when the recipe's build is a plain
`go build`, else Go is "not measured". JVM needs the agent jar in the cell's kit. Neither ships in this slice.

## 3. What is collected, when

1. Boot: for a Run's services whose recipe runtime is the language (never a setup or a bake, so a golden snapshot never
   holds coverage switches), the cell injects the switch on both sides. Base gets it for symmetry (same overhead on both
   sides, so latency comparisons stay fair); only the PR side is read.
2. The worker, after the probes, asks the cell for exercised lines with the changed executable lines of the diff: per
   changed JS/TS file, the new-side line numbers of added or modified code rows (comments, blank lines, tests and docs
   excluded), bounded in count.
3. The cell flushes the PR side's services, reads the coverage files from the claim's directory (bounded in size),
   maps ranges to lines and answers per file `{ path, changedLines, exercisedLines, status, reason }`.

## 4. Mapping (Node)

- A character counts with its innermost enclosing V8 range; a line ran when any non-blank character on it has a count
  above zero. Function and block ranges nest, so a handler never called keeps count 0 while its module loaded.
- A script maps to a repo file when its path ends with `/` + the repo path. A transpiled file maps through its source
  map: a source line ran when a generated segment mapping to it lies in a counted character. A changed line no segment
  maps to does not count as ran.
- A changed file no script maps to is `unknown`, unless another JS/TS file of the same Run mapped (mapping proven), then
  it is measured with 0 (the file never loaded). No coverage written at all: every file `unknown`. Nothing is guessed.

## 5. Where it is stored, privacy

Coverage files stay in the claim's directory on the cell and go with the claim. Only counts leave the cell: per changed
file, the number of changed lines and of exercised lines, and a reason code. No source text, no range, no path outside
the diff. The report stores those counts; the Run page and the PR comment show them.

## 6. Cost

V8 block coverage adds CPU on hot paths: it keeps counters per block and disables some optimizations (V8 blog,
Sources); we have not measured it on our repos yet, the first Runs record boot and probe time with it on. One JSON
file per process is written at each flush. Both sides pay it, so the
base/PR comparison is unaffected. The flush is one signal and a bounded wait; mapping is linear in the coverage size.

## 7. Verdict rule

- Sum the measured files: N exercised of M changed. When M > 0 and N/M is below the threshold, a Run that would be
  `no_regressions` is `partly_tested`, reason "N of M changed lines ran, below the T% this repo asks".
- The threshold is a whole percent from 0 to 100. An org admin sets it in Runtime settings ("Changed lines
  exercised"). An org that set none gets the deployment's `RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT` (default 50).
  0 means the count never changes the verdict.
- A Run is judged by the value it started with: the product reads the org's setting when it builds the Run request
  and sends it in the request. Changing the setting later does not change a Run already asked.
- Unknown files count in neither N nor M. Nothing measured (all unknown, an unsupported language, a cell without the
  `exercised_lines` feature): the verdict is unchanged and the fact reads "not measured for <language>".
- The rule never upgrades a verdict and never changes `regressions` or a halted Run.

## 8. Order of the full plan

1. Node, end to end (this slice): protocol, cell injection and collection on docker-gvisor, mapping, worker, verdict,
   Run page, PR comment.
2. Node on the microVM driver: the same injection through the guest's compose env.
3. Python: the `.pth` preload in the cell's kit, the `.coverage` reader.
4. Go: the `-cover` build arg on plain `go build` recipes, `covdata` parsing.
5. JVM: the JaCoCo agent jar in the kit, tcpserver dump, class-file line tables.
6. Per-probe attribution (which probe ran which line), from a flush between probes.

## 9. Built in this slice, and gaps

Built (Node, docker-gvisor):

- Protocol: `claim.exercised` `{stepId, exercised}` on the PR claim, answered by `step.result.exercised`
  (`libs/runtime/protocol/messages.ts`, `EXERCISED_LINES_LIMITS`: 200 files, 2000 lines per file), hello feature
  `exercisedLines`. The cell sends its whole list; a hub older than the 64-feature change refuses a hello past 32
  (a nack, or no answer since it nacks without `re`), and the cell's next hello then leaves `exercisedLines` out, the
  one after that tries the whole list again (`agent/session.go`). The hub sends the frame only to a session that named
  it.
- Cell: `internal/compose/node_coverage.go` (env; image services in the agent, built ones in the driver after the build), `sandbox.Options.Coverage` (the dir writable at
  `/run/kodus-coverage` on the instrumented services only, any other mount there refused), `driver.UpRequest.Coverage`,
  `Parts.Coverage` (`compose kill -s SIGUSR2`), `internal/agent/coverage` and `agent/exercised.go` (flush, wait at most
  3 s on the clock, `internal/exercised` maps), `-exercised-lines` on by default. microvm and k8s have no flusher and
  answer `unsupported_driver`.
- The coverage directory's bound (section 10): a tmpfs the cell mounts over `<claim>/coverage`
  (`agent/coverage` `Tmpfs`, 65 MiB and 256 files), released before the claim's directory goes, recovered at start.
- Worker and hub: `entry-points/executable-lines.ts` (the lines sent), durable step `exercised` in
  `run-orchestrator.ts`, `RunDeps.requestExercised` through `POST internal/claims/:id/exercised`.
- Verdict: `run/exercised-lines.ts`, applied in `run-state.ts` `decideRunVerdict`; threshold from the Run request's
  `exercisedLinesThresholdPercent` (the org's setting), else `RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT` (default 50,
  `contracts/limits.ts`).
- Setting: `runtime_settings.exercised_lines_threshold_percent` (migration `2026111700000001`), read and written by
  `GET`/`PATCH /runtime/settings` (`settings.use-cases.ts`, Update on OrganizationSettings, as the token budget),
  put in the request by `RuntimeRunRequestBuilder`. The API reads the same env var only to show the default.
- Report `exercised` (`run-report.ts`, `run-projection.ts`), the verdict card fact and per-file lines in What Kody
  tested, the PR comment line.

Gaps, in the order they get done:

1. Closed: the coverage dir has a size cap (section 10).
2. Closed, not a gap on docker-gvisor (read 2026-11-17): a pool machine is a network, a holder and the bake's data,
   with no project running (`dockergvisor/pool.go` `PoolCreate`). The claim that adopts it still runs
   `prepare.compose` and `bootCompose`, so both sides are instrumented from their own boot, and the counters start
   inside the claim. Tests: `TestAPoolMachineRunsNoProjectUntilAClaimBootsIt` (driver) and
   `TestRunClaimsOnPoolMachinesAreInstrumentedFromTheirOwnBoot` (agent, base and PR). A driver whose pool machines run
   the project before a claim (none flushes coverage today) must flush and discard at the claim's start.
3. Closed: a service built from a Dockerfile is instrumented when its built image runs Node. After the build,
   docker-gvisor reads the image's config (`docker image inspect`, `.Config`) and `compose.IsNodeImageConfig` decides:
   `NODE_VERSION` (every image `FROM node` keeps the official images' variable), or a command, the service's own over
   the image's, whose program is node, npm, npx, pnpm, yarn or tsx (also as a shell's `-c` first word). An entrypoint
   script, a wrapper or an unreadable config is not Node, and gets nothing. `NODE_OPTIONS` keeps the service's own, else
   the image's (compose's value would replace it), with the preload appended; an image value with a `$` is left out.
   A service with a build section is no longer judged by the name it tags its image with. The driver names every
   instrumented service after each Up (`CoverageFlusher.CoverageServices`), and the agent flushes those.
4. The threshold is set per org only. No Runtime setting has an org value with a per-repo override yet, so there is
   no pattern to follow for one; a repo override waits for that decision. Also, the request field is new: deploy the
   runtime-worker before the API, or an older worker refuses the Run request of an org that set a threshold.
5. TS output `exports.f = f` maps back to the declaration line of `f`, which then counts as ran even when `f` did not.
6. Adjacent `.map` files and inline data-URI maps are not read; only the coverage JSON's `source-map-cache`.
7. The new durable step changes the Run workflow: deploying needs a new `RUNTIME_RELEASE_VERSION`.
8. Then section 8 from step 2 on.

## 10. The coverage directory's bound

The services write `<claim>/coverage` through a bind, which is outside their writable layer's `storage_opt` cap
(and that cap is off on most hosts). Unbounded, a PR could write there until Docker's disk filled.

What the cell runs as. The dev cell starts as root (`apps/runtime-cell/scripts/dev-gvisor-cell.sh` refuses any other
user), the host steps run under `sudo` (`docs/runtime/self-hosted.md`, "Host preflight"), the reaper unit sets no
`User=` (`deploy/docker-gvisor/kodus-cell-reaper.service`), and the cell already calls mount(2) for its build state
overlays, which Docker then binds into builders (`drivers/dockergvisor/buildstate/mount_linux.go`, "the cell runs as
root"). No unit for the agent itself is in the tree (`docs/runtime/cell-distribution.md` item 3). So the cell has
`CAP_SYS_ADMIN` in the host's mount namespace: a size-limited mount needs no new privilege.

Choice: a tmpfs mounted over the directory by the cell (`agent/coverage` `Tmpfs`):

- `size=65 MiB` (just above `exercised.MaxCoverageBytes`, so coverage that hit the cap reads as `coverage_too_large`,
  never as a quiet undercount), `nr_inodes=256` (the reader takes 64 files), `mode=1777`, `nosuid,nodev,noexec`.
  Past either bound, the write fails with `ENOSPC` in the PR's own process. Proven under runc
  (`tmpfs_linux_test.go`, as root on Linux) and under runsc release-20261116.0 by hand: an OCI bundle binding a 1 MiB
  tmpfs got a 1 MiB file from `dd` asking 4 MiB, and its 15th file was refused (16 inodes).
- The pages are host memory, charged to the cgroup that wrote them (cgroup v2, "Memory Ownership"); the size bounds
  them whatever the cgroup.
- A mount Docker cannot see is no bound: the services would write the directory under it. `Cap` refuses unless the
  cell shares the init process's mount namespace (a unit with `PrivateMounts=` or `PrivateTmp=` runs in its own, and
  its mounts do not propagate back). A claim whose directory cannot be capped (that, no root, not Linux) is booted
  uninstrumented (`claim.coverage.uncapped`) and reads `no_coverage_written`. Not caught: a cell run as a privileged
  container with the Docker socket. Its init is its own, so the check passes, yet Docker never sees its mounts. A
  cell in a default container has no `CAP_SYS_ADMIN` and is refused at the mount.
- Not counted in the cell's memory admission: up to 65 MiB of host memory per instrumented machine, two per Run.
- The cap lives as long as the claim: a reset's boot keeps it and its files. Release unmounts it before removing the
  claim's directory; a cell that stopped without its releases has its caps unmounted at the next start
  (`Tmpfs.Recover`, from `/proc/self/mountinfo`).

Not chosen:

- A loop-mounted image file: the same privilege, plus a file on the disk being protected and a loop device per claim.
- A tmpfs inside the services (compose `tmpfs` with `size=`) and a bounded copy out. Under runsc such a tmpfs lives in
  the sandbox, and `docker cp` cannot copy tmpfs mounts (Docker's `cp` reference), so the copy would need an exec of
  a reader inside the PR's own container, per poll. It is also lost at every reset and at a service's restart.
- A Docker volume of the local driver with `type=tmpfs,o=size=` (the daemon mounts it, no privilege of the cell's).
  Compose names it only as an `external` volume, which the allowlist refuses on purpose, and the local driver unmounts
  it when no container uses it, so its files are gone at each reset unless a container of the cell's holds it.

## 11. Trust: the coverage is the PR's own

The coverage files are written by the PR's own Node processes (`NODE_V8_COVERAGE`, the preload's `v8.takeCoverage`),
into a directory they can write. A PR can therefore write a file that says every changed line ran, or write none.
Nothing inside the claim is out of the PR's reach: V8 counts in the PR's process, and the preload runs there too.
What the cell does (`internal/exercised`):

- Only the scripts that map to a changed file are decoded and painted, under one budget per answer (`MaxPaint` range
  units, every file together), one mapping at a time on the cell, for at most 30 s (`agent/coverage` `MaxMeasure`).
  Past it: `coverage_too_large`.
- A script counts for a changed file only when its shape is the checkout's: a plain script exactly as long as the
  file, a source map whose `sourcesContent` (when carried) is the file's text and that maps no line past its end.
  Otherwise `unmapped_source`. The shape is checked before anything is painted.
- A coverage file counts only when a process the cell's preload started wrote it: the preload leaves a
  `started-<pid>-<ms>` marker per Node process (`StartMarkerPrefix`), and a file whose pid has none is skipped, so a
  file another writer drops can only lower the count.
- Coverage no V8 writes (a negative or reversed range, a block outside its own function's range, `lineLengths` of a
  generated script that do not add up to the script's own length, JSON of another shape) fails closed (`Untrusted`): every JS file of the request is answered measured with 0 of its lines run, so a green Run is
  held back (`partly_tested`, "0 of N changed lines ran"), and the cell logs `claim.exercised.untrusted` with an alarm.

What it cannot do: tell a forgery shaped like V8's output, written by a process the preload started, from the real thing, or tell a PR that suppressed its
coverage (`no_coverage_written`) from one whose services are not Node. So the count is advisory against a hostile PR:
it can hold a Run back, and a forged count only gives back the verdict the Run would have had without the feature. It
never upgrades one (section 7). Since 2026-11-18 a Run held back this way concludes its check `action_required` (unless the org chose neutral). Open, for the verdict's owner: a dedicated reason for untrusted coverage (today it
reads as "0 of N ran"), and holding back a PR side whose instrumented services wrote no coverage while its base side's
did.

## Sources

- Node `NODE_V8_COVERAGE`: https://nodejs.org/api/cli.html#node_v8_coveragedir
- Node `v8.takeCoverage()`: https://nodejs.org/api/v8.html#v8takecoverage
- c8 (V8 coverage to Istanbul): https://github.com/bcoe/c8 and https://github.com/istanbuljs/v8-to-istanbul
- V8 block coverage: https://v8.dev/blog/javascript-code-coverage
- coverage.py subprocesses: https://coverage.readthedocs.io/en/latest/subprocess.html
- Go integration coverage: https://go.dev/doc/build-cover
- JaCoCo Java agent: https://www.jacoco.org/jacoco/trunk/doc/agent.html
- tmpfs `size`, `nr_inodes`, `mode`: https://docs.kernel.org/filesystems/tmpfs.html; `ENOSPC` past them: `mm/shmem.c`
- mount(2) and `CAP_SYS_ADMIN`: https://man7.org/linux/man-pages/man2/mount.2.html; namespaces and propagation:
  https://man7.org/linux/man-pages/man7/mount_namespaces.7.html
- cgroup v2 memory ownership: https://docs.kernel.org/admin-guide/cgroup-v2.html
- gVisor bind mounts (not overlaid by default, `--file-access-mounts=shared`): https://gvisor.dev/docs/user_guide/filesystem/
- `docker cp` and tmpfs: https://docs.docker.com/reference/cli/docker/container/cp/
- CodeRabbit "target exercised" and Greptile TREX: as described in the product brief, not re-read for this doc.
