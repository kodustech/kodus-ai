# Output Format Reference

## Finding Structure

Each finding MUST include:
- **Severity**: MUST_FIX | SUGGESTION | INFO
- **What**: What is missing, wrong, or risky
- **Evidence (Task)**: Requirement excerpt that supports the finding
- **Evidence (Code)**: Diff excerpt or explicit absence in diff
- **Action**: Concrete change expected from the developer

Use evidence wording:
- Prefer `No evidence in this PR diff of implementing...`
- Prefer `This PR diff does not show changes in the area required by the task`
- Avoid `The system still...` or `The backend still...` unless that behavior appears in the diff

## Severity Rules

- **MUST_FIX**: A required business rule is not implemented, is incorrect, or contradicts task requirements.
- **SUGGESTION**: A relevant edge case, robustness, or maintainability point is not covered.
- **INFO**: Useful observation that does not block compliance.

## Example: Gaps Found

```json
{
  "needsMoreInfo": false,
  "mode": "full_analysis",
  "reason": "analysis_ready",
  "taskContextStatus": "usable",
  "prDiffStatus": "usable",
  "confidence": "high",
  "summary": "## Business Rules Validation\n\n**Task:** KC-1441 - Team-scoped Kody rules\n**Task Link:** https://kodustech.atlassian.net/browse/KC-1441\n**Status:** Issues Found\n**Confidence:** high\n\n### Findings\n\n#### MUST_FIX: No evidence of team-scoped rule resolution in this PR diff\n**Requirement:** \"Rules must be resolved by organization and team to avoid cross-workspace billing mismatch.\"\n**Missing in code:** No evidence in this PR diff of adding `teamId` to the relevant persistence or lookup path.\n**Evidence (Code):** The diff does not show changes in the rule-resolution area required by the task.\n**Suggested action:** Add `teamId` to rule persistence and query filters, plus migration/backfill strategy.\n\n#### SUGGESTION: No evidence of deterministic mixed-license handling in this PR diff\n**Requirement:** \"When teams have different subscription states, behavior must remain deterministic.\"\n**Missing in code:** No evidence in this PR diff of logic handling mixed subscription states.\n**Evidence (Code):** The diff does not show changes in the billing/license decision path required by the task.\n**Suggested action:** Add deterministic fallback and clear error handling scoped to team.\n\n#### INFO: Migration impact not addressed in this PR diff\n**Requirement:** \"Assess side effects before changing rule model.\"\n**Observation:** This PR diff does not show migration notes or rollout handling for the task scope.\n**Suggested action:** Add migration notes and rollout steps in the PR description or implementation plan.\n"
}
```

## Example: Scope Mismatch

```json
{
  "needsMoreInfo": false,
  "mode": "full_analysis",
  "reason": "analysis_ready",
  "taskContextStatus": "usable",
  "prDiffStatus": "usable",
  "confidence": "medium",
  "summary": "## Business Rules Validation\n\n**Task:** KC-1441 - Kody rules por time\n**Task Link:** https://kodustech.atlassian.net/browse/KC-1441\n**Status:** Issues Found\n**Confidence:** medium\n\n### Findings\n\n#### MUST_FIX: PR scope does not match the task scope\n**Requirement:** \"Atualmente as kodyRules são cadastradas somente com organizationId\" and \"fica imprevisível de qual time ele vai buscar a configuração de billing\"\n**Missing in code:** No evidence in this PR diff of changes related to `kodyRules`, `teamId`, or billing/license resolution by team.\n**Evidence (Code):** The diff is focused on a different area of the product and does not show changes in the domain required by the task.\n**Suggested action:** Update the PR with the actual implementation for the task scope, or link the correct task if this PR is unrelated.\n"
}
```

## Example: All Compliant

```json
{
  "needsMoreInfo": false,
  "mode": "full_analysis",
  "reason": "analysis_ready",
  "taskContextStatus": "usable",
  "prDiffStatus": "usable",
  "confidence": "high",
  "summary": "## Business Rules Validation\n\n**Task:** KC-1441 - Team-scoped Kody rules\n**Task Link:** https://kodustech.atlassian.net/browse/KC-1441\n**Status:** Compliant\n**Confidence:** high\n\n### Findings\n\n#### INFO: Requirements covered\n**Requirement:** Team-scoped rule resolution and deterministic billing behavior.\n**Missing in code:** None.\n**Evidence (Code):** Diff adds `teamId` in persistence, lookups, and conflict checks.\n**Suggested action:** None.\n\n### Requirements Verified\n- Team-scoped rule reads/writes now include `organizationId + teamId`.\n- Multi-workspace billing path is deterministic.\n- Backward compatibility path is present for legacy records.\n"
}
```

## Example: Needs More Info

```json
{
  "needsMoreInfo": true,
  "mode": "limitation_response",
  "reason": "task_context_weak",
  "taskContextStatus": "weak",
  "prDiffStatus": "usable",
  "confidence": "low",
  "missingInfo": "## Need Task Information\n\nI could not validate business rule compliance because the task context is too vague.\n\n### What I need to validate:\n- Explicit business requirements or acceptance criteria\n- Scope boundaries (which teams/workspaces are affected)\n- Expected behavior for edge cases (inactive subscription, missing team binding)\n\n### Examples of how to provide it:\n- Link the Jira/Linear/Notion task with acceptance criteria\n- Paste the business rules directly in the PR comment\n- Add expected input/output behavior for key scenarios\n\n### Important:\nWithout requirement-level context, validation would be speculative and unreliable.",
  "summary": "## Need Task Information\n\nI could not validate business rule compliance because the task context is too vague.\n\n### What I need to validate:\n- Explicit business requirements or acceptance criteria\n- Scope boundaries (which teams/workspaces are affected)\n- Expected behavior for edge cases (inactive subscription, missing team binding)\n\n### Examples of how to provide it:\n- Link the Jira/Linear/Notion task with acceptance criteria\n- Paste the business rules directly in the PR comment\n- Add expected input/output behavior for key scenarios\n\n### Important:\nWithout requirement-level context, validation would be speculative and unreliable."
}
```
