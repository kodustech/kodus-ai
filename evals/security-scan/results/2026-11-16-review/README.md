# Deep scan review evidence, 2026-11-16

This folder records the measurements used to answer Wellington's review of
[#2528](https://github.com/kodustech/kodus-ai/pull/2528). Raw model outputs are
preserved separately from later scoring. The model is
`deepseek-v4-flash@fireworks`, served as
`accounts/fireworks/models/deepseek-v4p1-flash` through production BYOK routing.
Each public repository has the same $3 request-level cap.

Release state: the last valid precision baseline fails Python and Go. The
fresh development/confirmation attempt stopped on local ENOSPC, without a
retained final positive report. No passing release claim is made.

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
passed on `e64b84cb0`; the `f7723e64b` checks are running. The advisory mutation
run lost a GitHub runner during shard zero after its dry run passed; no
mutation score is claimed for that interrupted shard.
