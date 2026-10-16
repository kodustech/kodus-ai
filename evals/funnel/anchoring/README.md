# funnel/anchoring

> - **Answers:** Of the known bugs the finder's findings reach anchoring with, how many survive the path check and the line snap to the diff?
> - **Runs:** nightly when anchoring or the snapshot changes (`evals/nightly-evals.js`), ungated until the relabeled dataset lands; Friday on every tier-0 model.
> - **Run it:** `node evals/funnel/anchoring/run.js`
> - **Gate:** none yet (`targets.json`): the value is reported as ungated.
> - **Cost:** none: no model call.

Runs the production anchoring on the frozen findings that survived verify
(`evals/funnel/snapshot`): the mapper's path check against the PR's changed
files (`mapAgentFindings`, `finding-mapper.ts`) and `snapLinesToDiff`
(`agent-review.stage.ts`), which drops a finding whose lines touch no hunk. A
known bug is lost when every finding that matches it is dropped. The valid
ranges come from the dataset's rendered patch (`evals/anchoring/valid-ranges.js`).
`evals/anchoring` measures the same decision on fresh finder runs, by hand.
