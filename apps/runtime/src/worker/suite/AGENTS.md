# apps/runtime/src/worker/suite

The runtime-worker's side of running a repository's own e2e suite (docs/runtime/e2e-suites.md). The pure rules (balance, parse, classify, select, order) are `libs/runtime/suite`; this folder holds what touches Postgres, the fleet and the environment runtime.

## Owns
- `pg-suite-runs.ts` `PgSuiteRuns`: `runtime_suite_runs` (idempotent `create` by `suiteRunId`, `get`, `latestForPr` for the re-push rule, `finish`: the first conclusion stays), `runtime_suite_shards` (`savePlan`, `shards`) and `runtime_suite_results` (`recordResults`: one row per spec and phase `shard | rerun_pr | rerun_main`, a result reported again replaces the earlier one; `results`). Every read names the organization.
- `pg-suite-baselines.ts` `PgSuiteBaselines`: `runtime_suite_baselines`, unique per (environment, main sha, suite digest). `record` keeps the first complete baseline of a key and lets only a complete one replace an incomplete one; `find` and `findAmong` (nearest ancestor first) answer complete baselines only; every `record` prunes the environment: the newest `BASELINE_KEEP_COMMITS` (50), nothing older than `BASELINE_KEEP_DAYS` (30), and the newest complete baseline is never deleted.
- `pg-suite-spec-stats.ts` `PgSuiteSpecStats`: `runtime_suite_spec_stats`, the duration the next plan balances by (`read` as `SpecStats`). `record` folds only passing specs into an exponential average over about 10 runs (`STATS_WINDOW`), atomically per spec; a failed, skipped or timed-out spec changes nothing.

- `detached-exec.ts` `runDetached`: a suite command started once, detached, in the claim and polled by short `exec` calls (each under `POLL_TIMEOUT_MS`, 60 s, far under the protocol's 600 s), no protocol change (design decision D3). A wrapper writes the exit status and the log to a state directory; the marker file makes a second start (a replay) do nothing; each poll reads the state (`running`, `exited:<code>`, `dead`), the result files that exist (a path pattern, validated) and the log tail, and hands them to `onPoll`. Outcomes: `finished` (exited; red specs are results), `crashed` (died with result files: the engine keeps them and re-runs the rest once), `timeout` (the shard cap: the command and its children are stopped), `infra` (`no_result_file`, `transport_lost` after 3 lost polls in a row, `start_failed`, `bad_results_glob`, `bad_input`: never a regression). Clock and sleep are injected; step ids derive from the key and the poll number.
- `suite-engine.ts` `SuiteEngine.run(request, inputs)`: the first pass (build-plan step 7). It creates the run (idempotent: a finished run asked again returns its state with `replayed: true` and runs nothing), plans shards from the stored durations (`shardCount`, `balanceSpecs`), asks the fleet for one host per shard (`SuiteHostDemand`, asked again every 45 s while the run lives because a demand row lasts 120 s), waits up to `HOST_WAIT_MS` and spreads the specs over the hosts that came (`spreadOnto`), acquires one `suite` claim per shard (PR side at the PR head, `base` at the main sha for a baseline, bound to `suite:<org>/<run>/<shard>` through `AcquireRequest.suiteRunId` and `shard`), runs the shard's specs with `runDetached`, reads every new result file with a `cat` exec as it appears (JUnit, or Mochawesome for `.json`) and stores each spec's result at once. A crashed runner re-runs what it had not reported once, in the same claim; a second crash is `infra`. A shard past its timeout is stopped: what finished stays, the rest is `not_run`. A blocked claim or no host at all is `infra` for its specs. It records the durations of passing specs, ends with `passed`, `failed` (a red spec) or `neutral` (something `not_run` or `infra`), releases every claim and ends the demand.
- `testing.ts`: `SuiteClock`, `FakeSuiteEnvironment` (a suite command in fake time), the in-memory twins of the stores (`InMemorySuiteRuns`, `InMemorySuiteSpecStats`, `InMemorySuiteBaselines`; same public methods and rules as the Postgres ones), `FakeSuiteDemand` and `FakeSuiteCell` (acquire, exec and release of a whole suite engine in fake time: each spec ends with the outcome the scenario gives its side and attempt, and the runner's JUnit is real text). Specs only.

## Does not own
- The balance, classification, selection and order rules: `libs/runtime/suite`.
- The hosts a suite runs on and their demand rows: `apps/runtime/src/fleet`, `shared/persistence/cell-directory.ts`.
- The suite commands' schemas (`RuntimeSuiteRequested`, `RuntimeSuiteRetried`): `libs/runtime/contracts/runtime-commands.ts`. `worker/commands` `SuiteRequestedHandler` enqueues a request through the `SuiteStarter` port; no production starter (a DBOS workflow around `SuiteEngine`) exists yet, so the worker does not register the handler. `RuntimeSuiteRetried` has no handler.

## Rules and limits
- Tables are migration 51 (`shared/persistence/runtime-schema.ts`); each carries `organization_id`, so the organization purge reaches them and a read is always scoped. The API reads them with the read-only role (`scripts/runtime/runtime-reader-grants.sql`).
- Results hold redacted, bounded errors only; the engine redacts before it stores (docs section 7).
- The start and poll scripts are POSIX `sh` (no `setsid`, no `base64`): the command text goes through a quoted heredoc, the results glob is limited to `[A-Za-z0-9_./*?-]`, relative and without `..`, and the key and the cwd are checked the same way. `detached-exec.shell.spec.ts` runs them in a real shell.
- Stores take a `Pick<Pool, 'query'>` and no clock except the baseline store's injectable `now`.

## Where new code goes
- The re-run phase, the baseline recording and the publisher port: this folder, in later steps of the build plan.
- A new column: a migration at the end of `RUNTIME_MIGRATIONS`, never an edit of 51.

## Tests
- `RUNTIME_IT_DATABASE_URL=postgres://… API_NODE_ENV=test npx jest --config jest.integration.config.ts apps/runtime/src/worker/suite/pg-suite` (real Postgres, opt in).

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (6, tests apart): `detached-exec.ts`, `pg-suite-baselines.ts`, `pg-suite-runs.ts`, `pg-suite-spec-stats.ts`, `suite-engine.ts`, `testing.ts`

Imports these Runtime modules:

- [`apps/runtime/src/shared/persistence`](../../shared/persistence/AGENTS.md)
- [`libs/runtime/contracts`](../../../../../libs/runtime/contracts/AGENTS.md)
- [`libs/runtime/environment`](../../../../../libs/runtime/environment/AGENTS.md)
- [`libs/runtime/suite`](../../../../../libs/runtime/suite/AGENTS.md)

Imported by:

- none

<!-- module-map:end -->
