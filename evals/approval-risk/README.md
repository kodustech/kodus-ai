# Approval risk eval

**Answers:** After a clean Kody review, which PRs can Kody approve without a human, and how often does the risk check hold PRs that a human judged safe?

**Runs:** The controlled pair drives the production approval stage and model route with a scripted model in `pnpm eval:wiring`. The full set requires 200 independently adjudicated PR snapshots and returns exit 2 until available.

**Run it:** `node evals/approval-risk/run.js --model=eval-fake --set=controlled --gate` in the wiring environment; use `--set=full` after the corpus is frozen.

**Gate:** `targets.json` holds per-model floors after two full runs. No quality floor exists yet.

**Cost:** One model call per clean, in-scope PR without a sensitive-path veto. Results include input/output/cache tokens and model time.

Issue: [#1765](https://github.com/kodustech/kodus-ai/issues/1765). The historical area map is [#2192](https://github.com/kodustech/kodus-ai/issues/2192).

## Source and status

`candidates.json` is a reproducible candidate pool, not approval labels. `snapshots.json.gz` has 356 public pre-review GitHub compares and diffs. It contains no SWRench findings, review discussion, or outcome labels. The source is [SWRench](https://github.com/ZZR0/SWRench) (MIT), file `data/swr_datasets_d5c5.jsonl` at commit `67ae1d4395ac05f800d62b0e13678eadeb9fa5c7` (SHA-256 `7048e7a92ea9f7a1e6812646694a040582448cc1dd9d515264a4b55071aff95d`).

Generate the manifest from a local copy of that file:

```bash
node evals/approval-risk/seed-candidates.js /path/to/swr_datasets_d5c5.jsonl
python3 evals/approval-risk/materialize-snapshots.py /path/to/swr_datasets_d5c5.jsonl
```

The selection keeps PRs from 2020 onward with either a SWRench functional finding or no recorded finding, then sorts by creation time and PR identity. This yields 356 candidates across 12 repositories (124 with a functional finding, 232 without a recorded finding). Those source groups are **sampling strata**, never approval ground truth. Do not infer that a PR without recorded findings is safe, or that an unmerged PR was unsafe.

All 356 snapshots have an `ahead` base-to-head comparison. In 146 cases the recorded base had diverged; the materializer used the first PR commit's parent as a conservative base and recorded `baseSource: first-commit-parent`. A human must mark a case `uncertain` if that diff omits context needed to judge it. Some PR titles may have changed after the snapshot; the adjudicator checks the linked PR timeline before using the title as evidence.

## Labeling contract

For each candidate, use the reviewable head SHA **before** the first human finding used as evidence. The PR title/body, diff, repository tree, tests, and area history given to Kody must reflect what was available at that SHA and date. Later review discussions and fixes are available to adjudicators only. Do not fetch the PR's current head with `evals/investigation/fetch-pr-data.js`: it may contain the fix and leak the answer.

Use the full base-to-head compare link in each snapshot to inspect the diff. A commit page shows only one commit. The [blind pilot](pilot-review.md) contains three examples.

Record one of three human decisions in `adjudications.json`, with the pre-review head SHA, the time that head became reviewable, an adjudicator, a brief evidence link, and a rationale. An `uncertain` case may omit the snapshot when it cannot be reconstructed:

- `hold`: at that snapshot there is a concrete functional, security, compatibility, or policy risk that makes unreviewed approval inappropriate. A later reviewer finding is evidence only if it applies to the snapshot.
- `eligible`: an adjudicator inspected the snapshot and relevant context, found no material issue or explicit policy veto, and would accept approval after a clean Kody review. Absence of comments alone is insufficient.
- `uncertain`: context, snapshot, or outcome evidence is inadequate. Exclude from the scored set and report its count.

Adjudicators should label without seeing SWRench's `change_introduced` flag. Independently relabel a sample and resolve disagreements before freezing the set. Record the rubric version and the evidence available to each adjudicator. Preserve at least 200 scored PRs across repositories, with both `hold` and `eligible` cases and a sparse-history slice. Cap any one repository at 25% of the scored set so the largest source repositories do not dominate the result.

Run `node evals/approval-risk/label.js --adjudicator=<name>` for a blind, balanced queue with the snapshot, compare link, later PR discussion link, and prompts for the decision and evidence. The tool saves each decision to `adjudications.json`. The pilot's three cases are examples, not a baseline.

Run `node evals/approval-risk/validate-adjudications.js` to check the corpus. It exits 2 while fewer than 200 scored cases have valid labels, so an unlabeled candidate pool cannot appear as a measured eval.

## Baselines and gate

Run production's review and approval decision on the **same** frozen snapshots for: current clean-review approval, the model-only risk decision, and model plus the area map and team marks. Report wrong approvals among `hold` cases, approval coverage among `eligible` cases, and both metrics on sparse-history cases. Measure the baseline before fixing acceptance thresholds in #1765. The area map has a separate temporal ranking eval in #2192; do not use its bug-fix proxy as the approval label.

`run.js` calls the production decision stage and model route. Its controlled pair checks decision wiring, not risk quality. The full set compares current clean-review approval, model-only risk, and model plus map on the same labeled snapshots; it reports wrong approvals, eligible coverage, and sparse-history results. It returns exit 2 until at least 200 independent labels are frozen and refuses to infer labels from SWRench's finding flag.
