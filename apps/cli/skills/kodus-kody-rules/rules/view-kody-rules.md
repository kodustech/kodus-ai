---
name: view-kody-rules
description: Kody Rule Viewing Guidelines - Use when the user wants to view existing Kody Rules that Kodus follows when generating code.
---

# Kody Rule Viewing Guidelines

## Overview

When viewing existing Kody Rules, it's important to understand the details of each rule, including its UUID, title, rule content, severity, scope, and any applicable file patterns. This information helps you understand how Kody generates code and what guidelines it follows.

## Workflow for Viewing Kody Rules

1. **Retrieve Rule Target**: Specific rules can be retrieved by their `uuid`. Otherwise you can list all rules or filter them by their `repositoryId`.
   This can be achieved with the following options:
    - `--uuid <uuid>`
    - `--repo-id <repository-id>`

2. **Fetch Kody Rules**: Use the appropriate command to fetch the Kody Rule(s) based on the identified target(s). If no specific rule was requested, fetch all existing Kody Rules.

Use the following command to fetch Kody Rules:

```
kodus rules view [--repo-id <repository-id>] [--uuid <uuid>]
```

3. **Display Kody Rules**: Present the retrieved Kody Rule(s) in a clear and organized manner. For each rule, display the following information:
    - Rule UUID
    - Repository ID
    - Rule Title
    - Rule
    - Severity
    - Scope
    - Path

Do not alter the content of the rules; display them as they are retrieved to ensure accuracy.

4. **Provide Context**: If the user is viewing a specific rule, provide additional context about how that rule is applied in code generation and any relevant examples or use cases.

5. **Answer Follow-up Questions**: Be prepared to answer any follow-up questions the user may have about the Kody Rules, such as how to create or update rules, or how specific rules affect code generation.

## Centralized Config Context

When centralized config is enabled, rules may include centralized pending state metadata.

When relevant, surface centralized path and status, and clarify that pending centralized changes apply only after PR merge and sync.

## Guidelines for Viewing Kody Rules

1. **Be Accurate**: When displaying Kody Rules, ensure that the information is accurate and reflects the current state of the rules as retrieved from the system.

2. **Be Clear**: Present the Kody Rules in a clear and organized manner, making it easy for the user to understand the details of each rule.

3. **Provide Context**: When appropriate, provide additional context about how specific Kody Rules are applied in code generation and how they affect the output.

4. **Be Responsive**: Be prepared to answer any follow-up questions the user may have about the Kody Rules, and provide helpful information to guide them in understanding and utilizing the rules effectively.
