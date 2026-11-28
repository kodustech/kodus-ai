# libs/runtime/suite

The pure part of running a repository's own e2e suite (docs/runtime/e2e-suites.md): how specs are split into shards, how a runner's result files become per-spec results, and the signature that says two failures are the same. No I/O, no clock; the suite engine in the runtime-worker and the fleet call it.

## Owns
- `balance.ts`: `balanceSpecs` (longest-processing-time-first onto N bins by stored `p50Ms`; a spec with no stat gets the average of the known ones; with no stat at all, by file size dealt round-robin), `estimateTotalMs`, `shardCount` (`ceil(total / 8 min)` clamped to `suite.shards`, the pool headroom and the spec count).
- `junit.ts` `parseJUnit` and `mochawesome.ts` `parseMochawesome`: a runner's result text as `SpecResult[]` (`types.ts`: per test the attempts, so a retried-then-passed test is `isFlakyInRun`). A text that is not that format throws.
- `error-signature.ts` `errorSignature`: the first error line with numbers, hashes, uuids and generated selectors replaced, cut at 200 characters.
- `classifier.ts`: the re-run classifier of section 9. `planReruns` (mass failure over 25%, the 40-spec budget, infra specs to one fresh-host retry) before the re-runs; `classifyFailures` after them (`flaky`, `regression`, `pre_existing`, `pre_existing_changed`, `regression_unconfirmed` under base drift, the baseline fallbacks of 9.5, `unclassified` with its reason); `needsMainRerun` (a spec red everywhere in the exact baseline skips the main run). Only a `regression` blocks or becomes a finding.
- `select.ts` `select` (section 6.1; a selected result also says `reachedBy`, per changed file the specs it reaches, at most `REACHED_BY_LIMITS` 40 files and 25 specs each, which the run stores for its page): the specs a PR's changed files reach through the stored coverage map, the importer walk and the workspace closure, or the whole suite with a reason (`FullReason`: manifest, lockfile, config, shared routing, a file no spec covers, map missing, stale or of another digest, a noise file, `huge_diff` past `suite.full_run_files`, `no_main_pass`, a forced run). Specs with no recorded pass on main (`passedOnMain`) and `suite.unskippable` entries (`isUnskippable`: globs, or `@tag` as a whole path part) always run; `diffBaseFor` says where the diff starts when the merge base has no map. `suite.ignore` globs never override the net; unknown never selects nothing.
- `repush.ts` `planRepush`: a new push on the same PR runs what was red before (minus `pre_existing`) plus what the delta reaches; a green previous run and an empty delta run none; a delta in the safety net escalates to full; a rebase selects again from the new merge base.
- `order.ts`: `orderBin` / `orderBins` (inside a shard: failed before, then specs covering the diff by number of changed files, then the rest longest first; the balance is untouched) and `failFast` (more than 25% of the first `max(5, 10%)` specs failed: stop the first pass and name the rest `not_run`; the classifier then sees a mass failure).

- `queue.ts` (the dynamic spec queue, section 6): `queueEntries` (what a suite run's queue holds and the order it is handed out in: red before, then covering the diff, then longest first by the stored duration, the file size with none), `batchSize` (a pull takes specs until their estimates add up to `QUEUE_BATCH_TARGET_MS`, a long one alone, at most `QUEUE_BATCH_MAX_SPECS`) and the lease rules (`QUEUE_LEASE_MS`, `QUEUE_MAX_ATTEMPTS`, `afterLostClaim`, `leaseExpired`). `PgSuiteQueue` in the worker applies them.
- `main-history.ts` (docs 7.2, lazy baseline): `mainSpecHistory` (pass, fail and flaky over the newest `MAIN_HISTORY_RUNS` runs of a spec on main; flaky = different outcomes on one commit), `mainOutcomeAt` (passed, failed, mixed or none at one commit: only an agreeing result is reusable) and `baselineDue` (a full run on main only when the suite digest, the coverage map or the cadence needs it). The classifier reads the history through `ClassifyInput.mainHistory`: a PR failure main's flake also produced is `flaky` with `flakyOnMain`.
- `hosts.ts` `hostsToAsk` (one host per shard, at most the pool headroom, at least one) and `spreadOnto` (every spec onto the shards that got a host, balanced by the stored durations; the missing shards carry none).
- `digest.ts` `suiteDigestOf`: the digest of a suite (the block's command, runner, directory, results glob and env, and the sorted spec list) that keys a baseline; timeouts and the shard ceiling do not move it.
- `spec-list.ts` `specListOf`: the spec files one run executes: main's listing under the recipe's glob, plus the specs the PR adds, minus the ones it removes (paths read relative to the suite directory), or exactly the specs a retry names.
- `plan.ts` `planSuiteRun` (section 6.1 on the request path: `select` over the change set, `planRepush` when the PR has an earlier run, the safety net everywhere an input is missing). With no coverage map (none recorded yet for the environment) every plan is the whole suite with the reason `map_missing`, or the more specific file reason (a lockfile, a manifest, a config); an ignored-only change is not trusted to select nothing without a map; a change set the product could not read is `changes_unknown`, never an empty list.
- `plan.ts` `diffReach` (also `SuitePlan.reach`): the specs the whole diff reaches, for the classifier while main is ahead: `select` over the merge-base diff (not the re-push delta) plus the specs the PR added or changed; every spec for a manifest, lockfile, config or shared-routing change; with no usable map or an uncovered or noise file only the PR's own specs and `unknown` carries the reason (`ReachUnknownReason`). Not computed for a shadow run.
- `report.ts` `buildSuiteReport` (the structured report of section 10.1 from a run's stored state, its first-pass results and its classification: totals, red tests by class, how the specs were chosen, the baseline and the drift, at most `ANNOTATIONS_MAX` 200 annotations, regressions first, each with the failing line of the spec read from the error's stack, a message cut to 400 characters), `suiteConclusionOf` (D4: a regression fails, flaky and pre-existing never do, unclassified is neutral; the run's state carries timed out and cancelled), `pageAnnotations` (GitHub takes `ANNOTATION_PAGE` 50 a request), `failingLineOf`. Never a sentence of the Runtime's own: the product writes the words.
- `artifacts.ts` `planArtifacts` and `artifactOwner` (section 7, D8): which files a run left on a host become evidence: only those of failed specs, each of a kind the evidence holds and within its size, all within the suite's byte budget; a file belongs to the spec whose path (or file name) appears in its path, the longest match, a tie is no owner.
- `shadow.ts` (section 6.1 Proof b, D14): `shadowDue` (every 5th of the first 50 selected runs, then every 10th), `missesOf` (the regressions a full run found in specs the selection skipped) and `brakeAfterMiss` (the whole suite for 10 pull requests; off at two misses among the last ten shadows).

## Does not own
- Storing results, baselines and durations, the shard hosts, the detached command and its polling, publishing: later steps of the build plan (section 17), in the runtime-worker and `libs/runtime-publish`.
- The `suite:` recipe block: `libs/runtime/protocol/recipe.ts`.

## Rules and limits
- Pure and deterministic: the same input gives the same bins whatever order specs arrive in.
- The XML parser is `fast-xml-parser`, already a dependency; JUnit is parsed on the host and stored as JSON, never as XML.
- An error is never read by a model; the signature is string replacement only.

## Where new code goes
- A new result format: a `parseX` here returning `SpecResult[]`, with a fixture spec.
- A new field the engine stores per spec: `types.ts` first.

## Tests
- `node node_modules/jest/bin/jest.js --runInBand libs/runtime/suite` (pure, no services).

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (19, tests apart): `artifacts.ts`, `balance.ts`, `classifier.ts`, `digest.ts`, `error-signature.ts`, `hosts.ts`, `index.ts`, `junit.ts`, `main-history.ts`, `mochawesome.ts`, `order.ts`, `plan.ts`, `queue.ts`, `report.ts`, `repush.ts`, `select.ts`, `shadow.ts`, `spec-list.ts`, `types.ts`

Imports these Runtime modules:

- [`libs/runtime/contracts`](../contracts/AGENTS.md)

Imported by:

- [`apps/runtime/src/worker/suite`](../../../apps/runtime/src/worker/suite/AGENTS.md)
- [`libs/runtime-publish/application`](../../runtime-publish/application/AGENTS.md)
- [`libs/runtime-publish/domain`](../../runtime-publish/domain/AGENTS.md)
- [`libs/runtime/api/application`](../api/application/AGENTS.md)
- [`libs/runtime/api/domain`](../api/domain/AGENTS.md)
- [`libs/runtime/run`](../run/AGENTS.md)

<!-- module-map:end -->
