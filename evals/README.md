# Code-review evals

An eval measures one step of the review with production's own code. If it runs anything production does not, its number describes a product we don't ship.

This is the only page: the rules, how to create one, where to look. Numbers and lists (floors, models, schedules) live in the files linked here, never on this page.

## Rules

1. **Run production's code, never a copy.** Call the highest production entry point of the step. If what you need is written inline in a bigger method, extract it into a production function and call it from both the step and the eval. Copied glue drifts, and the drift shows only in the eval.
2. **The eval supplies data, nothing else.** Datasets, the org's stored config, the repository at the PR's head. Read intermediate results by wrapping a production method, never by replacing one. No hand-written stand-ins for engine services.
3. **Same input production builds.** Production's builders and defaults: the whole PR, the categories, the step budget, the language, the diff format. A field production never sets is not an input.
4. **Same tools.** Production's sandbox over the real repository at the PR's head, `exec` included. A recording that answers what production wouldn't is a different review.
5. **Same model route.** A stored BYOK config, through production's routing, for every model; an org with no model config (`kodus-managed`) is a contract test, not an eval; model ids and keys only through `evals/shared/tier0-models.js`. A route production doesn't have is refused, not run.
6. **Score what ships.** Measure after the steps production runs before posting. An eval that stops earlier says where and why in its README.
7. **Prove it can fail.** Cases come in pairs (the step must act / must not), and a deliberate break turns the eval red before it merges.
8. **Replacing eval code? Prove equivalence.** Diff what the step receives on every case, old against new. Identical: the floor stands. Different: explain each difference, then recalibrate.
9. **Floors come from runs.** Two runs of the same commit, the paired per-case difference, written in the eval's `targets.json` with the judge it holds under. Never in code, docs or PR text.
10. **Exit codes mean something.** 0 pass, 1 below the floor, 2 not measured with the reason logged. At most 5% of cases unmeasured; beyond that, exit 2. Every runner ends with `process.exit`.
11. **Alerts stay rare and true.** A drop alerts only after the confirming run; infra never mentions anyone.
12. **Every PR touching `libs/`, `evals/` or test fixtures** runs `pnpm eval:wiring` to "Every eval still drives the engine." and links the run. A PR that changes review behaviour also links a nightly run.
13. **Say what it checks and what it costs.** The README's **Answers** line is the question, and each case says in one sentence what it checks. The result records the input, cached (read and written) and output tokens and the time of every model call; the panel shows the cache-hit share and $ from them. An eval with no model call records zeros. `pnpm eval:wiring` fails a step whose result lacks any of it.

## Create one

1. `pnpm eval:new <name>` writes the README header (Answers, Runs, Run it, Gate, Cost), paired cases, the catalog, `targets.json`, and a runner that writes the shared result (`evals/shared/eval-result.js`), counts tokens and time, and exits 0/1/2.
2. Point it at the step's production entry point (rules 1–6).
3. Name its step in `evals/stages.js` (what the step does, its tests, its eval) and add a `model: true` step to `evals/wiring-smoke.js`.
4. Run it twice on every tier-0 model, write each floor (rule 9), break it on purpose (rule 7).
5. To measure it every night and every week, add it to `evals/nightly-evals.js` with its controlled set, and its full set for on-demand runs.

## When it runs

A test passes or fails the same on every run: unit tests, and contract tests that drive a step's production code end to end with a scripted model. An eval measures how good a step is with a real model, against a floor. `evals/stages.js` lists every step with its tests and its eval.

| When | Answers | Does not tell you | Where |
|---|---|---|---|
| Every PR | Do the step's tests pass? Unit tests, and every eval driving its step with a scripted model, no keys. | How good a step is: it measures nothing. | `.github/workflows/tests.yml`, `.github/workflows/code-review-evals-pr.yml` |
| Every night | Did a step get worse? Its eval on the controlled set, one model, when one of its files changed, against its floor; a drop is confirmed by a second run before it alerts. Every step's tests run on main too. | Whether other models behave the same. | `.github/workflows/code-review-evals-nightly.yml` |
| Every week | How good is each step on every model customers run? Every tier-0 model on the controlled set, each against its own floor. | A change on the day it merges: the nightly answers that. | `.github/workflows/code-review-evals-weekly.yml` |
| On demand | Anything else: another model, the full sets while their datasets change (`pnpm eval:weekly --model=<id> --set=full --out=<dir>`), an investigation. No floor. | Nothing alerts. | each eval's README |

- **Each step's tests, its eval on every model and what it costs:** the quality panel's stages page, fed by `evals/stages.js` → `evals/stage-signals.js`.
- **Results:** Discord, the Actions job summary and the run's artifacts.
- **Floors:** each eval's `targets.json`. **Judge:** `evals/investigation/recall-judge.js`. **Models:** `evals/shared/tier0-models.js`. **Scripted model:** `evals/shared/fake-llm-server.js`.
- **Run locally:** `pnpm eval:wiring` (no keys) · `pnpm eval:nightly` · `pnpm eval:weekly --model=<id> --set=controlled --out=<dir>` · each eval's README for narrower runs.

### When it goes red

- **Wiring smoke on your PR:** your change broke an eval's hold on the engine. Fix the eval in the same PR.
- **Nightly "não mediu":** a key, a quota or the network. Not a quality result.
- **Nightly "oscilou":** the confirming run passed. Nothing to do.
- **Nightly "caiu abaixo do piso":** the message lists the PRs, the bugs lost and the commits. Re-run before and after the suspect commit; an intended trade-off recalibrates in the PR that made it.
- **Weekly 🔴 `model` step:** confirmed below that model's floor; a per-model decision, not a reason to stop the release. **⚠️:** it did not measure: its key or quota.

## Experiments

Is a change to a step better than what main has? An experiment answers it on your machine or in CI.

### Run one

1. Branch from main, change the step, and commit. The command refuses uncommitted changes: the result must point at code that exists.
2. Run `node evals/experiment.js --step=<step>` with the model keys in the environment (the same ones the evals use; the dedup also needs the platform's OpenAI key, `API_OPEN_AI_API_KEY`, for its embedder). In CI: the "Evals: experiment on a review step" workflow, dispatched on your branch.
3. Read `summary.md` or the panel's Experiments tab: the run sends its rows there when `KODUS_QUALITY_INGEST_TOKEN` is set (`~/.kodus-dev/config`; the panel's `EXPERIMENTS_INGEST_TOKEN`).

To change more, commit and run it again.

### What it compares

- **The base** is the commit of main your branch last started from: `git merge-base HEAD origin/main`. Rebase or merge main into the branch and the base moves to that commit; your changes stay, and earlier experiments keep the commits they ran on.
- **The candidate** is your branch's HEAD.
- The command checks out the base in a temporary folder (`git worktree`), runs the same evals in both folders with the same cases, model and judge, compares the results case by case, and removes the folder. The evals' own files must be the same on both sides; land an eval change on main first.
- Not main's tip on purpose: what others merged since you branched would count as yours.
- `--base=<ref>` compares against another branch; `--phases=regression` runs the first question only.

### What it answers

1. **Did it break anything?** The main eval on its controlled set, and the evals that must not get worse. Fast; it catches a drop.
2. **Is it better?** The main eval on its extended set: enough cases for a real change to clear its interval.

Each eval runs `--runs` times per side (2 by default), alternating. Per case, paired: each side's pooled metric, the difference with a 95% bootstrap interval over the cases, and the cases that got worse or better. A difference counts only when its interval clears zero.

**It ships when**, fixed before the run: the step's code changed (its step version differs), every eval measured on both sides (at most 5% of cases unmeasured), nothing got worse in question 1 (the main eval not worse beyond its interval, no case of a must-not-get-worse eval worse), and question 2 is better beyond its interval or ties with fewer tokens. A measure read from the main eval's own cases (`derived` in `STEP_EVALS`: for the dedup, how many of its merges were right) may not get worse beyond its interval in either question, so a change cannot win by merging everything. With question 1 alone, the answer is "no regression", never "ships".

### What it records

Each side's step version (a hash of the production files its evals loaded, at their committed content: the same on both sides means the branch did not change this step), the files that differ, the eval and dataset versions, what each eval reports of its environment, and model use. Under `--out`: `experiment.json`, `summary.md`, and `rows.json` (`experiments.<step>.<phase>.<eval>.<name>`, where the name is the branch, the candidate commit and when the run started, so every run keeps its own rows). Every run sends `rows.json` to the panel's experiments API (`evals/shared/quality-client.js`), which builds its Experiments tab and each step's experiments from them; they never replace a number main measured. With `--if-new` (a PR's check, the workflow), code the panel already measured, the same content in every step file on both sides and the same phases, is not run again: the summary points at that result. Run it on your machine and push: the PR does not pay for it twice.

The panel dates each experiment by itself: **active** while its branch is open and nothing it measured has changed; **out of date** when main changed one of the step's production files after the base (rebase and run it again) or the branch changed one after the candidate; **merged** or **closed** with its pull request, kept under Archived as the evidence for that version. A newer run on the same branch keeps the earlier ones inside its card.

### Add a step

Add it to `STEP_EVALS` in `evals/experiment.js`: its main eval (`id`, a short `label`, `run`, `question`) and the evals that must not get worse. The main eval must take `--set=controlled|full`, keep a stable `id` per case, and write the shared result (`evals/shared/eval-result.js`). A dataset is tied to what produced it: `evals/dedup-groups` scores the dedup on suggestions from the lean finder of #1821, so its numbers say how a dedup groups that finder's output, not today's.
