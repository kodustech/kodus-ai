# runtime-test-planner

> - **Answers:** Does Kody Runtime's test planner probe the route a pull request's change reaches (with `via` for a file with no route of its own), probe nothing the diff does not reach, and name in `cannotProve` what no probe can reach, better than the 2-turn loop it replaced?
> - **Runs:** on demand (`node evals/runtime-test-planner/run.js`). Not in `evals/stages.js` or the wiring smoke: those list code-review steps, and the Runtime planner is not one.
> - **Run it:** `node evals/runtime-test-planner/run.js --model=<id>` · `--planner-host=worker|product` · `--cases=<id,...>` · `--set=full|grafana|synthetic` · `--sides=planner` (skip the baseline) · `--output=<result.json>` · `--record` (appends to `evals/results/runtime-test-planner.jsonl`)
> - **Gate:** `--gate` requires a calibration for the selected host, headline side and complete dataset. The historical floor applies only to `--planner-host=product`; worker, narrowed sets and uncalibrated models exit2 before credentials/providers load.
> - **Cost:** per case, one planner Run (0 to 3 rounds of the harness agent: none when the diff has nothing to trace) and one baseline Run (2 model calls). On deepseek-v4-flash@fireworks, 2026-11-07: planner 93k to 133k input tokens over the 10 cases (two runs), baseline 56k in and out.

## Evidence scope after the worker migration

The runner now defaults to `--planner-host=worker`: the actual
`WorkerRunPlanClient`, product `RuntimeModelTurnGatewayUseCase` and
`RuntimePlannerSourceUseCase`. The no-network adapter in `planner-host.ts`
replaces HTTP delivery only; authentication, head/attempt scope, sealed context,
receipts, per-attempt budgets, source restrictions and model framing are production's.
Quality runs use `ByokRuntimeModelTurnProvider` with the org's stored model slot.
`--planner-host=product` preserves the historical API-hosted path explicitly.
This eval default does not change the deployment's `plannerHost=product` default.

`options.test.js` and `planner-host.spec.ts` are **offline contract tests**. They
use scripted model data and synthetic keys/storage, exercise the real worker
client and scoped product authority, and do not establish current model quality,
executed bug recall or field false-positive rate. Run these exact files in CI:

```sh
node --test evals/runtime-test-planner/options.test.js
API_NODE_ENV=test node node_modules/jest/bin/jest.js --runTestsByPath evals/runtime-test-planner/planner-host.spec.ts --runInBand
```

Quality execution is opt-in and can use paid providers and Git reads. Supply model
keys through the environment; `--load-env` explicitly opts into reading the repo's
`.env`, `.env.local`, and `~/.kodus-dev/config`. Implicit production `dotenv/config`
imports are pinned to the null device even if a path was inherited. No quality
run, real credential read or Git access was performed while adding these tests.

Results and recorded rows include `plannerHost`, selected cases, hashes of the
case labels/pins,19 local fixture files, recorded machine answers and loaded
repository sources (including the shared prompt). Hashes describe local bytes,
including uncommitted changes; they are not a committed release or a quality score.
The historical November7 rows are retained. Their product-only calibration now
binds to the complete dataset hash and case IDs; those data inputs were checked
unchanged against the pre-merge commit they were calibrated on. Worker quality needs fresh full-dataset calibration;
`--cases`/`--set` diagnostics never inherit an incompatible floor. Missing or
unreadable calibration inputs return not-measured2 without raw filesystem errors.

The graders still score plans/route declarations with recorded shell answers;
they do not replay the app.

## What it drives

Both sides run production's `RuntimeAgent.plan` (`apps/runtime/src/worker/agent/runtime-agent.ts`) with the input `run-orchestrator.ts` builds: the diff from `CodeManagementRuntimeGitAdapter.getPullRequestDiff` and `diffForRun`, the entry points from `extractEntryPoints` minus the dependency surface, the changed files' content and the environment's targets.

- **planner**: worker-hosted by default, through production's `WorkerRunPlanClient`, SDK loop, scoped source reads and single-turn gateway. `--planner-host=product` calls `RuntimeTestPlannerUseCase.execute` for comparison. Both read the recorded base through the same production readers and route model work through the org's `LLM_TASK.runtime` slot.
- **baseline**: the same `RuntimeAgent` with no planner, the 2-turn loop of ef32c9ae0. Its `LlmGateway` calls `RuntimeLlmGatewayUseCase.execute` (`POST /internal/runtime/llm`) on the same slot.

The eval supplies data only: the repository (`sources.js`), what the base machine answers to shell commands (`base-machines.js`), the Run projection, the Run's budget store in memory, and the org's stored BYOK config (`evals/shared/model-route.js`). The budget is production's default (`runtime-api.config.ts`, 200k tokens per Run). Tool calls are observed by wrapping the production runner and each tool's `execute` within the case's async context; their behavior is not replaced. Run tokens remain sealed at the worker input.

- **Repository:** the real PRs come from GitHub's REST API with the `gh` CLI's token, pinned to the head sha in `cases.json` and cached under `~/.cache/kodus-evals/runtime-test-planner`. The synthetic cases live in `fixtures/<id>/base` and `fixtures/<id>/head`.
- **Base machine:** the eval cannot boot one per case, so `exec_on_base` is answered from recordings (evals/README.md rule 4, an exception made on purpose). Grafana's image is what `.kodus/Dockerfile.backend` builds on the fork: alpine, `bin/ conf/ public/`, busybox `wget`, no curl, no Go toolchain, no source. The synthetic apps run from their source. A command no recording answers gets `sh: <cmd>: not found`, and the result marks it `recorded: false`.

## Cases

`cases.json` is the ground truth: real PRs on the fork `Wellington01/kr-grafana` (base `main` at ee53311688) and three small apps from other stacks. Each case says in one sentence what it checks.

| Case | Change | Right plan |
|---|---|---|
| grafana-4 | `databaseHealthy` breaks (`pkg/api/health.go`) | `GET /api/health` via `pkg/api/health.go` (a real Run found 200 → 503) |
| grafana-5 | `branch` added to `healthResponse` (`pkg/api/http_server.go`) | `GET /api/health` via `http_server.go`, comparing json |
| grafana-9 | failure-cache TTL (`health.go`) | `GET /api/health` via `health.go` |
| grafana-6 (control) | go.mod/go.sum bump | no probe; `go.mod` in cannotProve |
| grafana-7 (control) | `.kodus/compose.yaml` only | nothing to probe |
| grafana-8 (control) | CLI text (`reset_password_command.go`) | no probe; the file in cannotProve |
| grafana-3 (control) | comment in `pkg/cmd/grafana/main.go` | no probe; the file in cannotProve |
| express-route-mounted | Express handler `GET /orders/:id` on a router mounted at `/api` | a probe on `/api/orders/<id>` |
| nest-service-via-controller | Nest service with no route (global prefix `api`) | `GET /api/pricing/quote` via the service |
| django-view-via-urls | Django `item_detail` view | `GET /api/items/<pk>/` via `items/views.py` |

## Metrics

Per case, each item below is a check (`hits/total`). The headline is the share of checks right over all cases.

- **route recall:** a probe's `entryPoint` matches the expected route and its `spec.path` reaches it (`/api/orders/1`, not `/orders/1`).
- **via correctness:** that probe carries `via` = the changed file.
- **false probes:** probes whose path is outside the case's `allowedPaths`, i.e. a route the diff does not reach. On a control case every probe is false.
- **honest uncovered:** every entry point and unmapped file the planner was handed is probed or in `cannotProve`, as production's `checkPlanSubmission(...).missing` reads it.
- **schema-valid on the first submission:** the planner's first `submit_plan` was accepted; for the baseline, its one answer parses and `planProblems` is empty. A diff the use case plans with no model call (no entry point, or only dependency versions or comments changed) counts as valid when the checks accept the plan it answered.
- **tokens and wall time** per side and case: every model call, from `evals/shared/eval-kit.js`, plus what the Run's budget settled (`budgetSpent`).

## Measured

deepseek-v4-flash@fireworks, one run per side and case, 2026-11-07, on the Kody Runtime branch before it was merged (that commit is not on main). "Planner after" adds the uncommitted planner fixes below; the baseline's code did not change, so it ran once. Rows are in `evals/results/runtime-test-planner.jsonl`.

| Side | Checks | Route recall | Via | False probes | Honest uncovered | Valid 1st submit | No plan | Tokens in / out (cache read) | Wall |
|---|---|---|---|---|---|---|---|---|---|
| baseline (2-turn) | 21/45 | 3/6 | 3/5 | 17 | 8/10 | 2/10 | 0 | 30.7k / 25.5k (8.9k) | 120 s |
| planner, as committed | 38/45 | 6/6 | 5/5 | 0 | 9/10 | 5/10 | 1 | 916k / 88k (611k) | 410 s |
| planner, after fixes | 43/45 | 6/6 | 5/5 | 2 | 10/10 | 10/10 | 0 | 444k / 40k (238k) | 255 s |

What the numbers say:

- The baseline guesses routes it never read. Each control case got 1 to 3 probes (17 false in all), and it probed `/orders/1` for a router mounted at `/api`.
- As committed, the planner found every route and every `via`, but it cost 18 times the baseline's tokens. Grafana-6 read the codebase until its token budget ran out and returned no plan. On Go, three in five first submissions were refused because the model attached `go test ./pkg/api` to a `via` route, and a test must belong to a mapped entry point.
- After the fixes, the two misses are false probes: `GET /api/frontend/settings` via `go.mod` on the dependency bump (semver is used in plugin assets), and the untouched `GET /api/items/` beside the changed detail view. Grafana-6 still settles 203.5k tokens against the Run's 200k budget, an overshoot of one step.

### Token cut (2026-11-07)

On the same model and cases, a later pre-merge commit of the Kody Runtime branch plus the uncommitted planner changes below, run twice (rows "planner-tokens" in the jsonl). "Before" is a fresh run of that commit the same day.

| Run | Checks | Route recall | Via | False probes | Honest uncovered | Valid 1st submit | Tokens in / out (cache read) | Max one Run | Wall |
|---|---|---|---|---|---|---|---|---|---|
| before (that commit) | 42/45 | 5/6 | 4/5 | 5 | 10/10 | 10/10 | 349k / 29k (190k) | 172k | 148 s |
| after, run 1 | 45/45 | 6/6 | 5/5 | 0 | 10/10 | 10/10 | 133k / 17k (83k) | 54k | 76 s |
| after, run 2 | 45/45 | 6/6 | 5/5 | 0 | 10/10 | 10/10 | 93k / 14k (68k) | 28k | 63 s |

Where the tokens went: every step re-sends the conversation, and a round began again from the notes alone. Grafana-5 took 172k in three rounds: `http_server.go` read whole (64 KB) in every round, and every step after it carried it again. Two of the three rounds were `exec_on_base` calls of `/api/health` with curl, which the image does not have, to learn what the probe itself would answer. Grafana-6 (go.mod) read code with nothing to trace.

What changed (`libs/runtime/api/application/test-planner/`):

- `read_file` answers numbered lines: a file of up to 160 lines whole, a longer one around the lines this round's searches found and the diff changed (25 on each side, 220 at most), or the `startLine`/`endLine` asked for. The whole file is redacted before it is windowed; secret files still show names only. Lines already shown this round are named, not sent again; a repeated search too.
- When a round ends with commands, the notes carry what it found: search hits and the line ranges read (never their text), so the next round reads only what it lacks.
- `exec_on_base` is described as ending the round, and never for calling the app's routes. No case of the two runs called it; in a run before the last prompt line, grafana-5 still used it once, for a config value (`hide_version`).
- No model call when every file left to plan is a manifest whose changed lines only move versions (go.mod, requirements, a version pin in package.json, Cargo.toml, pyproject.toml), or a file whose changed lines are only comments (Go directives, shebangs and encoding lines excluded; a diff at its size cap is never taken): each file goes in `cannotProve` with why (`plan-without-model.ts`).
- With no entry point, `submit_plan` has no `tests` field and drops tests sent anyway: every one would be refused, and the refusal cost a step (grafana-4 was refused twice for a `go test` on a `via` route).
- A round is 60k tokens and 12 steps (was 300k and 20). The stop policy sizes the next step as the last one plus what the tools answered since, and leaves only `submit_plan` while that step, one more and the largest growth seen would not fit: no Run went over its reservation (max 54k against 200k).
- Search answers at most 25 hits of 200 characters (was 40 of 300).
- The prompt says `spec.path` is the path the app serves, and to find the mount and any global prefix first. Without that line, nest-service-via-controller probed `/pricing/quote` instead of `/api/pricing/quote` in the before run and both runs before the line was added (2/5).

What got worse: nothing measured. Grafana-9 now lists its own file in `cannotProve` beside the probe (the failure-path TTL cannot be forced from outside), which the checks accept. The comment and dependency rules are text rules on the diff: a manifest with a script change or a comment that is a build directive still goes to the agent.

One run per side decides nothing about small differences. `targets.json` contains the historical floor calibrated from two runs of one commit (rule 9); a new path/model/case set needs its own measured calibration before that floor can be reused.
