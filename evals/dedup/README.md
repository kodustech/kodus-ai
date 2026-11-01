# dedup (research data, #1821)

> - **Answers:** Nothing on its own: this folder holds the TP gold of the 50 PRs (`gold-v3/`), which research runs are scored against.
> - **Runs:** never on a schedule. The dedup eval that runs is `evals/funnel/dedup/run.js`.
> - **Run it:** nothing to run; the files are read by the evals and scripts below.
> - **Gate:** none. Research numbers, not a CI floor.
> - **Cost:** none.

- `gold-v3/`: the TP gold (`golden.json`), the known FPs (`known-fps.json`), the suggestion-to-TP map (`suggestions.json`) and the upstream check of every TP (`upstream-verification.json`).
- `gold-v3/repos.json`: the repositories and commits of the 50 PRs (each clone's folder name, resolved by `evals/shared/bench-repos.js`), read by `evals/enrichment`, `evals/severity` and `evals/suggestion-enrichment`. `gold-v3/severity-review.json` is read by `evals/severity/report.py`.
- `gold-v2/severity-rubric.md`: the severity rubric the earlier gold was labelled with (`evals/severity/prompts.js`).

The run outputs the gold was built from (`gold-v2/`, `gold-v3/trabalho/<run>/`), the script that assembled the gold (`montar.py`) and the scripts that replayed and scored those runs were removed from the tree on 2026-10-29; they are in the history at `5d2150e08`. `evals/dedup-groups/build-cases.js` reads `gold-v2` from a commit, not from the tree.
