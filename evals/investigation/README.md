# Finder recall

> - **Answers:** Of a PR's known bugs, how many does the review ship? (finder-recall)
> - **Runs:** nightly on the controlled set, gated (`.github/workflows/code-review-evals-nightly.yml`) · weekly on every tier-0 model's controlled set and DeepSeek's full set, each gated on its own floor (`.github/workflows/code-review-evals-weekly.yml`) · every engine PR, against the scripted model (`evals/wiring-smoke.js`).
> - **Run it:** `pnpm eval:nightly` · `node evals/investigation/run-recall.js --model=<tier-0 id> --set=controlled`
> - **Gate:** run mean against the floors in `evals/investigation/targets.json`, only under the judge recorded there.
> - **Cost:** one production review per PR plus the judge on every PR in the set.

## What runs

Production's review of each PR, from the platform data on: `agent-provider.js`
hands the case to `evals/shared/review-stage.js`, whose header lists the
production code it runs and in what order (the team's config, the model route,
the changed files, the sandbox with `exec`, then `AgentReviewStage` with every
step it runs before posting).

The eval supplies data only:

- the PR as the platform adapter returns it: `prFiles`, `prCommits`, `prHead`
  and `prBase` in each dataset, recorded once by `fetch-pr-data.js`;
- the repository at the PR's head: a mirror of the platform's refs
  (`evals/shared/repo-mirror.js`, cached under `EVAL_REPO_CACHE`);
- the team's stored config: none (the defaults), or the memories and overrides a
  case carries;
- the org's model config (`evals/shared/model-route.js`): a stored BYOK config
  holding the model, DeepSeek included. An org with no model config (`kodus-managed`)
  is a contract test (`evals/wiring-smoke.js` `managed-route`), not an eval.

Not the same as production: the eval org has no stored AST graph, so the stage
builds the call graph from the checkout (its legacy path), and it is on no
release track, so features behind a release gate stay off.

## What it scores

`recall-assertion.js`, with the judge in `recall-judge.js`:

- **recall** (gated): known bugs (`goldenComments`) matched by what the review
  ships. Each bug keeps one finding, the one the judge is surest of.
- **loop recall** (reported): the same bugs against what the finder's loops
  returned, before the steps that follow them. `evals/funnel` says which step
  loses a bug.
- **precision**: matched bugs, of those plus the findings matching none. A second
  finding of the same bug is a false positive.

The gate also holds two collapse floors, mean findings and mean tool calls per
PR, which trip when the engine breaks rather than when recall wobbles.

## Sets and options

- `--set=controlled` (15 PRs: the nightly, and every model's weekly run) ·
  `full` (all 50, on demand) · `light` (30) · `pr` (8) · `smoke` (5) ·
  `--cases=<id,id>`. The sets are in `recall-tests.js`; `catalog.js` names the
  controlled set's PRs. Each set has its own floors in `targets.json`.
- `RECALL_CATEGORIES=bug,security`: the team's category toggles.
- `RECALL_REASONING_EFFORT=<effort>`: the model through a stored BYOK config with
  that effort.
- `RECALL_DUMP=<dir>`: the agent's raw output per case, including the findings
  the verifier refuted (`trace.droppedByVerify`).
- `RECALL_REPO_INSTRUCTIONS=<file>`: the team turns on "Use coding-agent
  instructions in reviews", and each case's target branch holds the instruction
  files listed for it in `<file>` (`build-repo-instructions.ts` writes it:
  `--at=base` each PR's base commit, `--at=pinned` the commits in
  `repo-instructions-pins.json`). Without it every case runs with the setting off.
- `--no-judge`: run the review and save its findings (`.submission.json`) for
  `rejudge.js` or `evals/scorer`.

Refused with exit 2: a subscription model (`@sub`), `RECALL_HEAVY` (behind a
release gate), and a model not in `evals/shared/tier0-models.js`.

## A new case

A dataset in `datasets/` carries the PR's `benchmarkSourceUrl`, its title and
body, and its `goldenComments`. `node evals/investigation/fetch-pr-data.js
--cases=<caseId>` records the platform data. It joins the `full` set on its own;
to put it in the controlled set, add it there and recalibrate every model's
floor (`evals/README.md`, rule 9).

## The nightly's tools

- `gate.js` / `confirm-gate.js`: the floors, and the confirming second run.
- `nightly-compare.js`: the bugs lost and gained against the last green night.
- `investigate-facts.js` / `extract-investigation.js`: the facts the drop
  investigation agent gets, and its verdict.
- `rejudge.js`: re-scores a saved run under another judge, without re-running
  the review.
- `agreement/`: how a candidate judge agrees with the reference one.
