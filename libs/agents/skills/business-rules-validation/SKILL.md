---
name: business-rules-validation
description: Validate PR code changes against task requirements to identify missing, forgotten, or overlooked business logic implementations
allowed-tools: KODUS_GET_PULL_REQUEST KODUS_GET_PULL_REQUEST_DIFF
metadata:
    version: '1.0.0'
    kodus:
        capabilities:
            - pr.metadata.read
            - pr.diff.read
            - task.context.read
        capability-definitions:
            pr.metadata.read:
                mode: fixed_tools
                tools: KODUS_GET_PULL_REQUEST
            pr.diff.read:
                mode: fixed_tools
                tools: KODUS_GET_PULL_REQUEST_DIFF
            task.context.read:
                mode: provider_dynamic
        fetcher-policy:
            tool-mode: any
            allow-without-tools: false
        execution-policy:
            on-missing-mcp: fail
            on-mcp-connect-error: fail
            fetcher-timeout-ms: 120000
            analyzer-timeout-ms: 120000
            fetcher-max-iterations: 2
            analyzer-max-iterations: 1
        contracts:
            input:
                required-context-fields:
                    - organizationAndTeamData.organizationId
                    - organizationAndTeamData.teamId
                    - prepareContext.repository.id
            output:
                required-fields:
                    - needsMoreInfo
                    - summary
        required-mcps:
            - category: task-management
              label: Task Management
              examples: Jira, Linear, Notion, ClickUp, Github Issues
---

# Business Rules Gap Analysis

## Goal

Find what is **MISSING**, **FORGOTTEN**, or **OVERLOOKED** — not what is present.
Every validation must be grounded in specific business requirements from the external task.

## Input (pre-fetched in context)

- **TASK_CONTEXT**: Requirements, acceptance criteria, and business rules from the external task management system (Jira, Notion, Linear, etc.)
- **PR_DIFF**: Code changes for this pull request
- **TASK_QUALITY**: `EMPTY` | `MINIMAL` | `PARTIAL` | `COMPLETE` — quality assessment of task context

`TASK_QUALITY` is classified by the runtime deterministic stage. Do not reclassify it.
Apply the task-quality policy exactly as provided in the user prompt.

Mode-specific context notes:

- Pull-request mode requires `prepareContext.pullRequest.pullRequestNumber` when diff is fetched from PR tools.
- Local-diff mode works with `prepareContext.prDiff` and does not require pull request number.

## Grounding Rules (MANDATORY)

Every finding MUST be traceable to a specific requirement from ACCEPTANCE_CRITERIA or FULL_TASK_CONTEXT.

- **Quote the source**: Each finding MUST include the exact text from the task that establishes the requirement. If you cannot quote a specific sentence, the finding is INVALID — remove it.
- **No invented requirements**: Do NOT infer requirements that are not written in the task. "Common sense" or "best practice" findings without task backing are forbidden.
- **No restating the diff**: Findings that describe what the code DOES (instead of what it DOESN'T do) are not findings — they belong in "Implemented Correctly".
- **Specificity over quantity**: 2 grounded findings beat 10 vague ones. Prefer fewer, precise findings over many generic ones.
- **Evidence wording only**: When the diff does not show the required implementation, write findings as absence of evidence in the PR diff. Prefer phrases like `No evidence in this PR diff of implementing requirement X` over claims about the current system state.
- **No hidden-code assumptions**: Do not state current system or backend behavior as fact unless that behavior appears in the PR_DIFF. The analyzer sees the task context and the PR diff, not the entire codebase.
- **Scope mismatch is valid**: If the PR diff is clearly outside the task domain, treat that as a grounded finding. This is a task/PR scope mismatch, not a `needsMoreInfo` case.

## Analysis Method

You will receive ACCEPTANCE_CRITERIA as a numbered list (when available) and FULL_TASK_CONTEXT as raw text.

Before checking detailed gaps, perform an intent comparison:

### Task Intent

- Summarize the primary business problem the task is trying to solve
- Identify the main domain entities involved (for example: rules, billing, team, license, subscription)
- Identify the expected behavioral change

### PR Intent

- Infer the primary implementation intent of the PR from:
    - changed file paths
    - changed symbols
    - changed code behavior visible in the diff
- Use PR_DESCRIPTION only as a secondary hint. Never let PR_DESCRIPTION override the PR_DIFF.

### Alignment

- Classify the relationship between task and PR as one of:
    - `aligned`
    - `partially_aligned`
    - `scope_mismatch`
- If the correct classification is `scope_mismatch`, make that the leading finding before any detailed requirement-by-requirement discussion.

For EACH acceptance criterion:

1. Search the PR_DIFF for code that satisfies it
2. Classify: IMPLEMENTED / MISSING / PARTIAL
3. If MISSING or PARTIAL — create a finding with the exact requirement quote

After checking all criteria, scan PR_DIFF for code that contradicts or misinterprets any requirement.

When the diff appears unrelated to the task:

1. State that there is **no evidence in this PR diff** of implementation for the requirement
2. Explain briefly why the changed files or diff scope appear unrelated
3. Do **not** convert that into an unsupported claim about how the backend/system currently behaves

When task reference details are available:

1. Use the task id/title already provided in the prompt as the canonical task reference
2. If task links are available, you may mention the task link briefly near the top of the summary
3. Keep task reference concise; do not repeat raw metadata blocks

## Critical Analysis Questions

- What is the primary intent of the task?
- What is the primary intent of the PR diff?
- Are those intents aligned, partially aligned, or mismatched?
- What acceptance criteria are **NOT implemented** in the code?
- What **validation rules** from the task were forgotten?
- What **business edge cases** described in the task were overlooked?
- What **security or compliance** requirements from the task are missing?
- What task requirements were **partially implemented** or **misinterpreted**?
- Does this PR diff appear to be working in a different domain than the task itself?
- Is the correct conclusion `missing implementation in this PR diff` rather than `the current system still behaves this way`?

## Output Format

Return a single JSON object. Do not include any text outside the JSON.

```json
{
  "needsMoreInfo": boolean,
  "mode": "full_analysis | limitation_response",
  "reason": "analysis_ready | task_context_missing | task_context_weak | pr_diff_missing",
  "taskContextStatus": "missing | weak | usable",
  "prDiffStatus": "missing | usable",
  "confidence": "low | medium | high",
  "missingInfo": "Legacy compatibility field — optional",
  "summary": "Markdown response for both analysis and limitation outcomes"
}
```

### When `needsMoreInfo = true`

Set:

- `mode = "limitation_response"`
- `confidence = "low"`
- `summary` to a user-friendly explanation explaining what is needed

`missingInfo` may mirror `summary` for backward compatibility.

- Why the task context is insufficient
- What specific information would enable the validation
- How the user can provide it (e.g., link a Jira ticket, add acceptance criteria)

Use this structure in `summary`:

```
## 🤔 Need Task Information

[Main message explaining what's needed]

### 🔍 What I need to validate:
- [bullet points]

### 💡 Examples of how to provide it:
- [practical examples]

### ⚠️ Important:
[Final note]
```

### When `needsMoreInfo = false`

Set:

- `mode = "full_analysis"`
- `reason = "analysis_ready"`
- `taskContextStatus = "usable"`
- `prDiffStatus = "usable"`

Set `summary` to a complete markdown validation report using this structure:

```
## Business Rules Validation

**Task:** [task id and title when available]
**Task Link:** [task link when available]

**Status:** Issues Found / Compliant
**Confidence:** high | medium | low

### Findings

#### MUST_FIX: [finding title]
**Requirement:** "[exact quote from task context that establishes this requirement]" (AC #N or source)
**Missing in code:** [what is absent or wrong in this PR diff — reference file:line when possible]
**Suggested action:** [concrete implementation action]

#### SUGGESTION: [finding title]
**Requirement:** "[exact quote from task context]" (AC #N or source)
**Missing in code:** [what is partially covered or risky in this PR diff]
**Suggested action:** [concrete improvement]

#### INFO: [finding title]
**Requirement:** "[exact quote from task context]" (AC #N or source)
**Observation:** [non-blocking observation]
**Suggested action:** [optional follow-up]

### Requirements Verified
For each acceptance criterion checked, briefly state what code satisfies it:
- AC #1: "[requirement]" → Implemented in `file:line` — [brief explanation]
- AC #2: "[requirement]" → Implemented in `file:line` — [brief explanation]

---
*Analysis performed by Kodus AI Business Rules Validator*
```

Additional output rules:

- Include a short task reference near the top of the summary when task id, title, or link is available.
- If no task requirements were verified from the diff, omit the "Requirements Verified" section entirely.
- If you do not see the implementation in the diff, say `No evidence in this PR diff...`
- If the PR seems unrelated to the task, call out a `scope mismatch` explicitly
- Do not write statements like `the system still uses X` unless the diff itself shows that behavior
- Prefer `This PR diff does not show changes in the area required by the task` over unsupported architecture claims

## Language

Respond in the user's configured language. Default to English (`en-US`) if no preference is set.
Use professional business terminology appropriate for the selected language.
Write all generated prose, headings, status labels, findings, explanations, and suggested actions in `USER LANGUAGE`.
Only quoted requirement text copied from the task may remain in the original source language.
Do not mix languages in generated prose.

See the reference files for detailed output examples and quality classification rules.
