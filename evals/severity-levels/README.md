# severity-levels

> - **Answers:** Does the severity step rate each suggestion at the level its text defines?
> - **Runs:** on demand and in experiments (`evals/experiment.js --step=severity`); two of its PRs on the scripted model on every PR (`evals/wiring-smoke.js`).
> - **Run it:** `node evals/severity-levels/run.js --model=<id> [--gate]`
> - **Gate:** `--gate` fails when the share of all suggestions, or of any one level, is below that model's floor in `targets.json` (`sets.controlled.models`); a model with none reports ungated.
> - **Cost:** one severity call per PR, 75 calls for the 205 suggestions.

Drives production's `AgentReviewStage.reclassifyAndFilterSeverity` (`agent-review.stage.ts`)
on each PR's suggestions in one call, as the review makes it, with the team's default
config and the org's model routed as production routes it (`evals/shared/review-stage.js`).
The level of each suggestion is read from what the step keeps and what its threshold drops.

The cases are the severity dataset of #1821 (`evals/severity/dataset/items.json`): 205
suggestions, 50 low, 70 medium, 50 high and 35 critical. Each was rated from its own text
against the defined levels (`evals/severity/definitions.md`), not from what the bug
turned out to be: the step sees only the text. 174 come from the gold v3 reviews of
#1821; 31 critical are written for the eval and kept only when Astra confirmed them, since
the reviews have 4. The rating is the step's whole job, so `controlled` and `full` are the
same 205.

A suggestion is right when it gets its level, and only then: a critical rated high is
wrong.

The prompt was chosen over 17 versions in `evals/severity` (`prompts.js`, test 17b; the
results page is built by `report.py`).

Deliberate break: a classifier that answers nothing usable rates everything medium
(`classify-severity.ts` fallback), which gets 70 of 205 and none of low, high or critical,
below every floor.
