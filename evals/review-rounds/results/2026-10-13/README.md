# 2026-10-13 — repost shapes from production (#2114, #2097)

Engine: main `3a8f276de` plus this branch's eval changes (no `libs/` change).
Model: `deepseek-v4-flash@fireworks` (DeepSeek v4.1 flash). Judge:
`gemini-3-flash-preview`, because the OpenAI judge key answered 401 and the
Anthropic account had no credit. These numbers are not comparable with runs
under the `gpt-5.6-luna` judge. 5 reps per case, each next to its `-control`
twin.

- `byok-none/`: both agents run through a BYOK slot with reasoning off
  (`--byok-reasoning=none`). Each file is one group of cases. In `p01.json` and
  `p13.json`, P01 and P13 were dropped and re-run after their specs were fixed:
  see `fix-p01.json` and `fix-p13.json`.
- `byok-high/`: the rule cases through the same slot with reasoning `high`.

## What reaches the PR on main, reasoning off

Every case below is valid: its control, which has no earlier comment, posted
the problem at least 4 times in 5.

- **Kody Rules reposts, 22 production shapes (P01–P22):** all 22 are red. The
  rule judge posts again what is already on the PR, 2–5 times in 5. The
  shapes: a comment stored implemented while the violation is still there, a
  comment not applied, an attempted fix, code that moved, a site the earlier
  comment listed under "Also found in", a comment beyond the 40-entry history
  (P18–P21, cut by `capDecisions`), and a ping-pong between two comments.
  Many reposts carry "Revises an earlier Kody suggestion". The date-rule cases
  K4–K7, K9, K10 and K12 are red as well.
- **Bug-finder reposts, 10 production shapes (P23–P32):** none posted again,
  0 in 5 each. In the production sample, 1 of the 14 bug-finder reposts came
  from DeepSeek; the rest came from GPT-6, Kimi, Gemini, GLM and MiniMax
  routes. Those tier-0 models were not run here because no key was available.
- **Guards that must be posted (P33–P42):** 3 are red. The same problem at a
  new place (P36) is posted 0 times in 5, the fixed bug that came back (P38)
  0 in 5, and a different rule on lines an earlier comment covered (P40) 3 in
  5. Their controls post them 5 in 5, so the history is what silences them.
  R16 (fixed, then reintroduced) is red the same way.

## Reasoning high

These are the same rule cases through the same slot with reasoning `high`, in
`byok-high/`. Every control posted its problem 5 times in 5.

- **The earlier comment is in the history (P01–P17):** no repost on any case
  measured, 0 in 5. P11 had 2 measured runs, both with no repost.
  - P15 was not measured. With its 40-entry history the rule judge timed out on
    all 5 runs (`KODY_RULES_PARTIAL`), while the control, which has no
    history, answered on all 5.
  - The date-rule cases K1, K4–K7, K10 and K12 also posted nothing again.
- **The earlier comment is beyond the 40 most recent (P18–P21):** the repost
  still happens 5 times in 5, because the comment never reaches the prompt.
- **Ping-pong between two earlier comments (P22):** the repost still happens 5
  times in 5.
- **Rule guards (P33, P34, P40, P42):** all posted 5 times in 5. P40 was
  posted 3 times in 5 with reasoning off.

Unmeasured runs are kept in the files, as `error` rows. `p13.json` dropped
P13, which was re-run after its spec was fixed (`re-p13.json`), and P15 and
P16, which were re-run after shard timeouts (`re-p15.json`, `re-p16.json`).
