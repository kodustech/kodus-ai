# review-rounds — what reaches the PR across rounds and sandbox failures

> - **Answers:** When the sandbox dies mid-review, or a round follows earlier Kody suggestions on the same PR, does what reaches the PR match what a correct review delivers — nothing unread, revisions linked, nothing already sent posted again?
> - **Runs:** every engine PR on the scripted model (`evals/wiring-smoke.js`, one case); on demand with a real model.
> - **Run it:** `node evals/review-rounds/run.js --model=deepseek-v4-flash --reps=3` · `node evals/review-rounds/run.js --model=eval-fake --case=R2,K1`
> - **Gate:** none yet (report-only). Floors per problem are set in the PR that fixes it, from two runs of the same commit.
> - **Cost:** one review per selected case in `cases.js` and rep, plus one judge call per delivered finding and claim.

Issues #2040 (findings shipped on code nobody read), #2039 (a finding caused by
applying Kody's own earlier suggestion, posted without saying so) and #2020 (the
next round is shown a stale status for that suggestion), and a production report
(2026-10-01) of Kody Rule findings reposted every round, reworded, after the
developer declined or fixed them.

## What it drives

The chain the worker runs once the sandbox is up: `runAgentLoopViaCore` (finder,
verifier, evidence gate) — or, for `agent: 'kody-rules'` cases, the production
`KodyRulesAgentProvider` — → `classifySeverity` → `formatSuggestionContent` → the revision link
(`engine/revision-link.ts`). Tools
go through the production registry. Only `RemoteCommands` — the sandbox — is
replaced. Modes, each a shape seen in production:

- `alive` answers from the case's repository;
- `dead` throws what the E2B SDK throws once the sandbox is gone
  (`SandboxNotFoundError: Sandbox is probably not running anymore`);
- `dies-in-verify` is alive for the finder and dead from the first verifier run,
  which the runner detects by wrapping the real `LlmVerifier.verify`;
- `dies-after-reading:<path>` dies right after `<path>` is read (the premise was
  read before the death);
- `dead-for:<path>` fails every read of `<path>` and hides it from grep, the
  rest works (the premise is the one thing that could not be read);
- `flaky:<K>` fails the first K calls, then answers (the sandbox comes back);
- `none` runs with no sandbox at all, through the self-contained prompts the
  stage uses when no sandbox exists.

Each delivered finding is matched to the case's claims by the recall judge
(`evals/investigation/recall-judge.js`). `JUDGE_MODEL` defaults here to the
nightly's judge, `gpt-5.6-luna` at `low` effort.

## The cases

`cases.js` holds synthetic reproductions of the reports and control cases.
These runs do not reproduce the private customer PR or verify production traces.
The code is invented, except the #2011 replay,
which vendors this repository's own public history in `fixtures/kodus-2011/`.

| Case | Shape | Claim → expected |
|---|---|---|
| U1 | sandbox dead; tempting finding whose premise is in a file outside the diff | false claim → `not_deliver_normal`; diff-only true bug → `deliver` |
| U2 | same, sandbox alive (control) | false claim → `not_deliver`; true bug → `deliver` |
| U3 | true bug visible only in a caller; sandbox dies when verify starts | `deliver` (the finder read the premise) |
| U4 | same, sandbox dead from the start | `not_deliver_normal` |
| R1 | earlier suggestion still open, round B only adds a metric next to it | repeat → `not_deliver` |
| R2 | round B applies the earlier suggestion; that creates a bug in a caller; status shown `implemented` | `deliver_linked` |
| R3 | same, status shown `not_implemented` (stale) | `deliver_linked` |
| R4a/b | PR #2011 round B (this repo), status `implemented` / stale | contested claim → `if_delivered_linked` |
| R5 | an applied earlier suggestion and a new, unrelated bug on the same lines | `deliver` (no link needed) |
| U5 | premise read, then the sandbox dies | false claim → `not_deliver` |
| U6 | only the premise file is unreachable | false claim → `not_deliver_normal` |
| U7 | sandbox fails 3 calls, then recovers | false claim → `not_deliver` |
| U8 | no sandbox by design (self-contained) | false claim → `observe` (behaviour not decided) |
| U9 | the imported module does not exist: the tool error IS the evidence | `deliver` |
| R3p | same as R3, status `pending` (the implementation check had not run yet, #2020) | `deliver_linked` |
| R6 | earlier suggestion applied to one of the two places it named | repeat → `not_deliver` (already sent; never posted again) |
| R7 | earlier suggestion applied ineffectively (timeout never aborts) | repeat → `not_deliver` (already sent; never posted again) |
| R8 | #2039 exactly: the earlier suggestion came from a Kody Rule | `deliver_linked` |
| R9 | the developer explicitly rejected the earlier suggestion (stored `not_implemented`) | repeat → `not_deliver` |
| R10, R11 | reversals replayed from this repository's own PRs | `if_delivered_linked` |
| K1 | Kody Rules: a violation already posted, plus a new one in another function | repeat → `not_deliver`; new → `deliver` |
| K2 | Kody Rules: the rule judge flags code Kody's own earlier suggestion produced | `if_delivered_linked` |

The U cases belong to #2040, which this branch does not fix: they stay red on
purpose until that issue's design is decided.

`deliver_linked`: the finding reaches the PR and tells the reader which earlier
Kody suggestion it revises. `if_delivered_linked`: it may be absent, but if it
ships it must be linked. `observe`: recorded, never scored. `not_deliver_normal`: it does not reach the PR as a
regular finding — absent, or carried as unverified. Expectations flagged
`proposed` in `cases.js` encode decisions the design comments have not taken
yet; change them there, with the decision linked.

## Reading the output

One rate per problem, over every rep × claim with that expectation:

- `unverified-shipped (#2040)` — `not_deliver_normal` violated;
- `repeat-of-sent` — a problem an earlier suggestion already raised, posted
  again (open, declined, or "fixed" in a way the reviewer finds incomplete);
- `revision-unlinked (#2039/#2020)` — a revision that reached the PR without
  naming the earlier suggestion (over delivered revisions only; a true one that
  never reached the PR counts under `true-bug-missed`);
- `refuted-shipped` — control: a claim the readable code refutes was delivered;
- `true-bug-missed` — guard: a fix must not buy the rates above by suppressing
  real bugs. On the unfixed engine this is plain finder recall.

`results/` keeps the runs referenced from PRs; the baseline on the unfixed
engine is `results/baseline-main-*.json`.

## Known limits

- A scored revision needs both a valid `revisesSuggestionId` and the rendered
  reference. The reference identifies the earlier file/line/time; it is not a
  URL to the original comment.
- Conditional absence in R4 is not evidence that a delivered revision would
  be linked. U8's false claim is observational, never scored.
- These synthetic cases do not measure fleet incidence or validate a private
  customer PR. Small runs do not establish a calibrated quality floor.
- The history shown to the review is the `MAX_PR_DECISIONS` most recent
  suggestions sent on the PR, across all files, each clipped to 600
  characters. A suggestion older than that window can be raised again.
- When the history cannot be loaded the review runs without it (fail open,
  as before), so that round can repeat an earlier suggestion.
- `--rescore=<run.json>` re-applies the current expectations to a saved run
  without a model; use it when a design decision flips a `proposed` one.

## Stateful lifecycle acceptance

`lifecycle.js` chains reviews over consecutive snapshots: only the comments a
round actually delivers become the next round's history, with stale statuses
on purpose. Three sequences — a suggestion the developer declined, followed by
four reviews (and a new, unrelated bug the last one must still find); a fix,
followed by three reviews; and a fix that does not work, followed by three
reviews — none may post the first comment's problem again. A first round that
delivers nothing is a failure, not a vacuous pass.

`node evals/review-rounds/lifecycle.js --model=deepseek-v4-flash --reps=3`. Exit 1
for an acceptance violation, 2 for infra. `--wiring-smoke` skips the quality
assertions on `eval-fake` only: it proves the wiring, never model quality.
