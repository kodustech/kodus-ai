# 2026-10-16 — after the repeat check moved before the dedups (#2097)

Re-run on `ef8ace6e8`: the check judges each finding before the per-rule merge
and the bug dedup, and review-rounds merges after the check
(`engine/kody-rules-merge.ts`). Same model, judge and settings as
`2026-10-15`; main's numbers are there.

- `branch-full/`: every case, DeepSeek v4 flash, reasoning off, 5 reps.
- `branch-high/`: P18–P22, reasoning high, 5 reps.
- `tier0-branch/`: `sets.nightly`, 2 reps, GPT-6 and Kimi through OpenRouter,
  Sonnet 5.5 on the Anthropic API.

| Posted | main (`2026-10-15`) | branch `2026-10-15` | branch now |
|---|---|---|---|
| Kody Rules repost, reasoning off | 133/150 | 15/150 | 15/150 |
| Kody Rules must post | 145/150 | 147/150 | 143/150 |
| Kody Rules repost, reasoning high, P18–P22 | 25/25 | 0/25 | 0/25 |
| Bug-finder repost | 4/100 | 0/100 | 4/100 |
| Bug that must post | 46/50 | 45/50 | 45/50 |
| Revision, posted (linked) | 13/25 (4) | 13/25 (8) | 12/25 (6) |
| GPT-6 / Sonnet 5.5 / Kimi rule repost | 2/14, 3/12, 8/14 | 0/14, 0/13, 0/14 | 0/14, 0/14, 1/14 |

The bug path in review-rounds is the same before and after the move (the
check ran on the raw findings already, and the per-rule merge does not touch
bug findings), so 0/100 and 4/100 are two runs of the same thing. Of the 4:
three are the check's model judging a repeat as a different problem (P23,
R17, R7), one is a finding its finder linked to the earlier comment (R7),
which is posted with the revision header by design.
