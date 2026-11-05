# gold-v3-recall

> - **Answers:** Of the known problems in our golden set (`evals/dedup/gold-v3/golden.json`), how many does a run of the finder find, and how many of its comments are one of them?
> - **Runs:** on demand, after a finder run (`evals/investigation/run-recall.js` with `RECALL_DUMP`); never on a schedule.
> - **Run it:** `node evals/gold-v3-recall/score.js --dump=<RECALL_DUMP dir> [--out=<dir>] [--concurrency=4] [--dry-run]`
> - **Gate:** none. Experiment numbers, read side by side with the run they compare against.
> - **Cost:** one Claude Haiku 5.5 conversation per PR with comments (effort high, reading the code at the head when unsure), about US$0.04 for 15 heavy PRs; the judgments are cached per PR by their input, so scoring a run again costs nothing.

The golden set is the 50 PRs' known real problems, labelled TP (and TP nit) by Opus and Astra and debated where they disagreed. A run is scored against it, not against the Martian goldens in the datasets (`recall-assertion.js` scores those).

**The ruler** is the gold v3's official one (`tools/score.py` in kodus-eval-runs). Per PR, the judge gets every golden issue (its description, the Martian text where there is one, and up to three earlier comments that reported it, from `judge-issues.json`) and every distinct comment of the run, and answers per comment the issueId it describes or "new", by the same-problem rule in `judge-rule.md`. A valid TP is a golden TP that is not a nit and was confirmed or discontinued upstream (`upstream-verification.json`; 121 on the light set); each counts once. Every other comment is a FP: "new", a repeat of a TP already counted, a nit, a pending TP. No second pass against the known FPs. Recall = valid TPs found / valid TPs; precision = valid TPs found / comments; F1 and F2 from them.

**The judge** is Claude Haiku 5.5 (`GOLD_JUDGE_MODEL` to change it). On 2026-11-05 it judged the same comments the Opus 5.5 judge had judged on two runs of the controlled 15 PRs (kodus-eval-runs `runs/2026-11-05_judge-haiku-vs-opus`): it agreed on 57 of 57 comments of a light run and 192 of 195 of a heavy one, and the three it read differently were near-duplicate golden issues. Opus 5.5 through this same code agreed with the earlier Opus judge on all 252.

**The lines.** The dump holds every point the run reached (`RECALL_STAGES`):
- `finder`: every candidate the finder's passes produced, before the verify, with the pass it came from (`generalist`, `synthesis-rescue`, `lens-*`);
- `verify`: what the verify kept;
- `shipped`: what the review hands to posting.

Each line is scored from the same judgments, so the lines of one run compare directly.

**Bench clones.** The judge reads the code at the PR's head from the benchmark clones (`$BENCH_REPOS_ROOT`, default `~/projects/benchmark`, `evals/shared/bench-repos.js`), by git, without checking anything out.

Output under `--out` (default `<dump>/gold-v3`): `result.json` (per case and pooled, per line and per pass), `summary.md`, and `judge/<caseId>.json` (the judgments, reused while the comments, the issues and the rule are unchanged).
