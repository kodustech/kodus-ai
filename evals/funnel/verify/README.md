# funnel/verify

> - **Answers:** Of the known bugs among the finder's candidates, how many does the verifier keep?
> - **Runs:** nightly on the controlled set when the verifier or the snapshot changes (`evals/nightly-evals.js`); weekly on every tier-0 model's controlled set and DeepSeek's full set (`evals/weekly.js`); its control pair on every PR (`evals/wiring-smoke.js`).
> - **Run it:** `node evals/funnel/verify/run.js --model=<id> [--set=controlled|full]`
> - **Gate:** `--gate` fails below the floor for the model and set in `targets.json` (`sets.<set>.models`); a model with none reports ungated.
> - **Cost:** one verifier run per candidate (a second for those the evidence gate re-checks) of a PR that has a known bug among them.

Runs production's verify step, `verifyFindings` (`finder.agent.ts`), on what
each agent loop's verify got in the snapshot's review (`evals/funnel/snapshot`):
every candidate judged by the verifier, then the evidence gate's full
re-verify of a finding on a file the finder never read (the finder's
investigated files are frozen with the candidates). The review runs as
production runs it up to each agent loop; in place of the loop, verify runs
with that loop's own runner, tools and provider options
(`finderRunEnvironment`, `core-agent-loop.adapter.ts`) over the PR's checkout.
A known bug is lost when every candidate that matches it is dropped. The
control pair: a finding the code confirms stays, one it refutes is dropped.
`evals/verifier-verdict` checks, without a model, that a verdict reaches the
gate.
