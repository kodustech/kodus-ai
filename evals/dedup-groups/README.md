# dedup-groups

> - **Answers:** Does the dedup join the suggestions that report the same problem, and only those?
> - **Runs:** on demand and in experiments (`evals/experiment.js --step=dedup`).
> - **Run it:** `node evals/dedup-groups/run.js --model=deepseek-v4-flash@fireworks`
> - **Gate:** none yet; the floors in `targets.json` come from two runs once the step's version settles.
> - **Cost:** one dedup call per PR (plus a follow-up, embeddings and tiebreaks), 30 PRs per pool.

Drives production's `AgentReviewStage.dedupSuggestionStreams` on the suggestions one
finder pool wrote on 30 PRs, with the PR's context rebuilt by production's code
(`evals/shared/review-stage.js`) and the org's model routed as production routes it.

The cases are the duplicate gold v2 of #1821 (`cases/<pool>.json`, built by
`build-cases.js` from Junior's labels): every suggestion of a PR is in exactly one
group, and a group is one problem. Two blind judges labelled them and people decided
where they disagreed.

What is scored, per PR:

- **duplicate pairs joined:** of the pairs the gold puts in one group, how many the
  dedup merged (the metric);
- **false merges:** pairs the dedup merged that the gold keeps apart, reported beside it;
- **comments kept:** what reaches the next step, against the gold's group count.

The inputs come from the lean finder of #1821 (one problem per suggestion, no
severity, no summary, no code). On a finder that writes other fields, the numbers do
not carry over: measure with the snapshot of that finder (`evals/funnel/dedup`).

The run records whether the platform embedder answered (`environment.embedder`): the
dedup's semantic tier needs it, and without it the guard vetoes more merges (#2170).

Deliberate break, 2026-10-17 (local, DeepSeek, the first 6 PRs of the controlled set): the
dedup returning every suggestion unmerged (`deduplicateSuggestions`) joins 0 of the 92 gold
pairs, against 80 of 92 on main, and reports the embedder as not called.
