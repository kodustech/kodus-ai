# Kody-rules adherence eval

> - **Answers:** Does the Kody Rules agent flag every place a rule is broken?
> - **Runs:** nightly on one real model when a file it loads changed, gated on its floor and measured again before alerting (`.github/workflows/code-review-evals-nightly.yml`, `evals/kody-rules/nightly-verdict.js`); every engine PR against the scripted model (`evals/wiring-smoke.js`).
> - **Run it:** `pnpm eval:kody-rules` · `pnpm eval:kody-rules:gate`
> - **Gate:** `--gate` uses the per-model floors in `evals/kody-rules/kody-targets.json`.
> - **Cost:** real model calls per rule shard, reported as `TOKENS` and in `--output`'s `tokens`; none under the scripted model.

Does the review correctly enforce team Kody Rules? The kody-rules agent is a
separate agent from the bug/security finder, so this eval is its own thing.

It runs **production's review** on each case, from data: the rule saved through
the save-time compile and loaded for review (`KodyRuleDetectorCompilerService`,
`KodyRulesValidationService.filterKodyRules`), the PR's head cloned by the
self-hosted sandbox (`LocalSandboxService.createSandboxWithRepo`, `exec`
included), the changed files fetched by `FetchChangedFilesStage`, and
`AgentReviewStage` running the Kody Rules agent (the team's generalist
categories off) and every step after it. `production-review.js` is the one file
that wires it, and it supplies only data: the team's stored rules and settings,
what the code host answers about the PR (recorded by `materialize-cases.js`),
and in-memory stores where production writes to a database. What the stage
keeps, with the places it merged into one comment (`kodyRuleOtherLocations`),
is what is scored.

## What it measures (per rule, over N runs)

- **occurrence recall** — when a rule is violated in several places in a diff,
  how many of the real sites get flagged (±2 lines)? This is the headline: a rule
  that catches one of five violations isn't enforcing anything.
- **file-level recall** — did at least one finding land on each violating file?
  (Kept only to show how much it *over*-reports vs occurrence recall.)
- **line precision** — of the flags emitted, how many land on a real violating
  line vs. the wrong line / pre-existing context.
- **specificity** — of clean files, how many got a false flag.

## Ground truth — real occurrences, enumerated

Cases are built from **real diffs**; the rule is ours but the violations are
real. For a mechanically-detectable pattern (e.g. `process.env`, `console.*`,
`throw new Error(`, `: any`) we enumerate every ADDED line that matches — that
set is the ground truth. No judge, no circular labeling.

## Datasets

- **`github-cases.json`** (committed, primary) — 14 real merged PRs / 43
  violation sites harvested from large TS repos (n8n, medusa, twenty, appsmith,
  typeorm, backstage). Each case carries its PR as the code host answers it
  (`pr`: refs, title, body, every changed file with its patch, commits) and the
  rule with the examples a team gives, so production's compile can give a
  mechanical rule a detector. The ground truth is read from those patches
  (`patterns.js`). Refresh with `harvest-github-cases.js`, then
  `materialize-cases.js` (both need `gh` auth + network, a manual step).
- **`polyglot-cases.json`** (committed, a negative control) — a Ruby-only rule over
  12 real Ruby, JavaScript and template PRs. Nothing outside the rule's language
  should be commented on; the metric is specificity (`--dataset=polyglot-cases`).
  Ruby sources are not scored.

## Run

```bash
yarn eval:kody-rules                 # real engine over the 14 frozen GitHub PRs
yarn eval:kody-rules:gate            # same, but exit non-zero if below baseline (CI)
yarn eval:kody-rules:harvest         # refresh github-cases.json from live GitHub
node evals/kody-rules/materialize-cases.js   # record each PR as the code host answers it
node evals/kody-rules/real-agent.js --dataset=polyglot-cases   # the negative control
```

Flags: `--model=<tier-0 id>`, `--runs=`, `--cases=<caseId,...>`, `--limit=`,
`--gate` with `--occ-min=70 --spec-min=95`. Needs the model key in
`~/.kodus-dev/config` (or `.env`) and network to GitHub: every run clones the
PR's head, and the call graph is built by `kodus-graph` (installed by the stage
on first use).

## CI gate

`--gate` fails the run (exit 1) if occurrence-recall < `--occ-min` (default 70%)
or specificity < `--spec-min` (default 95%). Thresholds reflect the validated
gpt-5.4 numbers with margin. Pin a model in CI; the GitHub tier is frozen so the
only variance is model noise (run ≥3 reps).

## Headline result — the enumeration fix

The agent was flagging each violating file once (the first occurrence) and
stopping, because its category prompt never asked it to enumerate. The fix
(`kody-rules-agent.provider.ts`, "report EVERY occurrence") was validated on the
14-PR set, gpt-5.4, 3 runs:

| metric              | WITHOUT fix | WITH fix |
|---------------------|-------------|----------|
| file-level recall   | 86%         | 89%      |
| **occurrence recall** | **37%**   | **82%**  |
| line precision      | 54%         | 72%      |
| specificity         | 100%        | 100%     |

More than doubles occurrence recall across diverse real PRs, no specificity cost.

## Open findings (surfaced by this eval)

- **Line precision ~72%** — on real diffs ~28% of flags land off the real line
  (mis-line, or pre-existing context the PR didn't touch — the file-membership
  filter doesn't check added-ness). Next target: anchor to the exact changed line.
- **Silent drop** — `base-code-review-agent.provider.ts:1270`,
  `if (!s.suggestionContent) return false`, drops a valid finding with no log when
  a non-strict provider omits `suggestionContent` (it filled `oneSentenceSummary`
  instead). Fix: fall back + `warn()`.
