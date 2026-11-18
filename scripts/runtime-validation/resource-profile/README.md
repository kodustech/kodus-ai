# Passive resource profile

Reproducible collectors for [#2459](https://github.com/kodustech/kodus-ai/issues/2459). They observe explicitly named existing targets; they do not start workloads or discover credentials. Python uses only the standard library. The optional Node helper uses the repository's installed `e2b` SDK.

From the repository root, provide the Docker Unix socket and repeat `--container` for each target:

```sh
python3 scripts/runtime-validation/resource-profile/collector.py \
  --socket /var/run/docker.sock \
  --container runtime-worker --container runtime-hub \
  --duration 60 --interval 2 --timeout 3 \
  --output /tmp/runtime-profile-new.jsonl
```

Use actual existing container names or IDs. The example names are placeholders. The socket is explicit: the collector does not read Docker contexts, environment variables, configuration files or SSH settings. It sends only `GET /version` and versioned `GET /containers/{target}/stats?stream=false&one-shot=true`. No container listing, inspection, exec or lifecycle calls occur.

Omit `--output` for stdout. Files are created exclusively with mode `0600`; an existing file is refused, including a symlink. Each JSONL row is one snapshot. `--duration 0` takes exactly one snapshot. Duration is at most 7,200 seconds, interval 0.2–300 seconds, request timeout 0.1–30 seconds, and there are at most 16 distinct targets. Up to eight requests run concurrently. An individual failure produces a target error without stopping the other samples. A final snapshot can finish after the requested duration by its request timeouts; sampling never starts another snapshot after the deadline.

The Docker CLI exits `0` only if at least one valid container measurement was collected during the run. If every target always fails or returns empty stats, it exits `1` and preserves the error rows. A first sample with cumulative CPU and memory counters counts as a measurement even without an interval CPU rate. Zero network counters are valid measurements, not errors. Mixed profiles can exit `0` while retaining failed targets in their output.

## Docker fields and gaps

| Field | Meaning |
| --- | --- |
| `at`, `elapsedSeconds` | UTC snapshot completion time and monotonic elapsed seconds. |
| `name`, `id` | Explicitly selected target and the Docker container ID returned by stats. |
| `cpuTotalNs` | Docker's cumulative container CPU nanoseconds. |
| `cpuCoresInterval` | CPU counter delta / 1e9 / monotonic seconds between valid responses. `1` means one CPU core averaged across that interval, not one percent. |
| `cpuIntervalSeconds` | Actual interval used by the CPU rate, including any missed samples. |
| `memoryUsageBytes`, `memoryLimitBytes` | Docker memory usage and limit in bytes. |
| `memoryCacheBytes`, `memoryWorkingSetBytes` | Inactive file bytes (`inactive_file`, falling back to `total_inactive_file`), and usage minus that value, clamped at zero. Omitted when the cache counter is absent. |
| `pids`, `networkRxBytes`, `networkTxBytes` | Current PID count and cumulative network byte counters, when supplied. |

The first valid sample has no CPU interval rate. Timeouts, empty stats and HTTP failures are gaps and preserve the previous valid baseline. A lower CPU counter or a new container ID sets `cpuCounterReset: true`, omits the rate and starts a new baseline. A nonpositive clock interval sets `cpuClockGap: true` without replacing the baseline. No gap becomes zero CPU. Error output contains only a closed code and, for HTTP failures, a numeric status; raw bodies and exception messages are omitted. There are no labels, environment values, image names or command arguments in output.

## Optional historical E2B metrics

```sh
node scripts/runtime-validation/resource-profile/e2b-metrics.mjs \
  --sandbox YOUR_EXISTING_SANDBOX_ID \
  --start 2026-11-07T12:00:00Z --end 2026-11-07T12:05:00Z \
  --output /tmp/e2b-profile-new.jsonl
```

The key must already be in `E2B_API_KEY` or `API_E2B_KEY`. It stays in memory and is never included in output. The helper accepts at most two explicit sandbox IDs and a window of at most two hours. It calls only static `Sandbox.getMetrics(id, {start, end, apiKey, requestTimeoutMs: 5000})`; no list, connect, create, renew or kill calls occur. Output contains only the sandbox ID, normalized timestamp and known finite numeric metrics within the requested window. Failed requests emit `metrics_unavailable` without raw errors.

The E2B CLI exits `1` when no actual numeric metric sample remains: unavailable targets, empty histories, samples outside the window and timestamp-only rows do not count. Output is preserved. At least one known numeric metric, including a legitimate zero, makes an in-window sample valid; mixed profiles with a valid sample may exit `0`.

`cpuUsedPct` and `cpuCount` stay exactly as supplied by E2B; no conversion to cores is assumed. `memUsed`, `memTotal`, `memCache`, `diskUsed` and `diskTotal` are bytes. Docker CPU rates and E2B CPU percentages have different definitions and should not be summed. The SDK API was verified against installed `e2b/dist/index.d.ts` (`SandboxMetricsOpts`, `SandboxMetrics`, static `Sandbox.getMetrics`). E2B tests inject a client; no cloud call is needed.

## Checks and limits

```sh
python3 -m unittest discover -s scripts/runtime-validation/resource-profile -p 'test_*.py'
node --test scripts/runtime-validation/resource-profile/e2b-metrics.test.mjs
```

These collectors do not measure application correctness, workload throughput, DBOS queue fairness, host/process `/proc` counters, or cell admission reservations. Docker memory counters differ from host memory accounting and from peak build reservations. The sampler cannot attribute memory to a Run or infer the number of Runs a machine can support. No capacity or large-load result follows from a passive snapshot.

A 45-second local development baseline recorded 405 valid observations of the nine existing containers. It identifies the older integration source mount and deliberately makes no claim about real PR load or the new Runtime branch.

## Offline analysis by component and window

`analyze_cgroups.py` reads **one existing cgroup_collector capture**, without
opening Docker, `/proc`, credentials, a network connection or a service. Supply
the component aliases and windows explicitly. Window bounds must use the same
host monotonic clock as the capture's `atMonotonicSeconds`; UTC timestamps and
Docker `elapsedSeconds` cannot be substituted. Do not concatenate captures from
different hosts/boots. Capture the monotonic boundaries on the measured host
when defining a benchmark phase; wall-clock Run phases require a separately
validated clock mapping before they can be used here.

```json
{
  "version": 1,
  "windows": [
    {"name": "probe", "startMonotonicSeconds": 1000, "endMonotonicSeconds": 1030}
  ]
}
```

```sh
python3 scripts/runtime-validation/resource-profile/analyze_cgroups.py \
  --samples /tmp/owned-cgroups.jsonl --windows /tmp/owned-windows.json \
  --component claims --component browser --output /tmp/owned-analysis-new.json
```

Use actual observed bounds/aliases. Inputs are bounded regular files; leaf
symlinks, duplicate JSON keys, invalid counters and duplicate components refuse.
The windows file accepts only its exact schema (32 windows, at most2hours each).
The capture is streamed, capped at64MiB/100,000 rows/256KiB per row and16 components.
Output is exclusively created with mode0600, includes both input hashes, and
contains only selected names and numeric measurements. Raw error text, paths,
commands and unknown fields from captures are not copied.

| Result | Interpretation |
| --- | --- |
| `cpuSeconds` / `cpuCoverageSeconds` | Same-identity CPU counter deltas whose two samples are wholly inside the window; boundary intervals are excluded, never prorated. |
| `meanCpuCores` / `cpuCoverageFraction` | Average cores over covered intervals, plus the fraction of window time actually covered. No interval yields null CPU, while a measured zero stays zero. |
| `sampledChargedPeakBytes` | Highest `memoryCurrentBytes` observed inside the window; a lower bound on its peak, not RSS or the historical `memory.peak`. |
| `errorSamples`, `counterResets`, `clockGaps` | Missing reads/replaced cgroups/counter or clock problems remain visible. An error does not erase the last valid baseline; same-identity counter deltas can cover that gap. |
| `throttledSeconds`, `throttledPeriods`, `oomEvents`, `oomKillEvents` | Deltas, never lifetime totals. Each has its own `counterCoverageSeconds`; an absent/reset optional counter does not become a measured zero. |

Each component/window is independent. The analyzer never sums a parent and its
children or sums independently timed peaks. Overlapping windows are allowed but
must not be added together. Exit0 means at least one selected valid memory/CPU
sample exists, not full phase coverage;1 means none was measured (report retained);
2 means input/output was refused with a fixed diagnostic. It does not infer
queue latency, throughput, p99, concurrency, VM packing or Redis/language benefit.
Those require controlled workload measurements alongside this resource evidence.

## Native Linux cgroup v2: two-PR profile

The separate `cgroup_collector.py` follows the [#2459 extension design](https://github.com/kodustech/kodus-ai/issues/2459#issuecomment-6722968521). It observes explicitly selected existing cgroups; it never discovers containers, creates workloads, resets peak counters, writes cgroup files or reads credentials. `collector.py` and its Docker GET-only contract are unchanged.

Prepare a strict manifest with **one or two PR aliases** and at most **16 named components**. An alias identifies the two approved real PRs in the accompanying Run manifest; it does not trigger a PR. Paths are relative to the explicitly supplied cgroup root. Set `pr` only when that whole component belongs to that PR; leave shared roots/services unassigned.

```json
{
  "version": 1,
  "prs": ["shop-2", "shop-3"],
  "components": [
    {"name": "claims", "path": "kodusCELL.slice", "role": "claim"},
    {"name": "pr2-base", "path": "kodusCELL.slice/kodusCELL-CLAIM.slice", "role": "claim", "pr": "shop-2"},
    {"name": "cell", "path": "system.slice/kody-cell.service", "role": "cell"}
  ]
}
```

Replace the example paths with observed current paths and record Run → base/PR claim → physical network/cgroup mapping separately. Components accept only `name`, `path`, `role`, and optional `pr`; unknown fields, duplicate paths/names/JSON keys, traversal, symlinks and an undeclared PR alias are refused. Roles are `claim`, `cell`, `hub`, `worker`, `api`, `webhooks`, `database`, `broker`, `egress`, `resolver`, `injector`, `registry`, `builder`, `observer`, `browser` or `other`. The manifest is bounded to 64 KiB.

On the Linux host that owns those cgroups:

```sh
python3 scripts/runtime-validation/resource-profile/cgroup_collector.py \
  --root /sys/fs/cgroup --manifest /tmp/owned-two-pr-profile.json \
  --duration 900 --interval 1 --timeout 3 \
  --output /tmp/two-pr-cgroups-new.jsonl
```

The production CLI validates the root and every target with Linux `fstatfs` against the cgroup v2 filesystem type. It opens directories and the fixed counter-file allowlist relative to descriptors without following symlinks, checks device/inode before and after reading, and rejects a replaced target mid-sample. It pins at most 16 target directory descriptors throughout the window, including while a target path is missing; an old pin closes only after a successful sample safely pins its replacement. All pins close at collector shutdown. Each counter file is at most 64 KiB. Unit tests inject a filesystem validator into the Python class for temporary fixtures; **there is no CLI bypass** for non-cgroup filesystems.

| Field | Definition |
| --- | --- |
| `identity`, `id` | Device/inode identify the pinned cgroup epoch. Nanosecond ctime is recorded as metadata, not identity: child creation/deletion changes it. Identity parts are strings to preserve precision. |
| `metadataChanged`, `metadataChangedDuringRead` | Directory ctime changed between samples or during this read. With the same pinned device/inode and monotonic CPU counter, CPU deltas continue; a browser starting does not manufacture a reset or erase memory samples. |
| `cpuTotalNs`, `cpuDeltaNs` | Cumulative `cpu.stat usage_usec` converted to nanoseconds, then the difference from the previous valid response in the same epoch. |
| `cpuCoresInterval`, `cpuIntervalSeconds` | CPU delta divided by monotonic elapsed time; one means one average CPU core. First/reset samples have no rate or delta. |
| `cpuStat`, `cpuMax` | Allowlisted CPU counters (including throttling), quota and period. These counters remain cumulative unless explicitly represented as a delta. |
| `memoryCurrentBytes` | Kernel charged memory of the cgroup hierarchy, including its charged page cache and kernel memory. It is not process RSS. |
| `memoryPeakLifetimeBytes` | Kernel `memory.peak` since that cgroup was created or an external actor reset it; this collector never resets it. **It is not the peak of this profile window.** |
| `sampledWindowPeakBytes` | Maximum observed `memory.current` for this named target during this collector invocation, including successive identity epochs. Short peaks between polls may be missed. |
| `memoryStat`, `memoryEvents`, `pressure` | Closed numeric subsets of memory breakdown/OOM events and CPU/memory/I/O PSI averages/cumulative stall microseconds. |
| `pidsCurrent`, memory/swap/task ceilings | Host cgroup task count and supported ceilings; `"max"` means unlimited. Missing optional files/fields stay absent. |

Each JSONL row records per-target monotonic completion times, UTC snapshot completion and elapsed collector time. Sampling is sequential and therefore not an atomic host snapshot. CPU gaps preserve the last valid baseline; a lower counter or changed identity starts a new CPU epoch with `cpuCounterReset`, without manufacturing zero CPU. A nonpositive monotonic interval is a clock gap. A missing required CPU/current-memory/lifetime-peak file or a failed/oversized read is a closed error row. Unknown counter fields and raw errors are never exported. A component disappearing between polls remains a gap; the profiler does not discover a replacement.

`accounting.includedInTotal` selects only top-level paths among the explicitly named components; named descendants go into `breakdownOnly`. For example, a claim root already includes workload, observer, builder and browser children: **do not add its child rows again**. `accounting.memoryCurrentBytes` sums only the selected disjoint roots and appears only when all those roots were measured. CPU rates remain per component; choose `includedInTotal` when combining disjoint components. Individual lifetime/sample peaks are never summed: their maxima may occur at different times. A root that spans several PRs measures the whole scope, not one PR.

Duration, interval and timeout use the Docker collector's bounds (0–7,200 s, 0.2–300 s, 0.1–30 s). A real signal deadline bounds each target's complete read, including a blocked read; other targets still continue. A last snapshot may finish after the requested duration by up to the number of targets multiplied by their timeout. The output is exclusively created with mode `0600`; an existing file/symlink is refused. Exit `0` means at least one target produced a valid numeric measurement, so inspect error rows even after success. All-error runs exit `1` and retain evidence.

For the two real PRs, begin passive Docker/cgroup sampling 30–60 s before triggering them and retain it until both are terminal plus a short idle tail. Correlate `run.phase`/`claim.phase` timestamps with build, testing and capacity waits. Keep admission enabled; two triggers do not imply two simultaneous builds. Do not scale this experiment to 60 PRs.

Record build cache hits/durations from the existing Run build timings and cache storage bytes separately from RAM. Charged file cache depends on prior accesses; a warm/cold comparison requires that state to be recorded. A browser cgroup may disappear before a poll: its individual peak is then unknown, although the persistent claim hierarchy still captures its kernel lifetime peak. A preexisting root's lifetime peak cannot establish a new PR's peak, and an observed sampled peak is a lower bound. Long-lived dockerd/BuildKit/DB services and native Mac processes require their own targets/collector and cannot be assigned exactly to one overlapping PR by subtracting an idle baseline. Do not sum a whole VM's memory with its internal cgroups.

LLM cost is separate: the gateway already persists input/output, model and cache-read/write usage. Read the two Runs' cost/usage through the product's authorized view; do not collect prompts or keys. `run.finished` exposes input/output but not the cache split. Missing provider usage can leave a budget reservation counted, which must not be advertised as measured provider tokens. None of these two-PR measurements proves p99, maximum production concurrency or a technology speedup.

### Native lifecycle check (2026-11-08)

A bounded Linux probe used only its UUID-owned transient slice and two native `sleep` service names, with 32 MiB, zero swap and 10% CPU limits. It created/stopped the children and recreated one service under the same name; no container, PR or Runtime Run was started. The parent's device/inode stayed fixed while ctime changed on every child addition/removal. That disproved the first implementation's ctime-based epoch and led to the descriptor-pinning correction above.

The corrected probe confirmed that an open directory descriptor did not block StopUnit or removal of the old child path. Recreating that service produced a new inode while its old descriptor was still open; the collector detected the new identity and closed the old pin only after validating its replacement. Parent CPU deltas and sampled memory peaks survived child churn. Both services and the parent stopped while descriptors were still pinned; the parent path disappeared and all pins subsequently closed.

A separate passive invocation against the existing shared `docker.service` passed with the two existing PR aliases and no per-PR assignment or trigger. Its then-current charged memory was about 50 MB while its kernel lifetime peak was about 1.73 GB, illustrating why a daemon's historical peak cannot describe the next two PRs. These are lifecycle/counter checks on one Linux host, not workload performance evidence. No original service was reconfigured or restarted.
