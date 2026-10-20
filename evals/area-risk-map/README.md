# Historical code-area map eval

**Answers:** Does the map's bug-evidence ranking put directories changed by later PRs linked to bug-labeled issues in its top 20%, compared with ranking the same areas by churn?

**Runs:** `node evals/area-risk-map/run.js --set=development` for the tuning period; `node evals/area-risk-map/run.js --set=holdout-2026 --output=/tmp/area-risk-map-result.json` for the verified later period. The deterministic runner calls production's map builder and ranking function; it makes no model calls.

**Gate:** `targets.json` remains unset until an acceptance floor is chosen. Exit 2 means fewer than 200 held-out PRs with linked bug-labeled issues and complete file listings.

**Cost:** Zero model tokens. `collect.py` makes GitHub API calls when refreshing the frozen public corpus.

The development collection queries merged PRs with each repository's `bug` label from January through June 2025, with at most 100 merged historical PRs per repository from October through December 2024. The 2026 holdout uses 657 bug-labeled target PRs from January through September 2026 and 400 sampled historical PRs from July through December 2025. GitHub closing-issue references verify 234 targets as linked to bug-labeled issues; only those count in the metric. The history sample has 43 PRs linked to bug-labeled issues. All targets occur after their history window. These are **partial history samples**, and a linked issue is evidence of a bug fix, not independent confirmation of the exact affected directory. The approval eval uses independent human labels.

The [measured 2026 run](results/holdout-2026.json) has directory recall at top 20% of **475/839 (56.6%)** for bug evidence and **471/839 (56.1%)** for churn. At the easier PR-level any-area metric, both are 224/234. This small difference does not establish a useful advantage over churn. `knownAreaCases` reports how many targets touched at least one sampled area (233/234). No quality floor or shipping threshold has been set.

Run `python3 evals/area-risk-map/collect.py` to rebuild `cases.json`; add `--holdout-2026` for the verified holdout (the script reuses existing fetched cases). Then run `python3 evals/area-risk-map/verify-target-links.py cases-holdout-2026.json` to attach linked bug issue URLs. The corpus records source PR and issue URLs, with no copied code diff.
