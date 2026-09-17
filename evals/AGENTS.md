# Evals — rules for agents

What runs when, and what each eval answers: [README.md](README.md). These rules keep the evals measuring the engine instead of their own scaffolding. Each one exists because breaking it has already cost weeks of evals that looked green or red for the wrong reason.

## Before you finish a change

- If you changed anything under `libs/`, `evals/` or `test/fixtures/`, or a dependency, run `pnpm eval:wiring`. The evals load far more than the review folders (`libs/core`, `libs/common`, `libs/identity`, …). It must end with "Every eval still drives the engine." A red step is a break you introduced, even when the unit tests pass.
- If the smoke reports loaded files outside the paths filter, widen `.github/workflows/code-review-evals-pr.yml`. Never narrow it back to a hand-picked folder list.
- If the change is meant to alter review behaviour, attach eval evidence to the PR (root `AGENTS.md`): a nightly run, or a local `pnpm eval:nightly` result compared with `observed` in `evals/investigation/targets.json`.

## Writing or editing an eval

- Drive the engine through its real entry points. To run without a vendor, use `--model=eval-fake` (`evals/shared/fake-llm-server.js`). Don't hand-write a stub of an engine service: stubs are what drifted (`permissionService.resolveTaskSlot`).
- Route every model through `evals/shared/tier0-models.js` (`applyModelEnv`). An eval never reads vendor keys itself.
- End every runner with an explicit `process.exit`: 0 pass, 1 quality or gate failure, 2 infra. The engine leaves handles open, so a runner that just returns from `main()` can hang CI after it has finished.
- Exit 2 is "not measured". Never turn it into a pass or a warning, and always log the reason next to it. A count with no reason is how a dead judge key went unseen for weeks.
- If the eval drives the engine, add a step to `evals/wiring-smoke.js` with `model: true`.

- The investigation agent is advisory. Its reading never sets the verdict, the gate or a floor, and the nightly message goes out without it when the agent fails. Keep it read-only (`Read,Grep,Glob`); the evidence holds model-written text.

## Floors and judges

- Floors live in `evals/investigation/targets.json` (finder-recall) and `evals/kody-rules/kody-targets.json` (kody-rules). Point at them; never copy their numbers into code, docs or PR text.
- A floor holds only under the judge recorded with its set. `evals/investigation/run-recall.js` refuses to gate across judges, so changing `JUDGE_MODEL` means recalibrating.
- Calibrate from run-to-run noise: two full runs of the same commit, using the paired per-PR difference. The method is in the set's `__doc`. Cross-PR spread overstates the noise, and 8 PRs can't see a realistic drop.
- If a PR moves recall on purpose, recalibrate in that PR and link both runs.

## Map

- `evals/wiring-smoke.js`: the PR check
- `evals/investigation/run-recall.js`: finder-recall runner, used by the nightly
- `evals/tier0-smoke.js`: the Friday per-model check
- `evals/ci-report.js`: Actions job summary and Discord message (Portuguese; facts first, the agent's reading only on red nights)
- `evals/investigation/nightly-compare.js`: tonight vs the last green night (per-PR recall, known bugs lost and gained, noise, cost)
- `evals/investigation/investigate-facts.js` + `evals/investigation/investigate-prompt.md` + `evals/investigation/extract-investigation.js`: the red-night investigation. The facts are built deterministically; a read-only Claude Code agent reads them; the extractor accepts only a well-formed verdict
- `evals/shared/tier0-models.js`: model id → engine route and key env names; `tier0()` is the Friday list
- `evals/shared/fake-llm-server.js`: the scripted model
- `evals/investigation/recall-judge.js`: the judge (`JUDGE_MODEL`, `JUDGE_API_KEY`, `JUDGE_BASE_URL`)
- `evals/engine-gate.js`: preflight, run first by the wiring smoke
- `evals/shared/trace-loaded.js` + `evals/shared/engine-files.js`: record what each eval loads; PR filter coverage and the nightly's "did it change" check
- `evals/shared/doc-references.js`: checks the pointers in these docs

## Docs

- Don't copy numbers or lists into docs; point at the file that owns them.
- The preflight checks every path, link, `pnpm eval:*` script and `node <file>` command in `evals/README.md`, `evals/AGENTS.md` and each eval's README. A stale pointer fails the PR.
- Every eval README starts with the standard header: **Answers**, **Runs**, **Run it**, **Gate**, **Cost**. The preflight checks that too.
