# E2E suites: run the repository's own end-to-end tests (2026-11-23)

Status: design, no code. Written from the code of this branch (base `f403b520a`). A line marked "unverified" was not
run or not read to the end. Terms are in [glossary.md](glossary.md). Related: [host-providers.md](host-providers.md)
(perRun hosts, templates), [incremental-pr-side.md](incremental-pr-side.md) (on hold), [kept-checks.md](kept-checks.md),
[monorepo-speed-and-targeting.md](monorepo-speed-and-targeting.md), [usage-report.md](usage-report.md).

## 1. Problem and numbers

Kody Runtime boots the main and the PR side of an environment and runs probes Kody plans (`run-orchestrator.ts`),
kept checks and intent probes. It has no mode that runs **the repository's own end-to-end suite**. A customer
monorepo (Firebase functions, Vue/Quasar dashboard, Cypress e2e in 3 shards) runs it on a CI provider today:

| Measure | Value |
|---|---|
| CI median wall time | 18 min |
| Prep (install + build) | 7.1 min, per shard |
| Cypress | about 10 min, 3 shards in parallel, 8 vCPU each |
| Machine time | about 50 machine-min per PR run (3 x 17.1) |
| Cost target here | about 40 host-min per PR run on boat `large` at $0.072/h list (`host-providers.md:223`), about $0.048, plus a few minutes of re-runs |

Two things make the suite different from a Kody Run: it is **long** (10 to 20 min of one command, not seconds of
probes), and it is **noisy** (a red suite on a PR is often not the PR's fault). The feature is therefore a runner plus
a classifier that says whose fault each red spec is, so that the PR author sees only what the PR broke.

## 2. The decided shape (the owner's decisions, not reopened)

1. **Main baseline once per main commit**, results stored per (environment, main sha); every PR on that base reuses it.
2. **On a PR only the PR side runs the suite**, sharded across boat hosts started from the environment template.
3. **Only specs that failed on the PR are re-run**, on main and on the PR again, to classify each failure.
4. **One engine, two entry points**: Run mode (a Kody verdict) and CI mode (a GitHub check, no Kody verdict).

Everything below is inside these four.

### 2.1 Step by step: a main commit

1. A commit lands on the default branch. The default-branch setup runs and bakes; the template rebuild pass finds a
   new bake fingerprint (digest of every repository's commit and the recipe, `bake-probe.ts:21-30`) and builds the
   environment template (`template-rebuild.ts:43-61`, `TemplateBuildTrigger.onSetupFinished`).
2. When the template turns `ready` (`runtime_env_templates`), the trigger also enqueues a **baseline suite run** for
   `(environment, template sha)`: a `SuiteRequested{kind: baseline}` command on the outbox.
3. The engine plans shards from stored durations (section 6), asks the fleet for N perRun hosts, one per shard, all
   from the template just built. **No build is needed**: the template is main, built. Prep is the host boot (10 to 20 s,
   proven live) plus services up from the bake.
4. Each shard runs its specs; the engine stores the per-spec results as the baseline for that main sha (section 7) and
   updates per-spec durations. Failures on main are recorded as such (`baseline_failed`), never re-run here.
5. Coalescing: at most one baseline queued per environment. A newer main sha replaces a queued, not started one; a
   started one finishes. Baselines of skipped shas do not exist, and section 8.4 says what a PR does then.

### 2.2 Step by step: a PR

1. A PR event (or `@kody runtime`, or CI mode's trigger) creates a `SuiteRun{mode, prSha, mergeBase}`.
2. The engine plans shards from the stored durations of the environment's specs.
3. The fleet starts N perRun hosts from the template (bound key per shard, section 5). Each host boots, the cell
   registers, and the shard **builds the PR side** (the template holds main's build, the PR needs its own; section 15.1
   says what this costs and what contradicts the shape).
4. Each shard runs its spec list. Results stream to the engine per spec as they finish.
5. When all shards end (or a cap trips), the failed specs are collected. If there are none: done, green.
6. **Re-run** (section 9): the failed specs run again on the PR (on the shard host that already holds the PR build,
   no new build) **and** on main (one host from the template, no build), in parallel.
7. The classifier labels each failure `regression`, `pre_existing`, `flaky`, `infra` or `unclassified`.
8. The result publishes (section 10): a check always; a Kody finding only for `regression`, in Run mode.

## 3. How the suite is declared

A new optional block in `.kodus/workspace.yaml`. `RecipeSchema` is a `z.strictObject` (`libs/runtime/protocol/recipe.ts:165`),
so the block needs a schema change, and the Go cell must accept the key (`RECIPE_UNAPPLIED_KEYS`, line 246, is held to the
cell's own list by the recipe contract). The cell does not act on `suite`; the worker does, so it goes in the cell's
"known, ignored by the cell" list, not in `unapplied`.

```yaml
suite:
  runner: cypress                 # cypress | playwright
  command: npx cypress run --browser chrome --spec "{specs}"   # {specs}: comma list the engine fills
  cwd: apps/dashboard
  specs: "cypress/e2e/**/*.cy.ts" # glob, relative to cwd; the engine lists it at the PR sha
  shards: 3                       # a ceiling; the engine may use fewer for a small spec list
  service: e2e                    # compose service the command runs in (it has node and the browser), or `image:`
  timeout: { shard: 25m, spec: 5m, total: 40m }
  env: { BASE_URL: "http://web:3000" }   # plain values only; secrets stay in the environment's sealed secrets
  results: { junit: "results/*.xml", artifacts: ["cypress/screenshots", "cypress/videos"] }
  baseline: true                  # false: no main baseline run (CI mode only repositories)
```

Rules:

- `command` may not contain `--record`, `--parallel` or a record key: those need Cypress Cloud, and its secret is not
  given to a shard. The engine strips them and says so in the setup summary.
- `{specs}` is mandatory for Cypress; Playwright takes `{specs}` as positional files (`--shard` is a fallback, section 6).
- Every value is bounded (`RECIPE_LIMITS` style): 16 env entries, 8 artifact paths, a command of 1 KiB.
- **Derived, then editable.** The recipe author already reads the repo's e2e workflow (`recipe-author/ci-evidence.ts`):
  job names, run commands (cut to 140 chars, 10 per job), env var NAMES, never values (`ci-evidence.ts:21-24`). Today
  it returns a text summary capped at 4096 chars. It must also return a structured `suiteCandidate`: the runner
  (regex on `cypress|playwright` already in `BOOTS_APP`, line 28), the command with the Cloud flags and expressions
  removed, the matrix size (`strategy.matrix` or the `--parallel` group count), the spec glob (from
  `cypress.config.*` / `playwright.config.*` read as facts, not executed) and the env names. The author writes the
  block with `origin: inferred` like an inferred recipe; the user edits it in the recipe editor, and the web shows
  which keys were inferred. If nothing is certain the block is absent and the feature is off (no guess).
- Suite changes on a PR's recipe never apply to that PR: the recipe is read from the default branch (S-52), as today.

## 4. Where it runs

**perRun boat hosts from the environment template**, one host per shard, `boat-large-cell` (8 vCPU, 16 GB, 111 GB
disk). A host boots in 10 to 20 s with main's build ready (`host-providers.md` 8.2).

- **Browser.** The cell's `BrowserRunner` is a separate gVisor container for Kody's probes: 1 GB, 1 CPU, no mounts, job
  in on stdin, artifacts out as a tar (`dockergvisor/browser.go:20-39`). It cannot run Cypress: the suite needs the repo,
  its node_modules, a browser with a display, and the app network. The suite runs **inside the claim's compose network**
  in the recipe's `service` (the customer's own e2e image or a service that has Cypress and Chrome; Xvfb is
  `cypress/included`'s own entry). The recipe author adds that service from the CI workflow when it is missing
  (`image: cypress/included@sha256:...`, pinned by digest like the browser runner image, `CheckBrowserImage`).
- **Java and emulators** (Firebase emulators, the customer's functions) are already services of the environment; the
  suite shard boots the same compose project the Run's PR side boots.
- **Memory.** Chrome plus the app plus emulators on 16 GB: the same load as one CI shard on 8 vCPU. Unverified on
  boat; the first fixture run measures it (section 16).
- **Process control.** `exec` caps `timeoutMs` at 600,000 (`protocol/messages.ts:27`, `protocol/sandbox.ts:54`) and
  returns 192 KiB of stdout per call (`sandbox.md:174`). A 10 to 25 min suite does not fit one exec. The engine starts
  the command **detached** in the service (`exec` of a wrapper that backgrounds it, writing results to a file), then
  polls with short execs (tail of the log, list of finished spec result files, one per spec). This needs no protocol
  change; a first-class `exec.start`/`exec.poll` is the better end state (open decision D3).
- **Claim.** A suite shard acquires a claim with a new consumer `suite` (`CLAIM_CONSUMERS`, `enums.ts:167`), side `pr`
  (or `base` for baseline and main re-runs). It is a Run-like claim: same lease renewal, same egress policy, same
  secret injection, same reaper. It is not a `runtime` consumer, so it never produces probes and the sandbox rules do
  not apply.

## 5. Fleet

- A perRun host serves one bound key (`run:<org>/<run>` or `template:<org>/<env>`, `candidate-pools.ts:43-46`). A suite
  shard gets `suite:<org>/<suiteRunId>/<shard>`, with the same one-to-one host lifecycle (`runPerRunHost`,
  `per-run-host.ts:105`). A demand row per shard (`runtime_pool_demand`), N rows per suite run, so N hosts start in
  parallel. The shard host is kept for the re-run (step 6 of 2.2) and ends with the suite run.
- **Template.** `TemplateResolver.resolve` returns the environment's ready template; without one the host boots from
  the cell base and the shard builds cold (section 12). The demand also triggers a template build
  (`TemplateBuildTrigger.onDemand`, `template-trigger.ts:34`), so the next suite run is warm.
- **Rate and capacity.** boat never queues a start (`host-providers.md:337`); the $100 plan allows 30 starts a minute
  and 300 sandboxes at once, far above 3 to 6 hosts. The limit that matters is the pool `max`: a suite run asks for N
  hosts at once, so the engine asks for `min(shards, pool headroom)` and spreads the specs over what it got (more
  specs per shard), never waits for a missing shard.
- **Caps.** `perRun.maxRunMinutes` is 120 and the dead-man `ttlSeconds` 7200, extended every 5 min while demand lives
  (`host-providers.md:403`); the suite's own caps are below 120 (section 12).
- **Admission.** A boat pool admits only Kodus's org until legal accepts customer data at rest in boat
  (`host-providers.md` `admission.allowOrgs`, 8.2). A customer suite cannot run on boat until that changes; see
  section 15.1, contradiction 1.

## 6. Spec distribution

The engine lists the spec files at the PR sha (`git ls-tree`, matched against `suite.specs`) and splits them:

1. **Durations.** `runtime_suite_spec_stats(environment, spec) -> {p50Ms, lastMs, samples, lastSeenSha}`, an
   exponential average of the last 10 passing runs, updated by every baseline and PR run. Failed or timed-out specs do
   not update it (a crash is short).
2. **Balance.** Longest-processing-time-first onto N bins: sort specs by `p50Ms` descending, put each in the lightest
   bin. A spec with no stat gets the average of the known ones (the rule `cypress-split` uses for new specs, source
   below). Without any stat (first run), split by file size in bytes, round-robin in sorted order; the first run
   writes the stats.
3. **Shard count.** `N = clamp(ceil(totalMs / targetShardMs), 1, suite.shards, pool headroom)` with `targetShardMs` of
   8 min: a small suite is not spread over 3 hosts that each pay a PR build.
4. **Playwright.** The engine passes explicit files, the same as Cypress. `--shard=i/n` is only the fallback when the
   spec list cannot be listed; without `fullyParallel` it shards per file, so uneven files give uneven shards
   ([Playwright sharding](https://playwright.dev/docs/test-sharding)).
5. The plan is stored in the suite run (`shards[i].specs[]`), so a re-run of a shard uses the same list.

## 7. Result model and storage

Per spec (and per test inside a spec when the reporter gives it):

```
SpecResult { spec, tests: [{ title, status: passed|failed|skipped|pending, attempts: [{status, ms, error?}] }],
             status, durationMs, shard, host, artifacts: [EvidenceRef], errorSignature? }
```

- **Parsing.** The engine reads the JUnit files the runner wrote (`results.junit`) at the end of each spec batch; a
  JUnit reporter is added by the engine to the command (`--reporter junit`, or `--reporter=blob,junit` for Playwright),
  because the command comes from CI and may not have one. Mochawesome JSON is a second adapter. Merging is the engine's
  own: it never needs a merged HTML report; the per-shard results go straight into one table (so Playwright blob
  merging, `npx playwright merge-reports`, is optional: only for the user's download).
- `errorSignature` = the first error line with numbers, hashes, ports and selectors-with-generated-ids replaced, cut at
  200 chars. It decides "the same failure on both sides" in section 9.
- **Runner-level retries** (Cypress `retries`, Playwright `retries`): kept as `attempts`. A test that failed and then
  passed inside its run is `flaky_in_run` from the start; it needs no re-run.
- **Tables** (Runtime Postgres, the Runtime owns them like `runtime_kept_check_results`): `runtime_suite_runs`,
  `runtime_suite_shards`, `runtime_suite_results` (one row per spec per phase: `shard`, `rerun_pr`, `rerun_main`),
  `runtime_suite_baselines`, `runtime_suite_spec_stats`.
- **Artifacts.** Screenshots, videos, traces go to the evidence store (`run-evidence.ts`, `EvidenceStore`, S3 or file)
  through the cell's upload grants. Today the allowed types are `screenshot-0..9` (2 MiB PNG), `video` (webm), `trace`
  (zip), `logs` (256 KiB text), `har`, and the content types are json, text, png, webm, zip
  (`contracts/evidence.ts:30-60`). A suite needs **per-spec** artifacts and many more than 10 screenshots: new upload
  type `suite-artifact` with a key `suite/<run>/<shard>/<specHash>/<name>`, a per-suite byte budget (default 200 MB), and
  `application/xml` is not an allowed content type, so JUnit is parsed on the host side and stored as JSON
  (`suite-result`, 1 MiB per shard), never as XML. Only artifacts of **failed** specs are kept by default; videos of
  passed specs are dropped.
- **Redaction.** Everything goes through the same redaction as other evidence (S-51, `libs/runtime/redaction`) before
  it is stored; a canary sighting in any output halts the suite run as it halts a Run.
- **Retention.** Results and artifacts follow the evidence TTL (same as Run evidence). Baselines: below.

### 7.1 The baseline store

`runtime_suite_baselines(organization_id, environment_id, main_sha, suite_digest, status, specs jsonb, finished_at)`,
unique on `(environment_id, main_sha, suite_digest)`. `suite_digest` is the digest of the `suite` block plus the spec
list, so a changed command or glob does not reuse an old baseline. `specs` is `{spec -> {status, errorSignature,
durationMs}}`, small (a 300-spec suite is about 40 KB).

- **Retention.** The last 50 shas per environment, and nothing older than 30 days; the newest complete baseline is
  never deleted. A failed baseline (infra) is stored as `incomplete` and does not count as a baseline.
- **Lookup.** By `(environment, sha)`, then the nearest ancestor within 20 main commits that has a complete baseline
  (git ancestry from the Git API; unverified that the platform adapter lists ancestors, otherwise the engine uses the
  stored shas ordered by `finished_at`).

## 8. The classifier input: the baseline and the merge base

### 8.1 What the baseline is for

The rule in section 9 does not need the baseline: the re-run on main decides. The baseline is used for three things:
(a) the first signal on screen while re-runs wait ("failed on main at `abc123` too" is shown at once, marked
"unconfirmed"); (b) the fallback when no main host can be had (9.5); (c) per-spec history for flake rates.

### 8.2 Which main

The environment template is the **default branch head at the last bake**, one ready template per environment
(older ones are replaced, `host-providers.md` 8.2). A PR's merge base is usually older. The main re-run therefore runs
on the template's sha (`mainSha`), and records both `mainSha` and the PR's `mergeBase`.

- `mainSha == mergeBase`: exact.
- `mainSha` ahead of `mergeBase`: "main today". A spec that fails on the PR and passes on main may have been fixed
  on main since the PR branched. The result carries `baseDrift: <n commits>` and, in the check, "Update the branch
  to confirm". It still counts as `regression` only when the PR's failing tests are in files the PR touched or that the
  PR's diff reaches (the planner's entry points, `libs/runtime/entry-points`); otherwise it is `regression_unconfirmed`
  and is not a Kody finding (D2 lets the owner choose).
- A baseline exists for `mergeBase` (the exact one): it is used as the main side when a main host is not available
  (9.5), and a spec failing in it is `pre_existing` without a re-run only if the same `errorSignature` failed in both
  that baseline and the PR's two attempts (saves a main run in the common "red since last week" case; the main
  re-run is still started for specs without that evidence, so the decided "re-run on main" holds for the unknown ones).

## 9. The re-run classifier

### 9.1 Scope

Input: the failed **tests** of the PR's first pass (unit of re-run: the spec file, the unit of classification: the test
`(spec, fullTitle)`). Output per test: one class. Nothing is re-run for a spec that passed.

### 9.2 Failure kinds first

| Kind | Examples | Treated as |
|---|---|---|
| test failure | assertion, element not found, command timeout inside a test | goes to the rules below |
| infra failure | shard host lost, runner process crashed with no result file, browser crash, services unhealthy at start (the claim's health probe), `ECONNREFUSED` to a service of the environment during the whole spec, disk full | `infra`: the spec is re-run **once on a fresh host**; if it fails again as infra: `unclassified/infra`, never a regression |
| spec timeout | `timeout.spec` exceeded, process killed | a test failure with `timedOut: true`; the rules apply, and a timeout on both sides is `pre_existing` |
| shard timeout | `timeout.shard` exceeded | specs with no result are `not_run`, listed, re-queued once on a new host; still unfinished: `unclassified/not_run`, check `neutral` or `failure` by D4 |

An error is infra only by the closed list of signals above (exit status, missing result file, the cell's health, a
transport `lost`, `StepResult.transport`). The classifier never reads the error text with a model.

### 9.3 The rules (a test failing in the first pass)

PR re-run: the test's spec again, same host, same PR build, 1 attempt. Main re-run: same spec on a template host, 1
attempt. Both run at the same time.

| First pass | PR re-run | Main re-run | Class | Blocks? |
|---|---|---|---|---|
| failed | passed | any | `flaky` (passed on retry) | no |
| failed | failed | passed | **`regression`** (fails on PR, passes on main) | yes |
| failed | failed | failed, same `errorSignature` | `pre_existing` | no |
| failed | failed | failed, different `errorSignature` | `pre_existing_changed`: shown with both errors; treated as `pre_existing` for the verdict, flagged for a human | no |
| failed | failed | infra or no host | see 9.5 | no, until decided |
| infra | n/a | n/a | `infra` (9.2) | no |

Notes:

- A test that passes on the PR re-run is `flaky` even if main also failed; the first-pass failure is not reproducible.
  Its flake counter goes up (section 9.6).
- One PR re-run and one main re-run is the decided minimum. `suite.retries.main` (default 1) may be raised to 2 when the
  number of regressions is at most 5 to double-check a pass on main (D1). A single main pass against two PR failures
  is a strong signal, not proof; the check says "failed twice on the PR, passed once on main".
- Same-signature test: a test that failed in the first pass with signature A and failed in the re-run with signature B
  is treated as failing (any fail), classified by main as above.

### 9.4 Caps and mass failures

- **Re-run budget.** At most `min(failed specs, 40)` specs re-run; the rest are `unclassified/budget` and the check
  says so. If more than 25% of the specs fail in the first pass, no re-run starts (a broken build or environment, not
  a flake): all are `unclassified/mass_failure`, the check fails with "most of the suite failed; this is usually the
  environment, not a test" and the Kody Run gets a boot-style finding, not N regressions.
- **Time.** The re-run phase has its own cap of 12 min (`timeout.rerun`, derived: 1.2 x the longest failed spec plus
  3 min of boot). Past it, unfinished re-runs are `unclassified/timeout`.

### 9.5 Missing, stale or unavailable baseline and main

Never block on a full main run.

| Situation | What happens |
|---|---|
| Template missing or building | The main re-run host boots from the cell base and builds main **only for the failed specs' services**: too slow (20 min+), so it does not wait: the PR is classified from the first pass and the PR re-run alone: `failed twice on PR`, class `failed_unconfirmed`, check `neutral`-leaning (D4), and a template build is requested for the next run |
| Template sha differs from the merge base | Main re-run on the template (8.2), `baseDrift` recorded |
| No main host in 2 attempts (capacity) | Use the baseline of `mergeBase`: spec passed there: `regression_probable`; failed there: `pre_existing`; no baseline: `failed_unconfirmed`. None of these is a Kody finding |
| Baseline stale (`mainSha` older than 20 commits, or the `suite_digest` differs) | Not used as evidence; only shown as history |
| Baseline of main itself is red for a spec | The spec is `pre_existing` in the baseline; on a PR it is re-run on main only if it fails on the PR (so the cost is zero for a spec that is red everywhere and passes nothing) |

### 9.6 Flake memory

`runtime_suite_spec_stats` also holds `flakeRate` (passed-on-retry / runs, last 30 runs). A spec above 20% is
`known_flaky`: it still runs; a first-pass failure of it that passes on retry costs no re-run on main (it is
`flaky`), a failure that repeats still goes through the rules. The check lists known-flaky specs with their rate.
Detection signals follow the practice of CI products: a test that fails then passes on retry in the same run, and a
test that passes and fails on the same commit; Datadog and Trunk quarantine by failure rate over a window and keep
the test running without blocking; Nx warns a green retry is evidence to investigate, not proof the problem is gone,
and a failure after a source change may be a real regression ([sources](#16-sources)). We do **not** quarantine
(skip) tests in the customer's repository: Kody only stops them from blocking.

## 10. Publishing

### 10.1 The GitHub check

`libs/runtime-publish` already publishes a Run's check with its own key (`CheckPublisher`, `checkNameOf`,
`publish-environment.ts:41`; the commit `awaiting_approval check with its own key` shows a second key per head).
The suite gets **its own check slot**: `Kody Runtime e2e (<environment>)`, on the PR head, opened `in_progress` when
the suite run starts, updated at each phase (first pass, re-run), closed with the conclusion.

- **Summary table**: totals (passed / failed / skipped), then one row per class: `regression`, `pre_existing`,
  `flaky`, `unclassified`; time-to-result, machine minutes, the baseline sha used and `baseDrift`.
- **Annotations**: one per failing test of class `regression` (and `unclassified`), file = the spec, line = the
  failing line from the error stack when it is in the spec, message = the error, cut at 400 chars and redacted. GitHub
  accepts at most 50 annotations per request (Checks API docs, not fetched here); more go in follow-up updates of the
  same check run. `flaky` and `pre_existing` are in the table, not annotations.
- **Conclusion**: `failure` if there is at least one `regression`; `success` if none (flaky and pre_existing never
  fail); `neutral` if anything is `unclassified` or `failed_unconfirmed` and there is no regression; `timed_out` and
  `cancelled` as today. CI mode may be set to `strict` (any unclassified failure fails) with the recipe `suite.gate:
  strict` (D4).
- Links: the Run page (`apps/web .../runtime/runs/[runId]`) for Run mode, a new suite page for CI mode (section 13).

### 10.2 The Run verdict (Run mode)

The suite is a **stage of the Run**, run after the PR boots (the claims exist) and in parallel with the probes' phase
when the environment has the capacity; its output enters the Run as follows:

- A `regression` becomes a `Finding` of a new kind `e2e_regression` (`FindingKind` in `contracts/enums.ts`), with the spec,
  the error, the artifacts and the class evidence (PR failed twice, main passed). Verdict state `regression`.
- `flaky`, `pre_existing`, `unclassified`: no finding. They appear in the report section "E2E suite" only.
- No regression and nothing unclassified: contributes to `no_regressions`. Unclassified with no regression: the Run
  becomes `partly_tested` (the existing state for "could not cover everything", `run-state.ts:36,307`), never
  `no_regressions` with part of the suite unknown.
- The Kody comment/check of the Run shows the suite line; the suite's own check (10.1) is the detail.

### 10.3 CI mode

The same engine; a different trigger and publisher: PR side only, report as the 10.1 check, **no Kody verdict, no
probes, no PR comment**. It does not need the PR side's Kody plan, diff analysis or LLM. The classifier still runs
(re-runs), because "red because of main" is the point. Section 11.

## 11. Run mode and CI mode: two triggers, one engine

```
SuiteEngine(request) -> SuiteResult
  request: { organizationId, environmentId, suiteRunId, mode: 'run'|'ci'|'baseline', prSha?, mergeBase?, mainSha }
  steps:   plan -> startShards -> firstPass -> collect -> rerun(pr, main) -> classify -> store -> publish
```

| | Run mode | CI mode | Baseline |
|---|---|---|---|
| Trigger | `RuntimeRunRequested` on a PR whose environment has a `suite` block, enabled for runs | PR event / `@kody runtime e2e` / a GitHub `check_suite` request | Template `ready` for a new main sha |
| Sides | PR (suite), main/PR claims of the Run for probes | PR only | main only |
| Publishes | the suite check + the Run's check/comment + findings | the suite check only | nothing on GitHub; the baseline row and the environment page |
| Verdict | yes (10.2) | no | no |
| Billing | the Run's usage + suite machine-minutes | suite machine-minutes | suite machine-minutes, labelled `baseline` |

The engine is a plain TypeScript module under `apps/runtime/src/worker/suite/` with ports (like `RunDeps`): the
environment runtime (acquire, exec, upload), the fleet demand port, the store, the publisher. A DBOS workflow
`runtime.suite` wraps it with durable steps exactly as `runRuntimeRun` does. Run mode calls it from the orchestrator
as one step group; CI mode and baseline start it from their own command (`RuntimeSuiteRequested`, section 13).

## 12. Limits and cost

### 12.1 Time caps

| Cap | Default | Where |
|---|---|---|
| per spec | 5 min (recipe `timeout.spec`) | the runner's own, plus a host-side kill |
| per shard | 25 min | engine kills the shard, `not_run` for the rest |
| first pass | 40 min | below the per-boot 45 min (`RUN_TIMEOUT_MS`, `run-orchestrator.ts:120`) and the host's `maxRunMinutes` 120 |
| re-run phase | 12 min | 9.4 |
| suite run total | 60 min | then `timed_out` |
| exec polling | each poll under 600 s | protocol cap |

The PR side build keeps the Run's existing 45 min boot budget; the suite timers start after the build. In Run mode the
suite and the probes share the PR claim's lease; the lease keeper already renews it (`lease-keeper.ts`).

### 12.2 Cost per PR (formula)

```
hostMin(PR) = sum over shards s of ( boot_s + build_s + suite_s )          first pass
            + sum over rerun-pr hosts ( rerun_pr )                          0 new hosts: same shard host stays
            + boot_main + sum over failed specs ( main_run )                one extra host, only if failures
cost(PR)    = hostMin(PR) / 60 x usdPerHostHour                             0.072 for boat large
```

Customer's CI shape on boat: boot 0.3 + build 7.1 (CI figure; on the cell it is higher, section 15.1) + suite 10 = 17.4
per shard, 3 shards = 52 host-min = $0.062. The target of about 40 host-min needs the build below 3 min per shard (the
incremental PR side) or fewer shards. Re-runs: PR re-run 0.2 x suite for 5 failed specs of 30 s each = 3 host-min; main
re-run host 0.3 + 3 = about 4 host-min. A red PR costs about 7 host-min more (about $0.008). A green PR costs nothing
extra. Baseline: 3 shards x (0.3 + 10) = 31 host-min per main commit, no build. At 20 main commits a day: 620 host-min,
$0.74 a day.

The numbers are estimates until the fixture run (section 16).

### 12.3 Where it is shown

Machine-minutes of a suite shard are claims of consumer `suite`, priced by `run-cost.ts` from the host's
`usd_per_hour` (cell → host → pool) and listed in the usage report (`libs/runtime/api/domain/usage-report.ts`) as a new
line `suite` split `baseline | pr | rerun`; the Runs page shows the PR's suite cost; the CSV export gets a column.
A org ceiling `suiteMinutesPerDay` (machine minutes, default 600) refuses new suite runs past it with a visible
reason, like `MachineMinutesChanged`.

## 13. Security

- **PR code is untrusted.** The shard runs the PR's tests, which are code. It gets exactly what a PR claim gets today:
  the environment's **sealed secrets** as placeholders swapped by the credential injector at the egress, the
  environment's approved egress hosts, no repo token beyond the claim's download token, no Kodus credentials, no LLM
  token. The suite adds **no** secret and no new egress.
- **Fork PRs.** A fork PR's claim has no approved egress (`forkPullRequest: true`, `run-orchestrator.ts:220`) and waits
  for approval (`awaitForkApproval`); the suite does not start before the same approval, and a suite never runs in CI
  mode for a fork without it.
- **Artifacts.** Redacted like other evidence (S-51), canaries watched; a video or screenshot can show a rendered
  secret, so videos are off unless `artifacts` names them, are kept only for failed specs, and are served through
  signed short-lived URLs like screenshots (`signEvidenceUrl`).
- **Host isolation.** One host per shard, destroyed after the suite run (`snapshots: false`). The template is main,
  built from the default branch (S-52); a PR's code never enters a template.
- **Main re-run.** Runs the default-branch tests against the default-branch build: no PR code.
- **Test data.** Specs write to the environment's own databases/emulators inside the claim; nothing outside leaves
  the cell's egress.
- **Quota abuse.** A PR can loop a test; caps in 12.1 and the org ceiling bound it.

## 14. Failure modes

| Failure | What happens |
|---|---|
| Template missing | The shard host boots from the cell base and builds the **PR side** cold (the same as a Run today); the suite run takes longer (build 20+ min on the cell, section 15.1); a template build is requested; the check says "started without the template" |
| boat host unavailable (`host_unavailable`) | The shard is retried on a new host once; two failures: its specs are `not_run`, re-queued onto the other shards' hosts when they finish, else `unclassified/not_run` |
| Shard crash (runner dies, host lost mid-shard) | Specs with a result stay; the rest re-run **once** on a new host (same plan slice); a second crash: `infra`, not a regression |
| Services unhealthy in the PR side | The Run's existing boot verdict (`could_not_boot`) applies in Run mode; in CI mode the suite is `infra`, check `neutral` with the boot error |
| Re-run main host cannot start | 9.5 |
| Output flood | exec output capped per call; logs uploaded with the 256 KiB `logs` limit, truncated with a marker |
| Hub or worker restart | The DBOS workflow resumes; shards have stable step ids; a shard already finished is not re-run (its results are stored per spec as they arrive) |
| Spec list changes between shards (same PR) | The plan is stored; a push cancels the suite run (a new head, a new run) as Runs do |
| Duplicated demand / double start | idempotent by `suiteRunId` + shard index (the DBOS key) and the host's `Idempotency-Key` |

## 15. What changes where

| Area | Modules |
|---|---|
| Recipe schema | `libs/runtime/protocol/recipe.ts` (`SuiteSchema`, limits, `Recipe.suite`), the Go cell's recipe parser (accept and ignore), `libs/runtime/protocol/fixtures` shared vectors |
| Recipe author | `libs/runtime/api/application/recipe-author/ci-evidence.ts` (structured `suiteCandidate`), `recipe-author.agent.ts` (write the block), `authored-recipe-policy.ts` (validate it) |
| Contracts | `libs/runtime/contracts/runtime-commands.ts` (`RuntimeSuiteRequested`, `RuntimeSuiteRetried`), `enums.ts` (`CLAIM_CONSUMERS += 'suite'`, `RUN_TRIGGERS`, finding kind `e2e_regression`), `evidence.ts` (`suite-artifact`, `suite-result`), `libs/runtime/run/run-messages.ts` (suite section of the Run request), new `libs/runtime/suite/` (pure plan, balance, classify, JUnit parse: unit-testable with no I/O) |
| Worker | new `apps/runtime/src/worker/suite/` (engine, shard driver, detached exec poller, stores, publisher port); `run-orchestrator.ts` (a suite stage after the PR boots, `verdict` rules); `run-evidence.ts` (suite artifacts); `hub-environment-runtime.ts` (`AcquireRequest` `consumer: 'suite'`, side) |
| Protocol and hub | `libs/runtime/protocol/messages.ts` (consumer, claim policy for `suite`; optional `exec.start`/`poll`, D3), hub routing of the `suite:` bound key and claim ownership, admission checks |
| Cell (Go) | `apps/runtime-cell`: claim of consumer `suite` (Run-like), upload grants for `suite-artifact`, the service-level exec of a detached command. No browser-runner change |
| Fleet | `apps/runtime/src/fleet/per-run-host.ts` (bound key kind `suite`), `libs/runtime/placement/candidate-pools.ts` (`boundKeyOfSuite`), demand rows per shard, `template-rebuild.ts`/`template-trigger.ts` (enqueue the baseline when a template is `ready`), pool admission for customer orgs |
| Persistence | Runtime Postgres migration: `runtime_suite_runs`, `_shards`, `_results`, `_baselines`, `_spec_stats`; stores in `apps/runtime/src/worker/suite/` (like `pg-kept-check-results.ts`) |
| Publish | `libs/runtime-publish` (suite check slot and key, annotations in `ChecksPort`, `render-runtime-comment.ts` suite section, `runtime-publication.ts` model) |
| API and web | `libs/runtime/api` (suite use cases: list, retry a shard, rerun failed, enable CI mode in settings, usage line), `apps/web/src/app/(app)/runtime/runs/[runId]` (E2E suite tab), new `runtime/suites/[suiteRunId]`, settings: suite on/off, mode, gate |
| Cost | `libs/runtime/api/application/run-cost.service.ts`, `domain/usage-report.ts`, usage CSV, org ceiling |
| Docs | `docs/runtime/glossary.md`, `architecture.md` |

### 15.1 Contradictions with the decided shape (found in the code)

1. **boat admits only Kodus's org** (`host-providers.md` 8.2, `admission.allowOrgs`; the template step refuses other
   orgs). A customer's suite cannot run on boat hosts until legal accepts customer data at rest there. Until then
   the decided shape runs only for Kodus's own org; the cost model does not change when an AWS `perRun` pool
   exists (documented, not built: `host-providers.md` 9.3).
2. **The PR side must be built on every shard host.** The template is main's build; a PR needs its own. The cell's
   PR build measures 17 to 31 min on this repository family (`incremental-pr-side.md` table) against 7.1 min on CI,
   and with 3 shards the build is paid 3 times (no cross-host image sharing on boat: "boat pools do not use" the bake
   registry). The target of about 40 host-min is **not reachable without the incremental PR side** (on hold) or a
   build-once-share step. Without it a PR run is about 3 x (20 + 10) = 90 host-min. See D5.
3. **`exec` cannot carry a 10 to 25 min command**: `timeoutMs` max 600 s and 192 KiB output per call
   (`messages.ts:27`). Worked around with a detached command and polling (section 4).
4. **Evidence types** have 10 screenshots and one video per Run; no per-spec artifacts and no XML. A new
   upload type is required (section 7).
5. **The template is one per environment and follows the default-branch head**, not the PR's merge base
   (`template-rebuild.ts`, replacement rule in 8.2): "re-run on the merge-base main" is not directly possible; the
   main re-run is on the template's sha with `baseDrift` (section 8.2).
6. **`bakeFingerprintOf` rebuild is periodic** (`REBUILD_WINDOW_MS` 24 h, a pass, `template-rebuild.ts:11-13`), not
   instantaneous per commit; a baseline can lag the commit by a pass plus the setup time (20 to 35 min on a big
   monorepo, `incremental-pr-side.md`). Section 2.1 step 5 and 8.2 cover the lag; whether the pass is frequent
   enough is D6. Who requests the default-branch setup after a push was not read to the end (unverified).
7. **A Run is a pair of sides** (`acquireRequest` side `base`|`pr`); the suite wants one side at a time, many hosts.
   It is a new claim consumer, not a mode of the Run's two claims.

## 16. Metrics that prove it

All measured on a seeded fixture repo (a small app with a Cypress suite of 30 specs and a Playwright twin) and one
real customer-shaped run:

| Metric | Target | How |
|---|---|---|
| Time-to-result (green PR) vs the customer's CI 18 min | at most 18 min with the incremental PR side, reported honestly otherwise | wall time `requestedAt` to check close |
| Cost per PR | at most 40 host-min first pass; red PR at most +8 | `runtime_claims` of consumer `suite`, by phase |
| Classifier precision | 100% of seeded `regression` caught, 0 seeded `pre_existing`/`flaky` labelled `regression` | fixture with a known PR set: 3 regressions, 3 pre-existing failures (red on main), 3 flaky tests (fails 1 in 3 by a seeded counter), 2 infra faults (kill a shard, block a service) |
| Classifier stability | same labels on 10 repetitions of the same PR | repeat |
| Balance | slowest shard at most 1.25x the mean | per-shard time |
| Baseline reuse | 100% of PRs on a base with a baseline run no full main run | counter of main hosts per PR |
| Flake false-block rate | 0 PRs failed by a `flaky` | counter |

Dashboards and events: `runtime.suite.run{mode,outcome}`, `runtime.suite.shard_ms`, `runtime.suite.classified{class}`,
`runtime.suite.host_minutes{phase}`, closed labels (`apps/runtime/AGENTS.md`).

## 17. Build plan (the whole plan, in order; each step starts with a failing test)

1. **Pure suite library** `libs/runtime/suite`. Test first: balance puts a 5-spec/3-bin fixture in the exact bins by
   stored durations, falls back by size without stats, gives new specs the average, and `shardCount` follows 9.x.
   Then: JUnit and Mochawesome parsers (a fixture with a failed, skipped, retried-then-passed test), the
   `errorSignature` normalizer (two errors differing in a port normalize equal).
2. **Classifier**, pure, table-driven from section 9.3 / 9.5 / 9.2 / 9.4: one test per row, including mass failure,
   budget, infra, timeout on both sides, base drift. Written to fail until the function exists.
3. **Recipe schema**: a recipe with a valid `suite` parses; unknown keys, `--record`, a command over 1 KiB and 17 env
   entries are refused; the Go cell parses the shared vectors. Then `ci-evidence` returns a `suiteCandidate` from a
   fixture workflow (cypress with matrix 3, `--record --parallel` stripped, secrets as names only).
4. **Contracts and persistence**: command schemas round-trip (like `workspace.spec.ts`), migration applies, the
   stores' integration specs (spec stats update only on passes; baseline unique key; retention keeps the newest
   complete one) run against Postgres.
5. **Fleet**: `boundKeyOfSuite`, N demand rows per suite run, `per-run-host` serves a `suite:` key and keeps the host
   until the suite ends (fake provider spec like `per-run-host.spec.ts`), fewer hosts than shards spreads specs.
6. **Cell and hub claim** of consumer `suite`; detached-exec poller against a fake environment runtime: a 25 min
   command is started once and polled in under 600 s calls, a crash with no result file is `infra`.
7. **Engine first pass** with fakes: shards, streaming results, shard timeout `not_run`, crash re-run once.
8. **Engine re-run**: PR re-run on the shard host, main re-run on a template host, rules end to end on the seeded
   fixture's fake runner (regression, pre-existing, flaky, infra).
9. **Baseline trigger**: a template turning `ready` enqueues a baseline, coalesced; the PR run uses it per 9.5.
10. **Publish**: check slot, summary, annotations (over 50 paged), conclusion rules; the Run finding `e2e_regression`
    and verdict states (`partly_tested` when unclassified).
11. **Run orchestrator stage and CI mode trigger**; one engine, both modes' publish differences tested.
12. **API, web, usage**: suite tab and page, settings, usage line, org ceiling.
13. **Evidence**: `suite-artifact` upload type, budget, redaction and canary specs; failed-only retention.
14. **Live validation** (through the product, `verify-runtime`): the seeded fixture on the dev stack with a boat pool
    for Kodus's org; measure section 16; then the customer-shaped repository, reading its data only.

## 18. Open decisions (with a recommendation)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Main re-run attempts | 1, and 2 when at most 5 regressions (cheap, doubles confidence where it blocks) |
| D2 | `regression` when `baseDrift > 0` and the diff does not reach the spec | `regression_unconfirmed`, not a Kody finding; "update the branch" hint |
| D3 | `exec.start`/`poll` in the protocol vs detached wrapper | wrapper first (no protocol change), protocol later if two consumers need it |
| D4 | Check conclusion for `unclassified` without regression, and `strict` gate | `neutral` by default; `suite.gate: strict` per repo |
| D5 | PR build cost on N hosts | do the incremental PR side first, or cap shards to 2 on large-build repositories until it ships; do not build a registry just for this |
| D6 | Baseline lag after a main push | have the baseline wait for the template; show "baseline pending" and use the nearest ancestor baseline; a push-driven setup request if the 24 h pass is too slow |
| D7 | Customer orgs on boat | wait for legal; meanwhile run for Kodus's org and build the AWS `perRun` adapter if a customer is first |
| D8 | Videos | off by default, failed specs only when enabled |
| D9 | Suite in Run mode in parallel with probes, or after | in parallel when the PR claim has CPU for both; otherwise after the probes (the verdict is faster) |

## 19. Sources

- Splitting Cypress without Cypress Cloud, `cypress-split` (SPLIT / SPLIT_INDEX, timings file `SPLIT_FILE`, average for
  unknown specs, name-based fallback): https://github.com/bahmutov/cypress-split
- Playwright sharding (`--shard=x/y`, per-file without `fullyParallel`, blob reporter and `merge-reports`):
  https://playwright.dev/docs/test-sharding
- Flaky detection and quarantine practice (retry-on-failure classification, same-SHA pass/fail, failure rate over a
  window, quarantine that keeps running, a green retry is not proof):
  https://tuist.dev/blog/2026/01/27/flaky-tests, https://docs.datadoghq.com/fr/tests/flaky_management,
  https://nx.dev/docs/kb/flaky-tests-in-ci, https://blog.gradle.org/how-we-handle-flaky-tests-in-gradle,
  https://www.harness.io/blog/flaky-test-tooling-landscape-2026 (found by search; Datadog, Nx and Tuist points are the
  search summary, not read in full; Buildkite Test Engine was not found).
- boat limits: https://docs.boat.dev/limits.md (cited by `host-providers.md`).
