# funnel/verify

> - **Answers:** Of the known bugs among the finder's candidates, how many does the verifier keep?
> - **Runs:** nightly when the verifier or the snapshot changes (`evals/nightly-evals.js`), ungated until the relabeled dataset lands; Friday on every tier-0 model.
> - **Run it:** `node evals/funnel/verify/run.js --model=<id>`
> - **Gate:** none yet (`targets.json`): the value is reported as ungated.
> - **Cost:** one verifier run per candidate of a PR that has a known bug among them.

Runs the production verifier again on every candidate the finder sent it
(`evals/funnel/snapshot`): `LlmVerifier` in a `runVerificationPass`, built as
`runAgentLoopViaCore` builds it (`core-agent-loop.adapter.ts`), with the
finder's tool registry over the PR's recorded tools. A known bug is lost when
every candidate that matches it is dropped. The evidence gate, which
re-verifies a kept finding the finder never read, needs the finder's own run
and is not covered. `evals/verifier-verdict` checks, without a model, that a
verdict reaches the gate.
