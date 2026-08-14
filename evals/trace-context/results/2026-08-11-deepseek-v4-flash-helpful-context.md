# Trace context helpful case — DeepSeek V4 Flash on Fireworks

Date: 2026-08-11

Model: `accounts/fireworks/models/deepseek-v4-flash`

Endpoint: `https://api.fireworks.ai/inference/v1`

Dataset: `evals/investigation/datasets/trace-context-helpful.json`

Command:

```bash
pnpm eval:investigation:no-cache \
  --dataset trace-context-helpful.json \
  --preset deepseek-v4-flash-fireworks
```

The prompt and agent implementation were not tuned after seeing the result.
Three uncached replications completed with 12/12 passing assertions and no
provider errors.

## Question

Can Trace help Kody find a defect that cannot be established from the diff or
repository alone?

The historical decision says webhook deduplication records must remain valid
for at least 18 hours because providers may retry a delivery ID during that
window. The pull request does not contain that provider constraint.

- Violation: reduce retention from 24 hours to 12 hours.
- Control: reduce retention from 24 hours to 20 hours.
- Baseline: no recorded decision.
- Trace: the same pinned human decision is supplied through the production
  `generalist` agent input.

## Results

| Case | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| 12h violation, baseline | 0 findings | 0 findings | 0 findings |
| 12h violation, Trace | 2 findings | 2 findings | 2 findings |
| 20h control, baseline | 0 findings | 0 findings | 0 findings |
| 20h control, Trace | 0 findings | 0 findings | 0 findings |

In all three Trace runs, Kody identified the exact mismatch: 43,200 seconds is
12 hours and therefore six hours shorter than the recorded 18-hour minimum.
It connected expiration of the Redis deduplication key to repeated externally
visible side effects. Without Trace, the agent considered the generic retry
risk in its private reasoning but correctly declined to make an unsupported
claim about the required retention window.

The 20-hour control remained silent with and without Trace. This matters: the
model used the constraint to evaluate the change instead of turning the
decision itself into a finding.

## Run totals

| Run | Passed | Failed | Errors | Tokens | Duration |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 4 | 0 | 0 | 386,727 | 72,693 ms |
| 2 | 4 | 0 | 0 | 385,157 | 71,398 ms |
| 3 | 4 | 0 | 0 | 385,369 | 75,055 ms |

Across the three runs, baseline cases used 531,410 tokens and Trace cases used
625,843 tokens. Trace cost 94,433 additional tokens, about 17.8% in this small
agentic dataset.

## Defect exposed by the eval

Every successful Trace run emitted the same finding twice with slightly
different wording and severity. The eval proves useful recall, but it also
shows that the review funnel's semantic deduplication is not reliably merging
equivalent findings. This should be fixed before treating this dataset as a
release gate; the expected result is one actionable finding, not two comments.

## Conclusion

This is a positive synthetic example of incremental review value: Trace added
the missing operational fact, Kody found the resulting defect consistently,
and the negative control did not produce noise. It is not enough to justify a
broad rollout. The next gate should replay real pull requests with decisions
captured before the pull request and labels written independently of the eval.

Raw outputs for this run are currently at:

```text
/tmp/trace-context-helpful-deepseek-v4-flash-r1.json
/tmp/trace-context-helpful-deepseek-v4-flash-r2.json
/tmp/trace-context-helpful-deepseek-v4-flash-r3.json
```
