# Planner and recipe author eval

The quality eval of Kody Runtime's test planner and recipe author: the method, the failure modes it was built from,
the baseline it measured, and what the fixes it led to moved. The runnable eval is
[`evals/runtime-planner-quality`](../../evals/runtime-planner-quality/README.md).

The numbers below are aggregates over one week of Runs on the eval's labelled pull requests (forks of open-source
projects and small demo apps), read from an export of the Runtime database. The cases and their labels are in
`cases.json`; no Run, trace or log is part of this document.

## What the two agents are

- **Planner** (`libs/runtime/planner/test-planner.agent.ts`, ADR-069). One round is an agent on the product's harness
  with `search_code`, `read_file`, `list_files`, `exec_on_base` (ends the round) and `submit_plan`, temperature 0, with
  the step and token limits of `TEST_PLANNER_LIMITS` and a token budget per Run. Its input is the diff, the entry points
  `extractEntryPoints` computed without a model (`libs/runtime/entry-points/extract.ts`), the routes the import graph
  found for unmapped files, and the targets. It writes probes with an `expected` and `assertions` (the status base
  should answer) and a `cannotProve` list; the worker replays the probes on both sides and the gate decides. A diff
  whose files are all unmapped and only move dependency versions or comments is planned with no model call
  (`plan-without-model.ts`). The plan can start while the PR side builds (`agent:plan:early`,
  `apps/runtime/src/worker/run/early-plan.ts`).
- **Entry-point extractor** (`extract.ts`). A Next `app/**/route.ts` or `pages/api`, a Nest decorator, an
  `app|router.<method>('/path'` call, or a node:http `req.method === … && path === …`. Anything else is `unmapped`.
- **Recipe author** (`libs/runtime/api/application/recipe-author/recipe-author.agent.ts`), with the limits of
  `RECIPE_AUTHOR_LIMITS`, lowered to what the setup's LLM budget reserved. It reads the repository and submits a
  `.kodus/workspace.yaml` plus its own Dockerfile and compose; static checks (`authored-recipe-policy.ts`,
  `authored-files-policy.ts`) refuse unsafe or known-bad recipes; the setup then boots it, and a blocker can start a
  `recipe:repair:<n>` call.

## How serious projects evaluate this kind of agent

- **Execution decides, not text.** SWE-bench grades a patch by running the repository's tests
  ([Jimenez et al., 2023](https://arxiv.org/abs/2310.06770)); SWT-bench grades a generated test by whether it fails
  before the fix and passes after it, and adds coverage of the changed lines as the second metric
  ([Mündler et al., NeurIPS 2024](https://arxiv.org/abs/2406.12952)). The Runtime analogue: a probe counts when it
  exercises the changed code (the request reaches it) and when the replay tells the two sides apart; both are read
  from what the cell recorded, not from the plan's prose.
- **Coverage of the operations under test.** REST API testing tools report operation coverage and the status codes
  each operation answered next to faults found (AutoRestTest, [Stennett et al., 2024](https://arxiv.org/abs/2411.07098);
  [tool paper, 2025](https://arxiv.org/abs/2501.08600)). Here: does a probe hit the route the diff reaches, at the path
  the app serves.
- **Reliability is a separate metric from success.** τ-bench reports pass^k, the chance that all k trials of the same
  task succeed, which falls far below pass^1 for the same agent ([Yao et al., ICLR 2025](https://arxiv.org/abs/2406.12045)).
  A Runtime check that flips between "No regressions" and "Partly tested" on the same commit is this failure; the eval
  reruns the same PR and reports the modal-verdict share and the number of distinct plans.
- **Error bars and repeated samples.** Clustered standard errors for related questions, and several samples per
  question averaged before the standard error ([Miller, 2024](https://arxiv.org/abs/2411.00640);
  [Anthropic](https://www.anthropic.com/research/statistical-approach-to-model-evals)). With 1 to 14 Runs per case, the
  baseline is read per case, and no floor is set from one sample.
- **Error analysis first, then code checks, a judge last.** Read traces, name failure modes, count them, and write a
  code check for every rule that is objective; use an LLM judge only for what needs interpretation, and only after
  validating it against labels a person wrote (TPR/TNR on held-out labels)
  ([Husain, "Creating a LLM-as-a-Judge"](https://hamel.dev/blog/posts/llm-judge/);
  [Shankar et al., "Who Validates the Validators?", 2024](https://arxiv.org/abs/2404.12272)). Every check of this eval
  is code; see "Why no judge".

## Failure modes

Open coding over every planned Run of the week (83 Runs with a plan and a verdict, over 28 labelled cases) and every
author call (61, of which 39 reached the model), then grouped. Ranked by what they cost a developer reading the check.

### Planner

| # | Failure mode | Measured | What the developer sees |
| --- | --- | --- | --- |
| P1 | **The same PR gets a different plan, and a different verdict.** On an equivalent change the planner either probes the changed code (no regressions) or lists the file in `cannotProve` (partly tested). | One case, one head, the same diff and entry points: 9 planned Runs, 4 plan shapes, 6 no regressions / 3 partly tested | The check flips between success and neutral on the same commit |
| P2 | **The probe path misses the app's mount prefix.** | 16 of 44 http probes on cases with a known prefix were under it; on one case 2 of 3 Runs probed 14 routes without `/api` and got the web app's page | "Same on main and the PR" on requests that never reached the changed controller |
| P3 | **The predicted base answer is wrong**, so a probe that answers the same on both sides is `pre_existing` and its route stays uncovered. | 20 of 150 predicted statuses | Partly tested on a PR that changed nothing observable |
| P4 | **A diff that changes nothing observable gets one of three treatments**: no model call and `cannotProve`, every route of the file probed, or either (P1). | 6 comment-only cases, three different outcomes | Three answers to the same kind of PR |
| P5 | **The extractor over-maps.** A changed line outside any handler hands the planner every route of the file. | 23 routes the diff does not reach, in 4 of 19 labelled files | Longer Runs for a change one route calls |
| P6 | **The extractor misses routes a file serves.** | 5 of 15 labelled files that serve a route (`router.get(` with the path on the next line, Next `app/page.tsx`, a Remix route table) | The planner must find the route itself |
| P7 | **Planning got slower without using more tokens.** | Model plans: p50 53 s, p90 154 s over the week; p50 90 s, p90 166 s on the latest planner | Minutes on a heavy stack, where the plan cannot overlap the PR's boot |
| P8 | **The probe compares fields that cannot show the change** (`status` and `json` on an HTML page). | One must-act case: the sides differed, "but no compared field shows it": inconclusive | A real page change reported as not tested |
| P9 | **A change the PR makes on purpose is reported as a regression**: a browser probe of a reworded line asserted main's text. | One must-act case: "1 regression" on exactly the reworded line | A failed check on what the PR meant to change |

### Recipe author

| # | Failure mode | Measured (author and repair steps, one week) |
| --- | --- | --- |
| A1 | **The recipe passes the checks, then does not boot.** | 24 of 30 submitted recipes (18 `toolchain/compose_up`, 2 `resources/boot_timeout`, 2 `platform/repo_fetch`, 1 `seed_data/recipe_migrate`, 1 with no boot after it) |
| A2 | **A failed boot rarely leads to a repair.** | 2 repair attempts after 23 failed author boots. Of the other 21: 10 ran before the worker had a repair loop, 3 were a reverse-DNS denial read as the cause (classifier fixed since), 4 needed an outbound host an admin approves and 2 a `boot_timeout` with no boot phases (both by design), 2 were Kodus's platform (not the recipe's failure). Today's code would repair 13 of them |
| A3 | **Out of token budget before a recipe passed the checks.** | 5 of 39 calls |
| A4 | Other `no_recipe` | 4 of 39 calls (the run ended without a recipe, the checks refused every recipe, nothing to boot) |
| — | Not measured: the model route did not answer | 22 of 61 calls (`llm_unavailable`) |

Per call the author read p50 225k input tokens in 192 s (39 calls). Budget is the cause of 5 failures; the boot after
a submitted recipe is the cause of 24.

Open for its owner: the first boot downloads with the token issued when the setup was requested, which lives 1 h
(`libs/runtime/api/application/runtime-setup-requester.service.ts`). A setup queued longer than that fails its first
boot on a platform blocker and gets no repair. The proposal is that the first boot asks for fresh tokens, as each
repair does, when the request is older than the token's life minus the boot's margin; it needs a `boot` attempt in
`SetupRepoTokensRequestSchema` (`libs/runtime/run/setup-repo-tokens.ts`), a contract change.

## The eval

Dataset: 28 labelled cases (31 heads) in `cases.json`, 11 that act and 17 controls, each with the requests that reach
the change (mount prefix included), the verdicts a right plan ends in, and per changed file the routes it serves and
the ones the diff reaches.

Metrics, all code: right Run (headline: accepted verdict and, when the diff reaches a route, a probe that reaches it),
verdict accepted, relevant probe, probe precision, path under the app's prefix, expected status = base's status,
stability (modal-verdict share and plan shapes per case), route mapping recall and over-mapping of production's
extractor, plan seconds and tokens, and for the author booted / submitted / out of budget per call. Definitions:
[the eval's README](../../evals/runtime-planner-quality/README.md#checks).

**Why no judge.** Each failure mode above is decided by a label (does the request reach the change, is the verdict
one a right plan ends in) or by what base answered (the predicted status). A judge would only be needed to score probe
relevance on pull requests nobody labelled; it would be validated against these labels first.

**Why it reads product Runs instead of replaying the planner.** `evals/runtime-test-planner` replays production's
planner on recorded base machines and needs model keys; it compares planner versions on a fixed set. The failures
above are visible only in the product: what base really answered (P2, P3), the same PR run again (P1), the time the
plan really took (P7), the boot after the author's recipe (A1). Both evals score the same planner; a fix should move
both.

## Baseline

`node evals/runtime-planner-quality/run.js --traces=<export>`; the second column adds `--since=<date>` for the Runs on
the latest planner only.

| Measure | One week | Latest planner |
| --- | ---: | ---: |
| Planned Runs scored (no plan or no verdict, apart) | 83 (23) | 25 (3) |
| **Right Runs** (accepted verdict, and a probe on what the diff reaches) | **71/83 (86%)** | **20/25 (80%)** |
| Verdict accepted | 71/83 | 20/25 |
| Relevant probe, cases whose diff reaches a route | 57/62 (92%) | 17/18 (94%) |
| Probe precision | 137/152 (90%) | 24/37 (65%) |
| Path under the app's prefix | 16/44 (36%) | 15/43 (35%) |
| Expected status = base's status | 130/150 (87%) | 57/74 (77%) |
| Route mapping (extractor) | 10/15 (67%) | 7/11 (64%) |
| Routes over-mapped (extractor) | 23 in 4 of 19 files | 23 in 4 of 15 files |
| Plan seconds, model plans: p50 / p90 | 53 / 154 (72 Runs) | 90 / 166 (22 Runs) |
| Plan input tokens: total / p50 per Run | 1.55M / 15.0k | 617k / 30.3k |
| Recipe author: booted / out of budget (calls that reached the model) | 6/39 / 5/39 | 0/4 / 2/4 |

Stability, cases with two or more planned Runs: 14 cases, 7 with a modal verdict under 100%.

The hand-asked cap of 10 Runs per PR per day ends a stability series on one PR at 10; a floor for P1 needs the series
spread over PRs or days.

## The fixes

Each has a test at the lowest layer that fails on the code before it.

1. **One rule for a change with nothing observable** (P1, P4). A parser decides, never the model
   (`libs/runtime/entry-points/no-effect.ts`): the file's base is rebuilt from the head content and the patch, both
   sides are parsed (TypeScript's parser for JS/TS, small lexers for Go and Python; any other language, a file that does
   not parse, a cut diff, a rename or a recipe file is never judged), and a file whose tokens did not change (comments,
   blank lines, layout) or that is documentation changes nothing that runs. Such a file maps to no route (fix 3). A
   diff made only of such files ends before boot in its own state, `nothing_to_test`: a neutral check "Nothing to test
   at runtime" whose comment names the files (`run-orchestrator.ts` `endBeforeBoot`, `render-runtime-comment.ts`). No
   machine, no model call. The planner is told that code a request reaches always gets a probe, also when the change
   looks equivalent, and that `cannotProve` is only for what no request reaches. A Run of the same head, base,
   environment, entry points, targets and planner version (`TEST_PLANNER_VERSION`) takes the accepted plan of an
   earlier Run from its workflow's plan step (`apps/runtime/src/worker/run/plan-reuse.ts`); a refused plan is never
   reused.
2. **A reconnaissance pass before the replay** (P2, P8). Inside the plan step, each http probe goes once to base (a GET
   twice), and status, media type, the first 600 characters of the body (redacted; a canary stops the Run), whether
   two GETs differ and whether `bodyIncludes` is in base's body come back (`apps/runtime/src/worker/agent/plan-recon.ts`).
   A 404/405 on a route the PR does not add, an HTML page, a non-JSON body that varies, or a `bodyIncludes` base does
   not show gets one planner round with no exploration left to fix paths and compares; the status each probe was
   first predicted to answer is put back on the revised plan, so no expectation is ever taken from base. No new DBOS
   step: the requests are cell steps inside `agent:plan` / `agent:plan:early`.
3. **The extractor maps only what the diff's code lines reach** (P5, P6). A comment or blank line reaches no route; a
   code line outside every handler reaches the handlers that use what its top-level statement declares, through other
   helpers of the file (`libs/runtime/entry-points/helper-reach.ts`); a name used at load (a middleware, `app.use`)
   reaches every route, and an exported one adds the file as unmapped. `router.get(` with the path on the next line is
   a route; a Next App Router `page.*` is `GET` of its folder (route groups and `@slot`s out of the URL, private
   `_folders` and intercepting routes not routes, per the
   [Next.js project structure docs](https://nextjs.org/docs/app/getting-started/project-structure)); a Remix 3 route map
   (per the [fetch-router README](https://github.com/remix-run/remix/blob/main/packages/fetch-router/README.md)) and a
   React Router v7 `routes.ts` are route tables (`route-table.ts`).

The eval changed with them: route mapping reads `routesServedBy` (what a file serves, whatever its diff touched); a
`nothing_to_test` Run is scored with no plan and no model call; the comment cases accept `nothing_to_test`; one case
was added (`immich-2-ping-equivalent`, an equivalent change, for fix 2).

### After

The Runs made on the fixed planner, all through the product (`@kody runtime`). Runs that measured a cell fault rather
than the planner are in `excludeRuns`, keyed by case and reason. The extractor rows of both columns run on the same
recorded diffs.

| Measure | Before (25 Runs) | After (10 Runs scored) |
| --- | ---: | ---: |
| **Right Runs** | **20/25 (80%)** | **10/10 (100%)** |
| Relevant probe | 17/18 | 5/5 |
| Probe precision | 24/37 (65%) | 7/7 (100%) |
| Path under the app's prefix | 15/43 (35%) | 2/2 |
| Expected status = base's status | 57/74 (77%) | 7/7 |
| Route mapping (extractor, labelled files) | 10/15 | 16/16 (one case added) |
| Routes over-mapped | 23 in 4 of 19 files | 0 in 0 of 20 files |
| Plan seconds, model plans: p50 / p90 | 90 / 166 (22 Runs) | 88 / 123 (4 Runs; the recon requests included) |
| Plan input tokens p50 (model plans) | 30.3k | 43.3k (4 Runs) |
| Runs planned with no model call | 3 | 6 (5 `nothing_to_test`, 1 plan reused) |

Per fix:

- **Fix 1, the P1 case:** 1 plan shape and a 100% modal verdict over 2 Runs (before: 4 shapes, 6/9); the second Run
  reused the first's plan with 0 tokens. n = 2, limited by the hand-asked cap.
- **Fix 1, comment-only cases:** all five rerun cases ended `nothing_to_test` in seconds, with no machine and 0 tokens.
- **Fix 2, the prefix:** the added equivalent case probed the prefixed path in both Runs. The revision round is proven
  at the unit level (`runtime-agent.harness.spec.ts`), not yet on a product Run.
- **Fix 2, the HTML page case: not measured.** The planner wrote a browser probe of the base's text, but no Run of it
  measured the plan: the cell's browser path failed on both sides. Cause, from the cell log (`browser.unavailable`,
  `url not http(s): scheme ws`): the recipe ran `next dev`, and both browser paths refused its HMR WebSocket. Since
  then a WebSocket to the app's own origin is allowed and not measured (`internal/browser/capture.go` `appSocketURL`,
  `browser-runner/network-guard.mjs` `sameOriginSocket`), and a later Run of the same PR kept its transport on every
  round. A round still ends without a result when one of the page's requests is unfinished as the steps end (the cell
  takes only a complete network measurement); the runner now waits for such a request up to the guard's per-request
  bound (`run-job.mjs` `drain`) instead of 250 ms.
- **Fix 3, the extractor:** over-mapped 23 routes → 0, route mapping 10/15 → 16/16 on the recorded diffs. A Nest
  handler with a second decorator holding an object ended at that object, so its body was outside every handler; the
  method's range now comes from the parsed file.

Not changed: `libs/llm`, BYOK, the model route, `TEST_PLANNER_LIMITS` and the Run's token budget.

## Intended changes (P9)

Cause, read in the code: the plan asserts main's text; the PR side fails the step that reads the reworded line;
`decideProbe` returns `behavior_change`; the classifier answers `uncertain` (no test backs it, `intent-classifier.ts`
`decide`), and `decideRunVerdict` counts that as a regression.

Fix, deterministic (`libs/runtime/gate/intended-change.ts`, wired in `run-orchestrator.ts` `replayProbes`): a
`behavior_change` finding whose every differing field is a literal that one changed block of the diff removes (main's
value), with its counterpart added in the same block (the PR's value), is the PR's intended change: the finding is
kept, `intent: 'intended'`, with both literals and the added line in `intendedChange`, so the check is "Partly tested ·
1 intended change" (never success, `run-state.ts`; `action_required` since the owner decision of 2026-11-18, or neutral where the org chose that fallback). An expectText value is
explained line by line (then by the words that differ inside a line), a JSON value or status as a whole token, a JSON
key renamed with its values unchanged by its name. A literal the diff does not change, a PR value it does not add, a
body digest or a count keeps the finding a regression. A change that made one side skip an asserting step after it is
`inconclusive`. The planner's browser rules now say to give expectText text the diff leaves alone.

The eval gained `--regate` (the recorded replay rounds decided again by the current `decideIntendedChange`) and the
case label `intended` (right only when a probe reports the intended change).

| `run.js` over one week (132 Runs) | Recorded | `--regate` |
| --- | ---: | ---: |
| Right Runs | 86/100 | 87/100 |
| The reworded-line case | 0/2 | 1/2 (the other Run is P8) |
| Runs whose verdict changes | — | 1 of 132 |
| Probes marked intended | — | 6, all a literal the diff swaps |
| The real-regression control | 6/7 regression | 6/7 regression: its findings stay unintended |

The Run page shows it: next to "Changed, as the PR intends", each value the diff swaps ("… on main → … on this PR ·
file:line", linked at the PR's head), or that a pre-existing test backs it
(`apps/web/src/core/components/runtime/intended-note.tsx`, `model/findings.ts` `intendedBy`).

### An HTTP probe of an HTML page, compared by its visible text

Before this change, `normalizeFields` (`gate/probe-fields.ts`) reduced a body that is not JSON to `json: not_json` and
`body.sha256`, so a text change on a page differed only in a digest the diff can never explain. The worker already
holds the body (`ProbeResult.http.body`, at most 1 MiB, `probe.schema.ts`), so every option was worker-side.

| Option | What it compares for `text/html` | For | Against |
| --- | --- | --- | --- |
| A. Text field beside the digest | visible text plus `body.sha256` | Smallest change | The digest still differs on every text change: nothing gained for intended changes |
| B. Text field instead of the digest | visible text only | A text-only PR is explained line by line | A markup-only change (an attribute, an `href`, a form field's `name`) is invisible. Unsafe alone |
| C. Text plus a markup skeleton (chosen) | visible text and the digest of the tag tree with text removed and build-identity attributes normalized | A text-only change leaves the skeleton equal; a markup change stays a finding | Needs an HTML tokenizer and a normalization list that will miss some frameworks |
| D. Per-block fields | one text field per block element | Fine-grained `differingFields` | An inserted block shifts every later index; past 5 varying fields the probe is inconclusive |

**Measured first**, over the week's recorded non-JSON rounds that carry a body (124 of 130): with two requests to the
same build, the body differed on the Next dev server (a per-request id and timings in inline scripts) while the text
and the skeleton stayed equal; every other app's pages were equal on all three. The first cut of the skeleton moved
on an equivalent change, because the dev server emitted an async chunk `<script>` in another place; sorting a run of
adjacent `script src` / `link` tags made it equal. The sample is small (two Next Runs, one Remix Run, no production
`next build`, no Vite or SvelteKit page).

**Parser.** `htmlparser2` 8.0.2 (MIT), already in `pnpm-lock.yaml` and in the production image's `node_modules`
through `html-to-text`. It is not declared in `package.json`; declaring it adds an importer entry to the lockfile, left
for the owner.

**What the gate compares** (`libs/runtime/gate/html-fields.ts`, `probe-fields.ts` `notJsonBodyFields`). An HTTP body
that is not JSON and is an HTML page (`content-type` `text/html`, or without one a `<!doctype html` / `<html` start) is
compared by these fields instead of `body.sha256`:

- `html.text`: the visible text, one line per block element, whitespace collapsed, entities decoded, no `script`,
  `style`, `template`, `noscript` or comments, capped at 16 KiB (past the cap a last line holds the digest of the
  whole text). `decideIntendedChange` explains it as it explains an expectText value.
- `html.markup.sha256`: the digest of the tag skeleton (start and end tags with sorted attributes; no text, no
  comments). It is never explained. Set aside: hash-like pieces and query strings in asset attribute values, the order
  within a run of adjacent asset tags, how many adjacent inline scripts the flight data is cut into, `nonce` and
  `integrity` values, and a CSRF token in a hidden input or a `meta` tag.

Both fields have a dot, so neither is decisive: one that varies between base rounds is masked, as `body.sha256` was.
The reconnaissance compares two GETs by these fields too.

**Tests that fail on the code before it:** `gate/intended-change.spec.ts`, `gate/html-fields.spec.ts`,
`worker/run/probe-fields.spec.ts`, `worker/agent/plan-recon.spec.ts`.

**Eval.** `--regate` also derives a recorded round's fields again from its body and decides the probe again with
production's `decideProbe`. `--repeat-rounds` is an assumption, and the output says so: a round the replay never played
is taken as a repeat of the side's last round.

| `run.js` over one week, with bodies (136 Runs, 103 scored) | Right Runs | The reworded-line case | Probe verdicts moved |
| --- | ---: | ---: | --- |
| Recorded | 89/103 | 1/3 | — |
| `--regate`, before option C | 90/103 | 2/3 | — |
| `--regate`, option C | 90/103 | 2/3 | 0 on 124 re-derived rounds |
| `--regate --repeat-rounds`, option C | 91/103 | 3/3 | 1 |

No control case moved.

**Deploy.** No DBOS step is added or reordered, but a probe round's recorded fields change shape for HTML pages: a Run
that resumes across the deploy would compare old rounds (`body.sha256`) with new ones (`html.*`) in one probe and read
the missing fields as a difference. Deploy it under a new `RUNTIME_RELEASE_VERSION`, or with no Run in flight.
`TEST_PLANNER_VERSION` moves with it, so no plan of the previous version is reused. The export reads bodies only where
`RUNTIME_EVIDENCE_DIR` is set (the worker container).
