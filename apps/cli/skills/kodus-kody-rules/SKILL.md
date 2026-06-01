---
name: kodus-kody-rules
description: Use when the user wants to create, update or view Kody Rules via `kodus rules` command.
---

# Kodus Kody Rules

## Overview

Kody Rules are a set of guidelines that Kody follows when generating code. They help ensure that the generated code is consistent, high-quality, and aligned with the user's preferences and project requirements.

## Goal

Manage Kody Rules through Kodus CLI only. Do not suggest creating rule files manually.

ALWAYS Use `kodus rules` subcommands for all create, update, and view operations. All these rules are ALWAYS managed by the `kodus rules` command from the CLI. Do NOT suggest creating files or storing rules in any other way. When the user wants to create, update or view Kody Rules, utilize the `kodus rules` command with the appropriate subcommands and options as outlined in the instructions files.

## Centralized Config Convention

When centralized config is enabled for the selected team/repository scope, `kodus rules create` and `kodus rules update` may return centralized PR metadata instead of directly created/updated rule records.

- Treat this as success, not failure.
- Prioritize reporting `prUrl` (and `prNumber` when available).
- Explain that the change is pending until the centralized PR is merged and synced.
- Do not claim a rule was directly persisted when the result is centralized PR mode.
- When output includes both direct results and centralized PR metadata, prefer communicating the centralized PR outcome.

## Shared Workflow

1. Confirm the requested action:

- `create`: add a new rule.
- `update`: modify an existing rule.
- `view`: list all rules or fetch a specific rule.

2. Resolve repository scope:

- Use `global` when the user does not provide a repository scope. Always confirm if the user intends to use `global` scope when no repository is specified.
- For repository-specific requests with unknown id, run:

```bash
kodus config remote list --json
```

Then select and pass `--repo-id <id>`.

3. Validate rule fields before running commands:

- `title`: short and specific.
- `rule`: clear and actionable guidance.
- `severity`: `low | medium | high | critical`.
- `scope`: `file | pull request`.
- `path`: optional glob, default effectively `**/*`.

4. Execute the proper command and report results clearly.

## How to Use

Read individual instructions files for detailed explanations and examples:

- [instructions/create-kody-rule.md](instructions/create-kody-rule.md): Guidelines for creating new Kody Rules.
- [instructions/update-kody-rule.md](instructions/update-kody-rule.md): Guidelines for updating existing Kody Rules.
- [instructions/view-kody-rules.md](instructions/view-kody-rules.md): Guidelines for viewing and retrieving Kody Rules.

You MUST always load at least one of these instructions files to handle the specific user request related to Kody Rules. Each file contains detailed steps and examples for the corresponding action (create, update, view). Always ensure that you are following the instructions in these files when managing Kody Rules through the `kodus rules` command.

Should the user request an action that is not covered by these instructions, you should first clarify the user's intent and then determine if it falls under create, update, or view operations. If it does, proceed to load the corresponding instructions file to ensure that you are following the correct workflow for managing Kody Rules through the `kodus rules` command.

Should the user request a new action related to Kody Rules that differs from the initial action, you should load the appropriate instructions file for that new action to ensure that you are following the correct workflow for managing Kody Rules through the `kodus rules` command.

## Structure of a Kody Rule

A Kody Rule typically consists of the following components:

- **Repository ID**: The repository scope where the rule is stored and applied.
    - Use `global` for shared rules that apply across all repositories.
- **Title**: A concise title that captures the essence of the rule.
- **Rule**: A detailed explanation of what the rule is and why it is important.
- **Severity**: A level indicating the importance of the rule (one of "low", "medium", "high" or "critical").
    - **Low**: The rule is a suggestion and can be ignored without significant consequences.
    - **Medium**: The rule should be followed, but violations are not critical. Default severity level.
    - **High**: The rule is important and should be followed to avoid potential issues.
    - **Critical**: The rule is essential and must be followed to prevent severe issues or failures.
- **Scope**: The level at which the rule applies (one of "pull request" or "file").
    - **Pull Request**: The rule applies to the entire pull request and is evaluated based on the overall changes in the PR.
    - **File**: The rule applies to individual files and is evaluated on a per-file basis. Default scope level.
- **Path**: An optional glob pattern indicating which files the rule applies to.
    - For example, `src/**/*.js` would apply the rule to all JavaScript files in the `src` directory and its subdirectories.
    - Default is all files, `**/*`.

## Example of a Kody Rule

**Title**: Use Async/Await for Asynchronous Operations

**Rule**: Ensure that all asynchronous operations in the codebase use async/await syntax for better readability and error handling. Avoid using raw Promises or callback functions for asynchronous code.

**Severity**: High

**Scope**: File

**Path**: `**/*.ts`

**Repository ID**: `global`
