# Code-review evals

An eval measures one step of the review with production's own code. If it runs anything production does not, its number describes a product we don't ship.

This is the only page: the rules, how to create one, where to look. Numbers and lists (floors, models, schedules) live in the files linked here, never on this page.

## Rules

1. **Run production's code, never a copy.** Call the highest production entry point of the step. If what you need is written inline in a bigger method, extract it into a production function and call it from both the step and the eval. Copied glue drifts, and the drift shows only in the eval.
2. **The eval supplies data, nothing else.** Datasets, the org's stored config, the repository at the PR's head. Read intermediate results by wrapping a production method, never by replacing one. No hand-written stand-ins for engine services.
3. **Same input production builds.** Production's builders and defaults: the whole PR, the categories, the step budget, the language, the diff format. A field production never sets is not an input.
4. **Same tools.** Production's sandbox over the real repository at the PR's head, `exec` included. A recording that answers what production wouldn't is a different review.
5. **Same model route.** A stored BYOK config or the managed default, through production's routing; model ids and keys only through `evals/shared/tier0-models.js`. A route production doesn't have is refused, not run.
6. **Score what ships.** Measure after the steps production runs before posting. An eval that stops earlier says where and why in its README.
7. **Prove it can fail.** Cases come in pairs (the step must act / must not), and a deliberate break turns the eval red before it merges.
8. **Replacing eval code? Prove equivalence.** Diff what the step receives on every case, old against new. Identical: the floor stands. Different: explain each difference, then recalibrate.
9. **Floors come from runs.** Two runs of the same commit, the paired per-case difference, written in the eval's `targets.json` with the judge it holds under. Never in code, docs or PR text.
10. **Exit codes mean something.** 0 pass, 1 below the floor, 2 not measured with the reason logged. At most 5% of cases unmeasured; beyond that, exit 2. Every runner ends with `process.exit`.
11. **Alerts stay rare and true.** A drop alerts only after the confirming run; infra never mentions anyone.
12. **Every PR touching `libs/`, `evals/` or test fixtures** runs `pnpm eval:wiring` to "Every eval still drives the engine." and links the run. A PR that changes review behaviour also links a nightly run.

## Create one

1. `pnpm eval:new <name>` writes the README header (Answers, Runs, Run it, Gate, Cost), paired cases, the catalog, `targets.json`, and a runner that writes the shared result (`evals/shared/eval-result.js`), counts tokens and time, and exits 0/1/2.
2. Point it at the step's production entry point (rules 1–6).
3. Name its step in `evals/stages.js` and add a `model: true` step to `evals/wiring-smoke.js`.
4. Run it twice on the nightly model, write the floor (rule 9), break it on purpose (rule 7).
5. To measure it every night and every Friday, add it to `evals/nightly-evals.js`.

## Where to look

| When | Answers | Does not tell you | Where |
|---|---|---|---|
| Every PR | Do the evals still drive the engine? Scripted model, no keys. | Anything about quality: it measures nothing. | `.github/workflows/code-review-evals-pr.yml` |
| Every night | Did quality drop? One cheap model, each eval whose loaded files changed, against its floor; a drop is confirmed by a second run before it alerts. | Whether other models behave the same. | `.github/workflows/code-review-evals-nightly.yml` |
| Every Friday | Does every step still run on every tier-0 model? A few cases each, no floor. | Quality on those models: green means it runs. | `.github/workflows/code-review-evals-tier0.yml` |

- **Each step's quality, what it tests and what it costs:** the quality panel's stages page, fed by `evals/stages.js` → `evals/stage-signals.js`.
- **Results:** Discord, the Actions job summary and the run's artifacts.
- **Floors:** each eval's `targets.json`. **Judge:** `evals/investigation/recall-judge.js`. **Models:** `evals/shared/tier0-models.js`. **Scripted model:** `evals/shared/fake-llm-server.js`.
- **Run locally:** `pnpm eval:wiring` (no keys) · `pnpm eval:nightly` · `pnpm eval:tier0-smoke --model=<id>` · each eval's README for narrower runs.

### When it goes red

- **Wiring smoke on your PR:** your change broke an eval's hold on the engine. Fix the eval in the same PR.
- **Nightly "não mediu":** a key, a quota or the network. Not a quality result.
- **Nightly "oscilou":** the confirming run passed. Nothing to do.
- **Nightly "caiu abaixo do piso":** the message lists the PRs, the bugs lost and the commits. Re-run before and after the suspect commit; an intended trade-off recalibrates in the PR that made it.
- **Friday ❌ `model · step`:** that step no longer runs on that model. **⚠️:** its key or quota.
