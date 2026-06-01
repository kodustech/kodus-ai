# Promptfoo Evals

This directory no longer contains the legacy v2 code-review eval suite.

Retained here:
- memory eval assets
- memory quality eval assets
- session capture notes

Removed from this path:
- legacy code-review scripts
- promptfoo code-review provider based on the deprecated v2 prompt path
- v2 code-review datasets, assertions, and report tooling

Current guidance:
- use `evals/cross-file/` for the existing planner, sufficiency, and enrichment evals
- use `evals/investigation/` for the current-engine review eval scaffold

If you are looking for the old code-review promptfoo flow, it was intentionally deleted because it was tied to the deprecated v2 prompt path and was no longer representative of the active review engine.
