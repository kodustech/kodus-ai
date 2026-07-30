# Kody-rules adherence eval

Does the review correctly enforce team Kody Rules? The kody-rules agent is a
separate agent from the bug/security finder, so this eval is its own thing.

It runs the **production engine** — the real `KodyRulesAgentProvider.execute()`,
the same agent loop, the same tools (grep/readFile/listDir), the same
verify-skip / ruleUuid reconciliation / `@@PATH_MISMATCH@@` drop — over **real PR
diffs**, with deterministic tool replay (no sandbox/GitHub at run time), exactly
like the finder-recall eval. Only the tool *outputs* are replayed.

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

- **`github-cases.json`** (committed fixture, primary) — 14 real merged PRs / 43
  violation sites harvested from large TS repos (n8n, medusa, twenty, appsmith,
  typeorm, backstage). Frozen so CI is deterministic. Regenerate/refresh with
  `harvest-github-cases.js` (needs `gh` auth + network — a manual step, not CI).
- **`bench-cases.json`** (gitignored, regenerable) — built by
  `build-bench-cases.js` from the committed `evals/investigation/datasets`
  (benchmark PR diffs + recorded tool replay). Deterministic from versioned data.

## Run

```bash
yarn eval:kody-rules                 # real engine over the 14 frozen GitHub PRs
yarn eval:kody-rules:gate            # same, but exit non-zero if below baseline (CI)
yarn eval:kody-rules:bench           # regenerate + run the benchmark-diff tier
yarn eval:kody-rules:harvest         # refresh github-cases.json from live GitHub
```

Flags: `--model=` (`gpt-5.4` | `gpt-5.4-mini` | DO models), `--runs=`,
`--gate` with `--occ-min=70 --spec-min=95`. Needs the model key in
`~/.kodus-dev/config` (or `.env`). Loads `.ts` via an **esbuild** require-hook,
not ts-node: `agent-loop.ts` has value imports mid-file that ts-node leaves
un-hoisted (`Cannot access 'llm_1' before initialization`).

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
