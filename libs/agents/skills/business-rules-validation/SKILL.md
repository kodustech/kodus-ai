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

Say, requirement by requirement, whether this pull request delivers what its task asks. Find what is **missing**, **forgotten** or **half done**, grounded in the task's own words.

## Input (pre-fetched in the user prompt)

- **TASK**: the task's id and title. **TASK_LINKS**: where it lives.
- **ACCEPTANCE_CRITERIA**: numbered, from the task's criteria field or section, or extracted from its description.
- **FULL_TASK_CONTEXT**: everything the task says. A document attached to the task appears in it under `## Document: <title>`: it is part of the task's spec.
- **PARENT_TASK** (only when the task is a sub-task): the larger task it is part of. Context, not this task's requirements.
- **SUB_TASKS** (only when the task is split): the pieces delivered on their own, by id, title and status.
- **PR_DIFF**: the code changes. **FILES_NOT_SHOWN**: changed files too large to include.
- **PR_DESCRIPTION**: the author's words. A secondary hint; it never overrides the diff.
- **TASK_QUALITY** and **TASK_QUALITY_POLICY**: how much the task says, graded by the runtime. Do not regrade it.
- **TEAM_GUIDANCE** (optional): how this team wants requirements judged.

## Grounding Rules (MANDATORY)

Every requirement you list must be traceable to the task.

- **Quote the source**: `requirement` is the task's own text. If you cannot quote it, it is not a requirement: leave it out.
- **No invented requirements**: nothing from "common sense" or "best practice" that the task does not write.
- **Evidence wording only**: when the diff does not show a requirement, say there is no evidence of it in this PR diff. Never claim how the rest of the system behaves: you see the task and the diff, not the codebase.
- **The parent is not this task**: from PARENT_TASK take only what this task's title and FULL_TASK_CONTEXT scope it to, with `source` "Parent". The rest belongs to the parent's other pieces.
- **A sub-task's work is not a gap here**: a requirement one of SUB_TASKS covers (by its title) that this diff does not implement is `check_manually`, with `note` starting "Delivered by <id>:".
- **Scope mismatch is valid**: when the whole diff works on a different domain than the task, set `scopeMismatch: true`. It is not a `needsMoreInfo` case.

## Analysis Method

1. Read the task's intent: the business problem, the entities involved, the behavior that should change.
2. Read the PR's intent from the changed files, symbols and behavior in PR_DIFF.
3. For each requirement, in the order the task lists them (every acceptance criterion, then any requirement of FULL_TASK_CONTEXT the criteria leave out): search PR_DIFF for the code that delivers it and set its `state`.
4. Scan PR_DIFF for code that contradicts a requirement (a `partial` or `missing` with a `note` saying what conflicts), and for changes the task does not ask for (`outOfScope`).

## Critical Analysis Questions

- Which acceptance criteria have no code in this diff?
- Which validation rules, edge cases, permissions or defaults the task names were forgotten?
- Which requirements are implemented only in part, or misread?
- Is the right conclusion "no evidence in this PR diff", rather than a claim about the system?

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

Write `note`, `action`, `change`, `summary` and `missingInfo` in USER LANGUAGE (default `en-US`), in plain professional terms. `requirement` stays quoted in the task's own language; enum values stay in English. Do not mix languages in one field.

See the reference files for detailed output examples and quality classification rules.
