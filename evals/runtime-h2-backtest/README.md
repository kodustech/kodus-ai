# runtime-h2-backtest

> - **Answers:** Does Kody Runtime’s first Run on a pull request that later needed a revert or a hotfix publish that bug, where two Kody reviews of the same pull request did not point at it, without false regressions on safe controls?
> - **Runs:** on demand, once per decision (H2 is a one-time call, not a nightly). Over Runs the product made with `@kody runtime` on pull requests replayed on kr-* copies, after two `@kody start-review` each.
> - **Run it:** export the Runs with `evals/runtime-planner-quality/export.js` (its README), then `node evals/runtime-h2-backtest/run.js --traces=traces.json` · `--cases=<file>` · `--json` · `--output=<result.json>`. Tests: `node --test evals/runtime-h2-backtest/score.test.js`.
> - **Gate:** the H2 rule, not a floor: pass when at least 6 of 20 reproduced cases are found, at least 2 of those are review-blind, and at most 2 of the 10 controls carry a confirmed false regression. Exit 0 pass, 1 fail, 2 not measured (fewer than 20 measured cases, the control guard broken, unusable input).
> - **Cost:** no model call here: the Runs and the reviews already ran in the product. The result records zeros.

## What it scores

- **Found:** the first Run of the replayed pull request (what a user sees) publishes a regression finding (verdict `finding`, not `new_endpoint_error`, not judged `intended`) whose entry point, or the request its probe made, matches an oracle target through production's `requestMatchesEntryPoint` (`libs/runtime/entry-points/coverage.ts`), and whose difference agrees with the oracle's symptom: the status classes on base and the PR, a named field among the differing ones, or for DOM and visual symptoms both labelers' settled label. A finding on target with another symptom counts only when both labelers call it the same defect (`adjacent`).
- **Review-blind:** two Kody reviews of the same pull request were labeled, and the settled label of neither points at the bug.
- **Not measured, never a miss:** a case whose oracle did not reproduce, or with no Run.
- **Controls:** each regression finding on a safe change is labeled; more than 2 controls with a confirmed false regression make the result not interpretable.
- **Agreement:** Cohen's κ of the two labelers on the review labels and on the finding labels. Below 0.6 the rule text is rewritten and every case relabeled.

## cases.json

One entry per case or control, upstream PR numbers only (public data, no customer data):

```json
{
  "id": "calcom-21987",
  "kind": "case",
  "upstream": { "repo": "calcom/cal.diy", "pr": 21987, "fix": 22004 },
  "kr": "kr-calcom",
  "krPr": 12,
  "oracle": { "targets": ["POST /api/bookings/:id/cancel"], "symptom": { "dimension": "status", "good": "2xx", "buggy": "5xx" } },
  "oracleSha256": "<hash of the frozen oracle.json>",
  "reproduced": true,
  "reviews": [{ "a": false, "b": false }, { "a": false, "b": false }],
  "findingLabels": { "<probeId>": { "adjacent": { "a": true, "b": true }, "symptom": { "a": true, "b": true }, "falseRegression": { "a": false, "b": false } } }
}
```

A label is `{a, b}` from the two labelers; a disagreement carries the written settlement as `final`. Rule 7 is `score.test.js`: a found case and the same case broken one way per check (another route, the reverse status, an intended finding, a later Run, one review only, a missing reproduction) each turn red.
