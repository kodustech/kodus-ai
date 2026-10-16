# funnel/dedup

> - **Answers:** Of the known bugs a review's findings reach dedup with, how many does it keep?
> - **Runs:** nightly when dedup or the snapshot changes (`evals/nightly-evals.js`), ungated until the relabeled dataset lands; Friday on every tier-0 model.
> - **Run it:** `node evals/funnel/dedup/run.js --model=<id>`
> - **Gate:** none yet (`targets.json`): the value is reported as ungated.
> - **Cost:** one dedup call per PR that has a known bug among its findings.

Runs `AgentReviewStage.dedupSuggestionStreams` (`agent-review.stage.ts`) on
what reached it in the snapshot's review (`evals/funnel/snapshot`): Kody Rule
findings merged by rule, the others by the dedup model on the routed model
behind its merge guard (the platform's embedder, `API_OPEN_AI_API_KEY`, for the
semantic tier; without it the guard falls back to its lexical veto, as in
production), then the cross-stream pass. A known bug is lost when every finding
that matches it is merged away. A dedup that fails keeps every finding, in
production and here; only a provider refusal leaves a PR unmeasured. The
control pair: two findings of one bug merge into one, two findings of
different bugs both stay. `evals/dedup` keeps its labelled datasets for the
merge decisions themselves.
