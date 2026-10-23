# suggestion-enrichment

> - **Answers:** Does the enrichment write a fix that the judge passes, no code where none fits, and a title that names the problem?
> - **Runs:** on demand and in experiments (`evals/experiment.js --step=enrichment`); two of its findings on the scripted model on every PR (`evals/wiring-smoke.js`).
> - **Run it:** `node evals/suggestion-enrichment/run.js --model=<id> [--judge=<id>] [--gate]`
> - **Gate:** `--gate` fails when the fix, no-code or title share is below that model's floor in `targets.json` (`sets.controlled.models`); a model with none, or a judge other than the one the floors hold under, reports ungated.
> - **Cost:** one enrichment call and one judge call per finding, 150 of each.

Drives production's `AgentReviewStage.enrichFinderSuggestions` (`agent-review.stage.ts`,
`enrich-suggestions.ts`) on each finding as the review hands it over after the severity
step: the five lean fields, with its file at the PR head and the file's diff as
FetchChangedFilesStage leaves them, and the org's model routed as production routes it
(`evals/shared/review-stage.js`). It scores what ships: the title the stage resolves
(`fullSuggestionTitle`) and the fix the publication gate keeps (`checkFix`).

The cases are the enrichment dataset of #1821 (`evals/enrichment/dataset/items.json`):
150 confirmed findings from the gold v3 reviews, each with Astra's reference (the defect,
what a fix must do, whether one fits the cited lines). 100 have a correct fix inside the
cited lines and the input shows enough to write it: they must get one. 50 do not (30 need
a wider change, 18 lack context, 2 have no code fix): they must get no code. The files at
each PR head ship in `dataset/head-files.json` (`build-head-files.js`), since CI has no
checkouts; the step's input built from them equals, on all 150 findings, the input the
research runs measured.

Three metrics, each over the cases it covers:
- **fix:** of the 100 fixable findings, the share whose shipped fix the judge passes.
- **noCode:** of the 50 others, the share shipped with no code.
- **title:** of all 150, the share whose title names the problem (judge) and has the format
  the prompt asks for: one line, 80 characters or fewer, no trailing period.

The judge (`judge.js`, shared with the research grader in `evals/enrichment`) is Opus 5.5
with the references; the floors hold under it only.

Deliberate break: a step that writes no fix and no title ships every finding with no code
and its first sentence as the title. noCode goes to 100%, fix to 0%, below every floor.
