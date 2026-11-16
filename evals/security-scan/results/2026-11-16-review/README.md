# Deep scan review evidence, 2026-11-16

This folder records the measurements used to answer Wellington's review of
[#2528](https://github.com/kodustech/kodus-ai/pull/2528). Raw model outputs are
preserved separately from later scoring. The model is
`deepseek-v4-flash@fireworks`, served as
`accounts/fireworks/models/deepseek-v4p1-flash` through production BYOK routing.
Each public repository has the same $3 request-level cap.

Release state: the original precision baseline fails Python and Go. The
local follow-up stopped on ENOSPC. A clean `e5223d6a0` checkout completed all
six development/confirmation cases on the VM in one paid queue, retaining the
final output without infrastructure errors. Three development samples are
judged; confirmation scoring remains pending. The first library candidate
has already failed its control conditions; its final UUID result is pending.
A revised prompt candidate passes contract checks but has no model result yet.
No release pass is claimed.

## Development baseline

The clean engine commit is `34ea92555c18eecd5146f84e8580659532b981cb`.
`positive.raw.json` contains Flowise, Langflow and WeKnora at pinned vulnerable
commits; `negative.raw.json` contains the three pinned library controls.
`baseline.combined.raw.json` combines those inputs and retains each source
run's hash and provenance. `baseline.scored.json` is the later score.

| Language | Real/listed | Judged | Precision | Recall baseline | Unjudged |
| --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript | 16 | 22 | 72.7% | 2/5 | 44 |
| Python | 8 | 21 | 38.1% | 0/1 | 52 |
| Go | 12 | 21 | 57.1% | 1/1 | 29 |

The baseline fails the unchanged 60% precision floor in Python and Go.
All three positive scans stopped at their cap; their uncovered units remain
visible in the raw coverage, so this is not full repository coverage.
The controls completed all 31 units: uuid 17/17, itsdangerous 10/10, is 4/4.
The one itsdangerous report is false: normal `loads` verifies before
decompressing, while `loads_unsafe` explicitly documents its unsafe debugging
contract. The separate zero-finding control check therefore fails.

`sampling.json` was fixed in commit `65f1326bf` before reading the selected
descriptions: the 20 smallest SHA-256(seed + NUL + finding key) off-list
findings per language, plus every control finding. No favorable replacements
were chosen. The 125 unjudged findings are excluded, never counted as true.

The judge is Codex reading the pinned source, not an independent human review.
Every judgment records its raw result hash, content hash, judge, date, reason,
source permalink and source-file hash in `../../adjudications.json`.
The metric asks whether a reported vulnerability exists; it does not certify
its severity, exact CWE/class or location. The reasons explicitly flag two Go
reports whose underlying authorization bug is real despite an injection label
and an inaccurate location. Reports of the same underlying bug can still occur
at different identities; these are per-report precision numbers, not a count
of unique vulnerabilities.

## Candidate and confirmation

`e64b84cb0` removes the contradictory ordinary-login hunt, passes class
exclusions and concrete-boundary requirements to the existing verifier, and
enables reasoning when BYOK has not explicitly selected an effort.
The repeated development cases and three controls use the same inputs and
caps as the baseline. Their results must be reported even when a gate fails.
The first parallel candidate/control/confirmation processes hit provider
HTTP 429 limits and were stopped. Their compressed logs and explicit missing
final-output provenance remain in `aborted-rate-limit-attempts/`; they are not
clean release measurements. `fresh-measurement-plan.json` freezes a new single
queue with two repositories at a time, the same cases, caps and sample rules.

`confirmation-plan.json` preregisters Paperclip, MLflow and Ollama, selected by
hash among different repositories before viewing their new findings. They
were not used for this review correction. This is not a claim that historical
project development never used them. These additional results are reported
separately; they do not replace a failing development result.

The sample is small, source-judged by the coding agent, and covers three
languages. It is not an unbiased estimate for every language or repository.
The historical RealVuln leaderboard claims were removed from the PR because
their original output could not be recovered; they are not reused here.

The fresh attempt stopped on local disk exhaustion. Its three immutable case snapshots
and their selections are in `fresh.cases/`, committed before inspection.
The is control completed 3/3 planned units and reported one false positive;
itsdangerous completed 7/10 units and reported one false positive. Its three
unfinished units remain visible; no provider request failures were recorded
for either case. These two reports invent a remote/constrained caller not shipped
by the library; the underlying regex/decompression behavior is real, but
the claimed security boundary is not established. Exact-claim source
judgments remain in `../../adjudications.json`. These checkpoints are not
a passing quality gate or a completed development/confirmation measurement.
`aborted-disk-full-attempt/` retains the original incomplete checkpoint,
compressed complete log and incident metadata. All three frozen cases match
that checkpoint exactly. No completed positive/confirmation result or final
aggregate spend was retained; those missing cases remain unmeasured.

The uuid control completed 14/16 units with two unfinished, and reported two
findings for $2.855392944, with no provider request failures. Its v1 MAC/token
report is false: it describes the documented version-1 semantics and invents
a token consumer. Its v6 concurrency report is real: the pinned source omits
the time-state mutex on NewV6WithTime. `contracts/uuid-race-probe.*` retains
the added bounded test, source hashes and race-detector output: 6,000 serial
calls produced 6,000 unique IDs; 6,000 concurrent calls produced 1,208 duplicates.
This proves the identity-integrity bug, not the report's hypothetical session
hijack or severity. This repository was assumed clean when selected, but is
not a valid clean negative for that behavior. Its raw result and original
expected-zero assumption remain intact; it is not replaced with a favorable
case. The three-control zero-finding check fails, and three proven clean
controls cannot be claimed from this set.

## VM continuation and library candidate

`continuation-measurement-plan.json` freezes the six-case VM continuation on
clean `e5223d6a0`, with the same DeepSeek route and $3 per-case cap ($18 maximum
case budgets), one runner and two repositories at a time. Completed case
snapshots and hash-selected samples are retained in `vm-followup.cases/` and
were committed before their descriptions were inspected. The complete retained
run is `vm-continuation.raw.json`; `vm-continuation-integrity.json` verifies all
six immutable case snapshots equal its final cases. Its committed meter spend
is $17.551285068, within the $18 sum of case caps. The initial exit 2 reflects
unjudged findings, not a missing final report: infrastructure errors are zero.
Confirmation descriptions remain uninspected while the library candidate
controls are evaluated.

The three completed development cases have the following **partial** source
judgments. They do not include controls or the separate confirmation group:

| Case | Real/listed | Judged | Precision | Unjudged | Coverage | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Flowise (TypeScript) | 17 | 21 | 81.0% | 16 | 7/1,405 done; 2 failed | 1/5 |
| Langflow (Python) | 17 | 20 | 85.0% | 1 | 4/1,843 done | 0/1 |
| WeKnora (Go) | 13 | 20 | 65.0% | 6 | 5/372 done | 0/1 |

All stopped within their caps: $2.992663248, $2.915709216 and $2.987613012.
The strict advisory-matcher recall is 1/7 versus 3/7 in the original baseline,
with much less completed coverage. Higher sampled precision does not establish
better overall detection. Dataset language means the repository primary
language; WeKnora includes findings in its Python docreader component.
`vm-development.partial-summary.json` retains the case hashes and unjudged
counts. This is not a complete audit of these repositories. Call-failure
counters include budget admission/cancellation errors and must not all be
called provider failures. No exhausted HTTP 429 was recorded in these cases.
The 60 new judgments preserve every previous exact-claim record and leave the
original failing baseline unchanged (`contracts/adjudication-history-invariant.json`).
The judge remains Codex inspecting pinned source, not an independent human.
`contracts/express4-query-provenance.json` supports rejecting one report that
assumes Express 5 getter behavior in a repository using Express 4.

`library-boundary-hypothesis.json` was committed before the production prompt
edit and before inspecting any new positive or confirmation descriptions.
Candidate `71dfbcbb6` adds the same generic library/API-contract instruction to
the finder and verifier. It names no benchmark repository, case or advisory.
`contracts/library-prompt-delta.json` verifies all seven class inputs differ
only by that paragraph; other prompt exports and all positive cases are
unchanged. Existing prompt/engine tests pass (81), and scripted-model wiring
passes on the clean candidate (`contracts/library-candidate-validation.log`).
The bounded diagnostic preload also passes scripted wiring
(`contracts/library-observed-wiring.log`); its source/hash and forwarding
contract are frozen in the measurement plan. It records failure categories
without model bodies or error messages. An injected real HTTP 429 is recorded
while the original no-paid-call failure contract still passes
(`contracts/candidate-observer-contract.json`). These checks establish wiring,
not model quality.

`library-candidate-measurement-plan.json` freezes conditional measurement:
finish the active six-case queue, then measure all four controls on the
candidate (maximum case budgets $12). Only if all three valid negatives are
fully examined without reports or provider infrastructure errors, and the
confirmed UUID identity defect remains detectable, advance to the same six
positive cases (maximum case budgets $18). Keep the 60% per-language floor,
all unfavorable results and the separate confirmation group unchanged.

`xxhash-control` was selected and inspected before any model run on it, at
`cespare/xxhash@998dce232f17418a7a5721ecf87ca714025a3243`; its plan is in
`supplemental-control-plan.json`. The original three control definitions and
expected-zero fields are unchanged. The valid-negative set is is,
itsdangerous and xxhash. UUID remains an additional diagnostic positive with
its original mistaken negative expectation visible; neither it nor its false
reports are dropped from measurement or precision. The historical `f7723e64b`
control snapshots are not described as a same-commit paired control run.

## Revised candidate

The retained `71dfbcbb6` controls in `library-candidate.cases/` do not pass:
is finishes 3/3 units with zero findings; xxhash finishes 7/8 with zero
findings; itsdangerous finishes 9/10 with one source-judged false report.
The two incomplete lenses returned without a formal submitted result, with
no provider request failures. The itsdangerous report again invents a
shipped untrusted web consumer for its explicitly unsafe diagnostic API.
Its uncapped decompression is real; the claimed security boundary is absent.
The final UUID case and aggregate accounting remain pending. No positive
phase will run on this failed candidate, and these results remain retained.

`submission-contract-hypothesis.json` and `codec-boundary-hypothesis.json`
were committed before their respective production edits. Revised source
`5617eab0a` tells the finder to call its existing `submitResult` tool with
`reasoning` and `suggestions`, including an empty array for a completed
negative investigation. It also distinguishes intended codec expansion
from a shipped unbounded hostile-data consumer, bypassed limit or independent
intrinsic defect. Finder and verifier share that resource-class exclusion.
It names no case, repository or advisory and retains the generic library
paragraph, intrinsic-defect scope and strict completion predicate.

`contracts/revised-candidate-input-delta.json` compares all seven actual prompt
inputs and all other exports: only those two instructions change. The case
catalogs, engine, native adapter, model route, 30 lens steps, four-unit
concurrency and caps remain unchanged. On a clean isolated VM checkout,
111 tests pass, including the actual adapter's prose-only/formal-result
contracts; scripted wiring passes with 100 scripted calls and no paid calls.
The tests, wiring, preflight hashes and log are retained in `contracts/`.

`revised-candidate-measurement-plan.json` freezes an additional control run
(maximum $12 sum of case caps), after the previous runner finishes normally
and all its results are retained. Only three fully examined clean negatives
and preservation of the confirmed UUID intrinsic defect permit the six-case
positive phase (maximum $18). The same hash samples, separate blind
confirmation group, source judge and 60% per-language target remain in force.
These validation checks and proposed runs do not establish a quality pass.

## Kody review corrections

`cc61b7011` refuses hostless scans before queueing, validates a positive
integer queue prefetch, distinguishes missing reproduction flags, removes
unreachable severity fallbacks, and includes organization/team in store errors.
Offline reproductions no longer attempt automatic dependency downloads.
The probe summary omits raw sandbox output and free-form errors.

The focused regressions pass (171 tests); the retained identity, provider
and surface contracts pass (90 tests). Both real-Mongo lifecycle tests pass,
including same-ID foreign-host/platform and hostless legacy records.
The new case also fails when either scope predicate is deliberately removed
by a test-only transform, with the original lifecycle case still passing.
`contracts/mongo-scope-mutations.log` records those expected assertion failures.
`contracts/isolation.kody.json` records an executed, successful real E2B probe
at the clean correction commit, with zero model calls and no raw output fields.

The second Kody pass corrected the private reproduction test's call signature
and made its namespace attempt explicit. Scorer tests now exercise actual
cross-form judgment lookup and reject stale claim hashes; unjudged findings
return before hashing. The observer's submittedResult field is already a
boolean completion flag, computed by the production adapter, not model prose.
`contracts/kody-second-round-final.log` records 107 Jest and 12 scorer tests
passing against the final source hashes. The baseline metrics remain identical
in `scoring-final-equivalence.json`; the failing quality floors are unchanged.

`contracts/ci-backend-ca2.json` links the successful full backend CI run:
1,391 suites, 20,203 tests and eight snapshots passed. The subsequent code
changes affect tests and the eval-only early guard; application runtime source
is unchanged. A rate-limit test that mixed wall time with an injected clock
now gives both components the same controlled clock; its 30 tests pass.
The clean-cache Mongo/Issues rerun also passes all 35 assertions.

`contracts/ci-backend-aa70.json` records full backend CI for the published
`aa70a7791`: 1,391 suites, 20,203 tests and eight snapshots pass. Its full
wiring, type, dependency-injection, permissions, environment and feature-gate
checks also pass. The advisory mutation workflow was canceled; it supplies
no complete mutation score. These checks precede revised prompt `5617eab0a`.

## Contracts and scope

`contracts/` contains the E2B isolation result, validation logs, graph probe,
and deliberate-failure probes. E2B actually executed the test; the separate
network namespace blocked loopback, the shared proxy and external traffic,
and the separate user could not write or replace the audit checkout.

The real Mongo lifecycle test preserves one issue, requires two distinct
misses to resolve it, ignores replay, and resets misses on a sighting.
The model-backed rescan probe runs production's start use case, processor,
engine, BYOK route, meter, local sandbox, lease manager and Mongo repositories.
Workflow envelopes, integration configuration and cache gateways are boundary
fixtures. It does not test HTTP, RabbitMQ or PostgreSQL.

Runo synchronizes source without moving the VM's Git HEAD. Its raw provenance
therefore remains dirty and names that old commit. The accompanying source
verification compares all 285 committed, loaded library files to the local
commit: no mismatches. The one generated EE environment shim also matches the
local file but is not claimed as committed code.

The successful pre-reasoning-change pair is retained. The first candidate pair
also remains: one class failed to finish in scan one, scan two completed, IDs
and caps held, and `bothCompleted` is false. It is not a passing full-pair proof.

The healthy serial pair in `contracts/rescan-healthy.json` passes every check
on the code verified against `f7723e64b`: both scans completed all their units
on commit `178dc9653805a3c578312e1ba3684bdcd4eaff05`. The first created one
issue for $0.043837884; the second created zero, found one still open and
resolved zero for $0.063914496. The Mongo `_id` stayed identical. Both caps
were $1. `rescan-healthy-source-verification.json` records all source checks.
The read-only observer forwards arguments/results unchanged and records each
lens's actual completion, submission and verification state.

The graph probe uses installed kodus-graph 0.3.0 on the included two-inline-route
fixture and returns zero nodes/edges. The deliberate heuristic decision and
its limits are recorded in the [design comment](https://github.com/kodustech/kodus-ai/issues/2451#issuecomment-6712366870).
Unit regressions distinguish the two method/literal-route keys and retain
their identity after line shifts.

Breaking every lens makes wiring fail with one map call, zero completed units
and 11 injected lens failures. Moving the eval key initialization after
production imports fails before any model call. The ordinary wiring smoke
loads 1,110 repository files and covers them all in the latest run.

`rate-limit.contract.js` also injects actual HTTP 429 responses into the
planner while the remaining engine runs on the scripted local model. The
engine continues through its real heuristic fallback, records the exhausted
provider calls, saves the completed case checkpoint, and the runner exits 2.
This contract makes no paid model calls; `contracts/rate-limit.json` is the
passing proof. The scorer's 12 tests and this contract run in PR CI.

## Reproduce scoring without model calls

```sh
node --test evals/security-scan/scoring.test.js
node evals/security-scan/run.js --rescore=evals/security-scan/results/2026-11-16-review/baseline.combined.raw.json --output=/tmp/scan-baseline-scored.json --gate
```

The baseline command must exit 1. Contract probes are
`scripts/security-scan/probe-repro-isolation.js` and
`scripts/security-scan/probe-rescan.js`; the latter requires Mongo and makes
paid BYOK calls. Unit/CLI/fix-prompt and full pre-push totals are in the logs.

Latest local pre-push: 812 suites, 13,038 passing tests and eight snapshots.
[Backend CI](https://github.com/kodustech/kodus-ai/actions/runs/43871839598)
and [wiring CI](https://github.com/kodustech/kodus-ai/actions/runs/43871839811)
passed on `e64b84cb0`. The published `e5223d6a0` head also passed
[backend CI](https://github.com/kodustech/kodus-ai/actions/runs/43911722886),
[wiring CI](https://github.com/kodustech/kodus-ai/actions/runs/43911722714),
type, DI, permissions, environment, feature-gate and preview checks. Its
[advisory mutation run](https://github.com/kodustech/kodus-ai/actions/runs/43911722739)
was cancelled; no mutation score is claimed. These are checks for the
published head, not a full CI claim for the local prompt candidate.
