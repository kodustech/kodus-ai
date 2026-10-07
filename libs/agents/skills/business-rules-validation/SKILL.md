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
              examples: Jira, Atlassian Rovo, Linear, Notion, ClickUp, Github Issues, Git Issues
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

Submit the result by calling the `submitValidation` tool exactly once. If you cannot call tools, answer with the same object as a single JSON object and no text outside it.

```json
{
  "needsMoreInfo": false,
  "requirements": [
    {
      "requirement": "quoted from the task",
      "source": "AC #1",
      "state": "met | partial | missing | check_manually",
      "kind": "behavior | visual | flow",
      "topic": "empty_and_error_states | permissions | default_values | validation | audit_and_logging | data_and_persistence | notifications | ui_and_copy | integrations | performance | other",
      "evidence": [{ "file": "src/settings/density.ts", "line": 14 }],
      "note": "what the diff does or lacks, in USER LANGUAGE",
      "action": "for partial or missing: the change to make, in USER LANGUAGE",
      "confidence": "high | medium | low"
    }
  ],
  "outOfScope": [
    { "change": "what the diff changes that the task doesn't ask for", "evidence": [{ "file": "...", "line": 88 }], "action": "revert it, or reference the task that asks for it" }
  ],
  "scopeMismatch": false,
  "confidence": "high | medium | low",
  "summary": "one sentence on the result, in USER LANGUAGE"
}
```

Kodus renders the PR comment, the check and the CLI output from `requirements` and `outOfScope`; write nothing else for people to read.

- One entry per requirement, in the order the task lists them: every acceptance criterion, then any requirement of FULL_TASK_CONTEXT the criteria leave out.
- `met`: the diff implements it. Give the `evidence` that shows it.
- `partial`: the diff implements part of it. Say in `note` which part is missing.
- `missing`: no evidence in this PR diff. Say so in `note`; never claim how the rest of the system behaves.
- `check_manually`: a requirement about how something looks or flows (set `kind` to `visual` or `flow`), or one the diff can't show either way. It never fails the PR.
- `confidence: low` when you are guessing. A low-confidence gap is shown as CHECK MANUALLY, not MISSING.
- `outOfScope`: changes the task doesn't ask for. Leave out refactors, tests and wiring that serve a requirement.
- `scopeMismatch: true` only when the whole diff works on a different domain than the task.
- `requirement` is quoted from the task in its own language; `note`, `action`, `change` and `summary` are in USER LANGUAGE. Enum values stay in English.

### When `needsMoreInfo = true`

Only when the task, read in full, still says nothing the code can be checked against. Set `missingInfo` to what is missing and how to add it, in USER LANGUAGE, and `confidence` to `low`. Leave `requirements` empty.

## Language

Respond in the user's configured language. Default to English (`en-US`) if no preference is set.
Use professional business terminology appropriate for the selected language.
Write all generated prose, headings, status labels, findings, explanations, and suggested actions in `USER LANGUAGE`.
Only quoted requirement text copied from the task may remain in the original source language.
Do not mix languages in generated prose.

See the reference files for detailed output examples and quality classification rules.
