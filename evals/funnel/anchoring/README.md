# funnel/anchoring

> - **Answers:** Of the known bugs a review's verified findings reach anchoring with, how many survive the path check and the line snap to the diff?
> - **Runs:** its control pair as a test on every PR (`evals/wiring-smoke.js`); the snapshot's PRs by hand. No model decides here (`evals/stages.js`).
> - **Run it:** `node evals/funnel/anchoring/run.js`
> - **Gate:** none yet (`targets.json`): the value is reported as ungated.
> - **Cost:** none: no model call.

Runs anchoring as production runs it on what each agent's verify kept in the
snapshot's review (`evals/funnel/snapshot`): the agent provider's path check
(`mapAgentFindings`, `finding-mapper.ts`), then
`AgentReviewStage.anchorSuggestionsToDiff` (`agent-review.stage.ts`) on the
PR's changed files as `FetchChangedFilesStage` renders them, which drops a
finding whose lines touch no hunk. A known bug is lost when every finding that
matches it is dropped; a drop within two lines of a hunk is printed as a near
miss. The control pair (`evals/funnel/controls.js`): a finding on a changed
line is kept, one on code the PR did not touch is dropped.
