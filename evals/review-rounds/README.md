# review-rounds — what reaches the PR across rounds and sandbox failures

> - **Answers:** When the sandbox dies mid-review, or a round follows earlier Kody suggestions on the same PR, does what reaches the PR match what a correct review delivers — nothing unread, revisions linked, nothing already sent posted again?
> - **Runs:** every engine PR on the scripted model (`evals/wiring-smoke.js`, one case); nightly on DeepSeek, `sets.nightly` of `targets.json` (`evals/nightly-evals.js`) and weekly on every tier-0 model against its floor (`evals/weekly.js`); the full set on demand.
> - **Run it:** `node evals/review-rounds/run.js --model=deepseek-v4-flash@fireworks --byok-reasoning=none --reps=5` · `node evals/review-rounds/run.js --model=eval-fake --case=R2,K1`
> - **Gate:** `--gate` with `--set=nightly`: the share of claims handled right against the model's floor in `targets.json`, which holds only for its set, judge and `--byok-reasoning`.
> - **Cost:** one review per selected case in `cases.js` and rep, plus one judge call per delivered finding and claim.

Issues #2040 (findings shipped on code nobody read), #2039 (a finding caused by
applying Kody's own earlier suggestion, posted without saying so) and #2020 (the
next round is shown a stale status for that suggestion), and a production report
(2026-10-01) of Kody Rule findings reposted every round, reworded, after the
developer declined or fixed them.

## What it drives

Each round is one pull request through production's review
(`evals/shared/review-stage.js` `reviewPullRequest`): the team's config
(`CodeBaseConfigService.getConfig`), the routed model, `FetchChangedFilesStage`,
`LoadExternalContextStage`, the sandbox (`LocalSandboxService`) and
`AgentReviewStage`, which runs the orchestrator's agents (the generalist, and
the Kody Rules agent when the team has rules) and then the anchoring, the
repeat check against the whole history, dedup, severity, the formatter and the
revision links. What is scored is what the stage ships (`validSuggestions`,
`validSuggestionsByPR`); what the repeat check kept off the PR is each row's
`alreadyPosted`.

A case supplies data only. `pr-of-case.js` turns it into what production reads:
a repository with the base before the PR and the head after it (the agents
read the diff production renders from the platform's patches), the team's Kody
Rules as stored, the PR's commits (`commits` in a case), and the decision store
holding the earlier suggestions in the record shape production writes
(`PrDecisionStoreService` `toRecord`). Sandbox faults wrap the production
sandbox's remote commands; `alive` only counts the calls. Modes, each a shape
seen in production:

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
| R12 | an applied suggestion in the history, and a new unrelated bug in another file | `deliver` (guard) |
| R13 | the open suggestion's code moved to another file unchanged | repeat → `not_deliver` |
| R14 | the earlier comment was a declined Kody Rule; the bug finder sees the same problem | repeat → `not_deliver` |
| K4 | the bug finder raised it earlier and it was declined; the developer touched that code without fixing it; the rule judge sees the same problem, plus a new site | repeat → `not_deliver`; new → `deliver` |
| K5 | a rule comment stored `implemented` while the violation is still on a line the developer touched, plus a new site | repeat → `not_deliver`; new → `deliver` |
| K6 | K5 with the comment stored `not_implemented` | same |
| K7 | K5 with a production round's volume: 44 rules, 10 earlier comments, 7 commits | same |
| K9 | K5 at the volume of the production DeepSeek reposts: 80 rules, each with the repository convention its `sourcePath` points at (~500K characters), 15 earlier comments | same |
| K10 | K5 on a file new in the PR, so every round shows the whole file as added | same |
| K12 | the developer answered with a fix that does not fix it (still UTC) and a comment claiming it does | same |
| R15 | an earlier bug stored `implemented` because its line changed; the bug is still there | repeat → `not_deliver` |
| R16 | an earlier fix undone by this diff | `not_deliver` (one problem, one thread: #2097; a fix that came back looks like one never complete) |
| R17 | R15 with 10 earlier comments and 7 commits, most answering review | repeat → `not_deliver` |

K5–K12 and R15–R17 reproduce repost shapes from a production sample (500
later-round comments, 2026-10-05→12, #2114) with invented code; the volumes are
that sample's medians (`fixtures/prod-profile.js`,
`fixtures/rule-conventions.js`). Each has a `-control` twin without the
earlier comment (K6 shares K5's: same files, and a twin has no earlier comment
whose status could differ): the problem must ship there, or the twin's absence
means only that the agent never saw it. A repeat case counts only next to its
control.

### Production shapes (`prod-shapes/`)

`prod-shapes/cases/` holds one case per repost found in that sample (42 of
them; the two concurrent reviews and the one review whose history failed to
load are out: one review per case cannot reproduce them), plus guards. A spec
gives the files before and at the reviewed head, the comment already on the PR
and the claims; `prod-shapes/build.js` derives each file's patch as the platform
returns it,
a history of the production size (`'out-of-40'` puts the comment behind 45
newer ones, which `capDecisions` drops), the rule set and commits, and the
`-control` twin. `prod-shapes/check.js` (and `prod-shapes.spec.ts` in CI) refuse
a spec whose claims fall outside the file or, for the rule judge, on lines the
diff does not add. Ids are `P01`–`P42`; the guards (`P33`–`P42`) must be posted:
the same rule at a new place, a bug the earlier fix caused. P38, a fixed bug
that came back, is the exception: not posted again (#2097).

### Reasoning effort

Production reviews run through the customer's BYOK model with the reasoning
effort the customer configured; the eval's default route is the env/managed
model at the family's default effort. `--byok-reasoning=<none|low|medium|high>`
routes both agents through a BYOK slot with that effort, as production does.
Repeat measurements use `--byok-reasoning=none`, the configuration under which
the production reposts reproduce; a higher effort hides them.

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
engine is `results/baseline-main-*.json`, and the production repost shapes'
baseline is `results/2026-10-13/`.

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
- Two reviews of the same PR running at once each load the history at their
  start, so the second cannot see what the first posts. A single review per
  case cannot reproduce that.
- When the history cannot be loaded the review runs without it (fail open,
  as before), so that round can repeat an earlier suggestion.
- On DeepSeek with reasoning off, the bug-finder repost shapes (P23–P32) do
  not repost; in production those reposts came mostly from other models. They
  need a tier-0 run on those models before they say anything about them.
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

The `rules-rejected-four-rounds` and `rules-fixed-three-rounds` sequences drive
the production Kody Rules provider through the same lifecycle. They reproduce
the shape of a customer report using invented code, not a replay of the
customer's PR: four nearby commits after rejection, or a repair followed by
three commits while the stored status remains pending. Each sequence ends with
a new violation of the same rule in another function, which must be delivered.
Only actual delivered comments enter the next round's history; an empty first
review fails. Select either with `--sequence=<id>`.

## Private snapshot replays

`run.js --cases-file=/absolute/path/cases.json` reads an external JSON object
with a `cases` array in the same shape as `cases.js`. This allows a local replay
of exported customer snapshots and persisted suggestions without committing
their source code. Record the export's origin and missing context alongside the
result: a final snapshot with earlier comments does not reconstruct the code
at each historical commit. The sandbox can only read the exported files.
Partial Kody Rules shard failures and unavailable declared rule context are
unmeasured (infra), even when the provider returns no findings.
