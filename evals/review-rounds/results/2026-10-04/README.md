# 2026-10-04 — PR #2074 follow-up validation

Model: `deepseek-v4-flash@fireworks`; judge: `claude-haiku-4-5`.
The configured OpenAI judge keys returned 401. These runs are not comparable
with the earlier `gpt-5.6-luna` calibration and set no fleet quality floor.

`pr-head/` uses PR head `03b25de6e` with the new lifecycle fixtures.
`patched/` uses the `libs/` fixes committed in `f63d552ed`; both run artifacts
record the original HEAD and a source digest of the uncommitted overlay.
The overlay digest also includes the eval fixtures and docs at run start.

| Synthetic Kody Rules acceptance | PR head | Patched |
|---|---:|---:|
| Initial findings delivered | 6/6 | 6/6 |
| Old finding absent after rejection/repair and subsequent commits | 30/30 | 30/30 |
| New violation of the same rule in another function delivered | 6/6 | 6/6 |

Each side ran 36 reviews. The declined sequence moves the finding's lines
across four nearby commits; the repaired sequence keeps the stored status
pending through the fix and three subsequent commits. Only actual delivered
comments enter the following round's history. The PR already passed this
reproduction before the additional reference-preservation fixes.
One baseline final control had a judge fetch failure; only that infra row was
retried on the identical source digest, recorded under `retriedInfra`.

`partial-public-replays/` retains the public replay attempts, including infra.
R2 delivered a linked revision in both measured attempts; its third was infra.
R4a/R4b and R10 did not deliver their conditional target claims in the measured
attempts, so they provide no evidence about linking a delivered revision.
DNS/fetch failures make these batches incomplete measurements, not passes.

Private customer snapshots were exported through SEO Copilot's BigQuery
configuration and replayed via `--cases-file`. Their source, comments and raw
model output remain outside this repository. The private replay summary is
recorded separately; snapshots do not reconstruct every historical commit or
recover unavailable developer replies.

Local checks: 704 existing selected tests plus six new lifecycle/measurement
checks passed, as did the libs type gate and `pnpm eval:wiring`. The full repo
has an existing typecheck backlog; the changed production files had no errors.
The original PR's nightly evidence remains its baseline; this follow-up did
not run a new calibrated nightly against the unavailable OpenAI judge.

`private-replay-summary.json` contains only counts, verdicts and input hashes.
Customer C delivered its target 3/3 without history and 0/3 with history on the
same full snapshot. Customer A repeated neither target in six complete history
runs, but its three fresh focused controls were infra. Customer B's concurrency
control never delivered the target, so its silence is not suppression evidence;
one history run also remained infra. Raw private findings are not committed.
