---
name: kodus-pr-suggestions-resolver
description: Use when the user wants to fetch, triage, or implement Kodus suggestions for an existing remote pull request via `kodus pr suggestions`, `--pr-url`, or `--pr-number`.
---

# Kodus PR Suggestions Resolver

## Overview

Fetch PR suggestions via Kodus CLI, triage each suggestion against the PR goal, apply safe fixes, then validate with build/tests and report results.

## Workflow

### 1) Collect the PR target

- If the user did not provide a target, ask for one of:
    - `--pr-url <url>`
    - `--pr-number <number>` with `--repo-id <id>`
- If multiple are provided, prefer `--pr-url`.

### 2) Run Kodus suggestions

Use:

```
kodus pr suggestions --pr-url <url>
```

Or when the URL is not available:

```
kodus pr suggestions --pr-number <number> --repo-id <id>
```

### 3) Analyze suggestions with PR intent in mind

- Extract or confirm the PR goal from the user or PR context.
- For each suggestion:
    - Verify it does not conflict with the PR objective.
    - Prefer small, low-risk changes that improve the PR without changing scope.
    - Skip suggestions that are irrelevant, risky, or scope-expanding; note why.

### 4) Apply fixes one by one

- Make changes per accepted suggestion.
- Keep edits minimal and focused.
- If a suggestion is unclear, ask a clarifying question before changing code.

### 5) Validate with build/tests (when available)

- Run the most relevant build or tests for the edited area.
- If no tests are available or running them is not possible, state that explicitly.

### 6) Report results

Provide a concise report covering:

- Suggestions applied (with brief rationale).
- Suggestions skipped (with reasons).
- Tests/builds run and outcomes.
- Remaining uncertainties or follow-ups needed.
