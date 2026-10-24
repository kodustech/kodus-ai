# Approval risk eval

**Answers:** After a clean Kody review, which PRs can Kody approve without a human, and how often does the risk check hold PRs labeled safe by an adjudicator?

**Runs:** The controlled pair drives the production approval stage and model route with a scripted model in `pnpm eval:wiring`. The full set requires 200 adjudicated PR snapshots and returns exit 2 until available.

**Run it:** `node evals/approval-risk/run.js --model=eval-fake --set=controlled --gate` in the wiring environment; use `--set=full-balanced` for the corrected 200-case corpus.

**Gate:** `targets.json` holds per-model floors after two full runs. No quality floor exists yet.

**Cost:** One model call per clean, in-scope PR without a sensitive-path veto. Results include input/output/cache tokens and model time.

The runner uses production's organization and license services for the Teams access check, with a beta organization row and active Teams license response supplied at their repository and external billing HTTP boundaries.

Issue: [#1765](https://github.com/kodustech/kodus-ai/issues/1765). The historical area map is [#2192](https://github.com/kodustech/kodus-ai/issues/2192).

## Source and status

`candidates.json` is a reproducible candidate pool, not approval labels. `snapshots.json.gz` has 356 public pre-review GitHub compares and diffs. It contains no SWRench findings, review discussion, or outcome labels. The source is [SWRench](https://github.com/ZZR0/SWRench) (MIT), file `data/swr_datasets_d5c5.jsonl` at commit `67ae1d4395ac05f800d62b0e13678eadeb9fa5c7` (SHA-256 `7048e7a92ea9f7a1e6812646694a040582448cc1dd9d515264a4b55071aff95d`).

Generate the manifest from a local copy of that file:

```bash
node evals/approval-risk/seed-candidates.js /path/to/swr_datasets_d5c5.jsonl
python3 evals/approval-risk/materialize-snapshots.py /path/to/swr_datasets_d5c5.jsonl
python3 evals/approval-risk/materialize-area-history.py
python3 evals/approval-risk/enrich-history-links.py
node evals/approval-risk/attach-area-maps.js
```

The selection keeps PRs from 2020 onward with either a SWRench functional finding or no recorded finding, then sorts by creation time and PR identity. This yields 356 candidates across 12 repositories (124 with a functional finding, 232 without a recorded finding). Those source groups are **sampling strata**, never approval ground truth. Do not infer that a PR without recorded findings is safe, or that an unmerged PR was unsafe.

The attached area maps use only earlier merged PRs from this sampled pool. `enrich-history-links.py` fetches their closing issues and records links with a bug, defect or regression label; 29 of 339 historical PRs have one. Within the first 200 scored snapshots, 188 have a map, 100 have a prior linked-bug signal somewhere in that map, and 41 touch a direct directory with that signal (39 `hold`, 2 `eligible`). This is sparse history, not a complete repository scan. GitHub's current issue labels stand in for the labels at historical merge time; that time mismatch is a limitation of this offline eval.

All 356 snapshots have an `ahead` base-to-head comparison. In 146 cases the recorded base had diverged; the materializer used the first PR commit's parent as a conservative base and recorded `baseSource: first-commit-parent`. Mark a case `uncertain` if that diff omits context needed to judge it. Some PR titles may have changed after the snapshot; check the linked PR timeline before using the title as evidence.

## Labeling contract

For each candidate, use the reviewable head SHA **before** the first human finding used as evidence. The PR title/body, diff, repository tree, tests, and area history given to Kody must reflect what was available at that SHA and date. Later review discussions and fixes are available to adjudicators only. Do not fetch the PR's current head with `evals/investigation/fetch-pr-data.js`: it may contain the fix and leak the answer.

Use the full base-to-head compare link in each snapshot to inspect the diff. A commit page shows only one commit. The [blind pilot](pilot-review.md) contains three examples.

Record one of three decisions in `adjudications.json`, with the pre-review head SHA, the time that head became reviewable, an adjudicator, an evidence link, and a rationale. An `uncertain` case may omit the snapshot when it cannot be reconstructed:

- `hold`: at that snapshot there is a concrete functional, security, compatibility, or policy risk that makes unreviewed approval inappropriate. A later reviewer finding is evidence only if it applies to the snapshot.
- `eligible`: an adjudicator inspected the snapshot and relevant context, found no material issue or explicit policy veto, and would accept approval after a clean Kody review. Absence of comments alone is insufficient.
- `uncertain`: context, snapshot, or outcome evidence is inadequate. Exclude from the scored set and report its count.

The first 200 scored cases were labeled by Codex (`adjudicator: codex`) from the saved pre-review diff and later public PR discussion; they are AI adjudications, not independent human ground truth. The selection is frozen in `adjudication-plan.json` before measuring the model, but labeling took the first 200 entries of a repo-alphabetical plan. Sympy and Sphinx have no scored labels, while scikit-learn has 36 of its 50 planned cases; the scored mix is not the plan's shuffled sample. The labels are 156 `hold` and 44 `eligible` across 10 repositories; the largest repository contributes 19%. The evidence collector and case viewer reproduce the review material without reading SWRench finding flags. These labels support an initial comparison, with the limitation that one adjudicator can systematically overlabel risk. Independently relabel a balanced sample and resolve disagreements before setting an acceptance floor or treating the corpus as ground truth. Keep a sparse-history slice and cap any one repository at 25% of the scored set.

The corrected corpus is frozen in `balanced-selection.json`: sort all 272 IDs in `adjudication-plan.json` by the hexadecimal SHA-256 of each ID (ID breaks ties), then take 200. `adjudications-balanced.json` contains those 200 Codex labels, including 64 additional pre-review adjudications. It has 122 `hold` and 78 `eligible` cases across 11 repositories; scikit-learn contributes 50/200, exactly the 25% cap, Sympy 43, and Sphinx 7. These remain **preliminary AI labels**, not independent ground truth. The earlier `full` corpus and its published run links remain frozen for comparison; `full-balanced` measures the corrected selection separately. Validate it with `node evals/approval-risk/validate-adjudications.js --balanced`.

The [balanced blind audit batch](results/human-audit-balanced-50.csv) samples 50 cases across all 11 repositories without consulting the model decisions. Its `humanLabel` and `humanRationale` columns are empty. A human adjudicator must inspect the pre-review compare and fill those columns before we resolve disagreements or set an acceptance floor. The initial audit batch below belongs to the earlier corpus.

For an independent human audit, start with [the blind 200-case CSV](results/blind-audit-2026-10-20.csv). Its order is shuffled, and it contains the exact pre-review compare, snapshot date, and empty `humanLabel` and `humanRationale` columns. Use `hold`, `eligible`, or `uncertain` under the rubric above. Inspect the snapshot and relevant repository context before reading the existing labels or later PR discussion. Save your labels in a separate copy; the original eval labels remain frozen.

The first review batch is [50 blind cases](results/human-audit-batch-01.csv), taken from the shuffled list without consulting model decisions. Fill `humanLabel` and a brief `humanRationale` for each row, then return the CSV for disagreement analysis. Do not inspect `adjudications.json` or model results until the batch is complete.

Then compare your decisions with [the result CSV](results/initial-audit-2026-10-20.csv). It starts with the 68 cases where model + map approved a Codex-labeled `hold`, then 3 missed approvals, then 129 agreements. The `priority` column is disagreement with **Codex**, not verified error. The result combines the [full run](https://github.com/kodustech/kodus-ai/actions/runs/39493931285) and [two-case retry](https://github.com/kodustech/kodus-ai/actions/runs/39508066835). Reproduce both CSVs with `python3 evals/approval-risk/export-audit-sheet.py --full <full-result.json> --retry <retry-result.json> --output <audit.csv> --blind-output <blind.csv>` after downloading those runs' artifacts.

The [prompt comparison CSV](results/prompt-comparison-2026-10-20.csv) reruns the same frozen 200 cases after requiring evidence for a low-risk decision. Its artifacts are the [first 50](https://github.com/kodustech/kodus-ai/actions/runs/39515672363), [next 50](https://github.com/kodustech/kodus-ai/actions/runs/39517850797), [remaining 100](https://github.com/kodustech/kodus-ai/actions/runs/39521249355), and [one-case retry](https://github.com/kodustech/kodus-ai/actions/runs/39530591435). The third run had one unavailable model response; the retry completed it. All 200 distinct cases are measured. Recreate the CSV with the exporter above plus one `--candidate-run RUN_ID=<artifact.json>` for each run and `--candidate-output <comparison.csv>`.

This is an offline, hypothetical approval decision after assuming a clean Kody review. The eval did not approve historical PRs on GitHub or verify that their full Kody reviews were clean. In the revised model + map run, 18 of 156 PRs labeled `hold` by Codex received `approve` from the risk check. Those 18 are disagreements between the risk model and an AI adjudicator, not 18 confirmed unsafe approvals. A human audit is needed to measure actual wrong approvals; the current result alone does not establish that the feature is unsafe or safe.

On the Codex-labeled `hold` cases, the original model + map approved 68/156; the revised prompt approved 18/156. On the 44 `eligible` cases, approvals fell from 41 to 30. The revised prompt's model-only arm approved 15/156 `hold` and 32/44 `eligible`; its model + map arm approved 18/156 and 30/44. The separate model calls are stochastic, so that difference does not establish that the map worsens decisions. The prompt trades 50 fewer approvals contrary to Codex's `hold` labels for 11 fewer approvals matching Codex's `eligible` labels. These are comparisons against one AI adjudicator, with no independent human quality floor.

With GitHub CLI authentication, run `python3 evals/approval-risk/collect-adjudication-evidence.py` to rebuild the later-discussion cache in the system temporary directory, then `python3 evals/approval-risk/case-card.py owner/repo#123` to inspect a case. The model runner reads `snapshots.json.gz` and the adjudication file for its selected corpus only; it never reads this discussion cache.

Run `node evals/approval-risk/label.js --adjudicator=<name>` for a blind, balanced queue with the snapshot, compare link, later PR discussion link, and prompts for the decision and evidence. The tool saves each decision to `adjudications.json`. The pilot's three cases are examples, not a baseline.

Run `node evals/approval-risk/validate-adjudications.js` to check the corpus. It exits 2 while fewer than 200 scored cases have valid labels, so an unlabeled candidate pool cannot appear as a measured eval.

Run the corrected comparison with `node evals/approval-risk/run.js --set=full-balanced --model=deepseek-v4-flash@fireworks --output=eval-results/approval-risk-balanced.json` in an environment with `BYOK_FIREWORKS_API_KEY`, or dispatch the `Evals: wiring smoke (PR)` workflow with `approval_set=full-balanced` on this branch. The workflow uploads the result JSON as an artifact. Use `--set=full` to reproduce the earlier corpus.

The 200-case run can exceed the workflow's two-hour limit. Dispatch four runs with disjoint `approval_case_ids` inputs of 50 IDs each and distinct `approval_batch` names (`01` through `04`), all with the same `approval_set`. Download each run's `approval-risk-full` artifact, then run `node evals/approval-risk/merge-results.js --set=full-balanced --output=eval-results/approval-risk-merged.json path/to/batch-01.json path/to/batch-02.json path/to/batch-03.json path/to/batch-04.json`. The merger rejects missing, duplicate, errored, or mislabeled cases and recomputes all comparisons across exactly the frozen 200 labels. Keep all four run links with the merged result.

## Baselines and gate

Run production's review and approval decision on the **same** frozen snapshots for: current clean-review approval, the model-only risk decision, and model plus the area map and team marks. Report approvals contrary to `hold` labels, approval coverage among `eligible` cases, and both metrics on sparse-history cases. Treat the first metric as a proxy for wrong approvals until humans validate the labels. Measure the baseline before fixing acceptance thresholds in #1765. The area map has a separate temporal ranking eval in #2192; do not use its bug-fix proxy as the approval label.

`run.js` calls the production decision stage and model route. Its controlled pair checks decision wiring, not risk quality. The full set compares current clean-review approval, model-only risk, and model plus map on the same labeled snapshots; its `wrongApprovals` output counts approvals contrary to `hold` labels, not human-confirmed errors. It also reports eligible coverage overall, for sparse history, and for PRs touching directly linked-bug areas. The linked-bug eligible slice has only two cases, so treat its coverage as descriptive. It returns exit 2 until at least 200 scored labels exist and refuses to infer labels from SWRench's finding flag.
