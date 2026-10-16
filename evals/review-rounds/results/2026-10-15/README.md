# 2026-10-15 — the repeat check (#2097)

Model: `deepseek-v4-flash@fireworks` through a BYOK slot (`--byok-reasoning`).
Judge: `gemini-3-flash-preview`, the same as `results/2026-10-13`, so main's
numbers there compare with these. 5 reps per case unless said otherwise. The
`-control` twins were not re-run: on main they post their problem at least 4
times in 5 (`2026-10-13`).

- `branch-full/`: every case on the branch, reasoning off. Its Kody Rules
  cases measure the final engine. Its bug-finder cases do not: they ran
  before the finder got its never-repeat instruction back, and before the
  eval's finder received the slot's reasoning effort (`run.js`
  `finderModelParams`). `branch-finder/` replaces them.
- `branch-high/`: the cases past the 40 shown (P18–P21) and the ping-pong
  (P22), reasoning high.
- `branch-finder/`, `main-finder/`: the bug-finder cases on the branch and on
  main (`7f04ea6a6` plus this PR's eval changes, so both sides run the same
  harness). Main's P38 and R16 still carry the old `deliver_linked`
  expectation; compare what was posted, not pass.
- `nightly-calibration/`: two runs of `targets.json` `sets.nightly` with the
  nightly's command (`evals/nightly-evals.js`), 2 reps: the floor.

## Posted, out of all chances

| | main | branch |
|---|---|---|
| Kody Rules repost, reasoning off | 133/150 | 15/150 |
| Kody Rules new site or other rule, must post | 145/150 | 147/150 |
| Kody Rules repost, reasoning high, P18–P22 | 25/25 | 0/25 |
| Bug-finder repost, incl. P38 and R16 | 4/100 | 0/100 |
| Bug that must post | 46/50 | 45/50 |
| Revision of an earlier suggestion, must post linked | 13/25 (4 linked) | 13/25 (8 linked) |

Main's Kody Rules rows are `2026-10-13/byok-none` and `byok-high`. With the
finder's reasoning really off, main posts about half the revisions too; a run
of main on the old harness (not kept), where the eval's finder ran on the
model's default reasoning, posted 25 of 25.

The nightly set: 33 and 32 of 36 claims handled right (91.7%, 88.9%); the
misses are the revisions R2 and R8 and one new-site claim of P18.

## The other tier-0 models

`tier0-main/` and `tier0-branch/`: `sets.nightly`, 2 reps, reasoning off,
same judge. Sonnet 5.5 on the Anthropic API; GPT-6 and Kimi through
OpenRouter pinned to their first-party upstream (`*@openrouter` in
`evals/shared/tier0-models.js`). Main is `7f04ea6a6` with this PR's eval
changes.

| Posted | GPT-6 main | GPT-6 branch | Sonnet 5.5 main | Sonnet 5.5 branch | Kimi main | Kimi branch |
|---|---|---|---|---|---|---|
| Kody Rules repost | 2/14 | 0/14 | 3/12 | 0/13 | 8/14 | 0/14 |
| Bug-finder repost | 0/4 | 0/4 | 0/4 | 0/4 | 0/4 | 0/4 |
| Must post | 14/14 | 14/14 | 12/12 | 13/13 | 14/14 | 14/14 |
| Revision, posted linked | 4/4 | 4/4 | 4/4 | 3/4 | 3/4 | 0/4 (1 posted) |

Kimi's revisions on the branch were missing because its finder did not
report them, not because the repeat check dropped them (`alreadyPosted` is
empty). Re-run with 4 reps of R2, R3, R3p and R8 (`*-revisions/`): main
posted 12 of 16 (9 linked), the branch 14 of 16 (13 linked), none dropped.
Sonnet left 2 runs on main and 1 on the branch unmeasured
(`KODY_RULES_PARTIAL`).
