Fixes #2319.

## Summary

After a rebase or a force-push the review compares the PR diff with the one at the last reviewed commit. A push that removes a line the PR had added left nothing to compare: the line exists only in the previous diff, so the file came out unchanged, or absent when every change was reverted, and the run skipped with "No changed files in this pull request".

`rebaseInterdiff` now names those files in `revertedFiles`, and the stage reviews the whole current PR instead of skipping the push.

## Eval evidence

- Run: Not applicable: no prompt, model, heuristic or retrieval path is touched. The change is a diff comparison and a pipeline branch.
- Proof (feat/perf only): not a feat or perf change.
- Design: the issue carries no design comment. The fix follows its cause section and the suggestion left in the review of #2317: review the whole PR when the interdiff cannot represent the removed changes.

## Test plan

- `rebase-interdiff.spec.ts`: the guard removed while another reviewed line stays, a file whose changes are gone from the PR diff, a removed base line that comes back, and a change that only moved (which must not be reported).
- `validate-new-commits.stage.spec.ts`: an interdiff naming a reverted file reviews the whole PR, with `forceFullRerun` and `interdiff_cannot_represent_removals`, instead of skipping.
- Red without the change: the reverted cases fail with the detection and the stage branch disabled (3 tests).
- `API_NODE_ENV=test pnpm exec jest libs/code-review/pipeline libs/code-review/infrastructure/adapters/services`: 67 suites, 894 tests pass. `pnpm run typecheck:libs-gate` passes, Prettier clean.

## Notes for the reviewer

- Two situations look alike in the diffs: a push that reverts an added line, and a base branch that absorbed it. Rather than print a synthetic deletion that may be false, the interdiff reports the file and the stage falls back to a full review. That is the conservative option the review of #2317 suggested.
- A moved change keeps its line, so it is not reported: only a line that disappeared from the diff counts.
- Cost: only a push that removed a reviewed change pays for a full PR review.
