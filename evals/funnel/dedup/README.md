# funnel/dedup

> - **Answers:** Of the known bugs the finder's findings reach dedup with, how many does it keep?
> - **Runs:** nightly when dedup or the snapshot changes (`evals/nightly-evals.js`), ungated until the relabeled dataset lands; Friday on every tier-0 model.
> - **Run it:** `node evals/funnel/dedup/run.js --model=<id>`
> - **Gate:** none yet (`targets.json`): the value is reported as ungated.
> - **Cost:** one dedup call per PR that has a known bug among its findings.

Runs the production dedup, `AgentReviewStage.deduplicateSuggestions`
(`agent-review.stage.ts`), on the frozen findings that survived verify
(`evals/funnel/snapshot`). A known bug is lost when every finding that matches
it is merged away. A dedup that fails keeps every finding, in production and
here; only a provider refusal leaves a PR unmeasured. `evals/dedup` keeps its
labelled pairs for the merge decisions themselves.
