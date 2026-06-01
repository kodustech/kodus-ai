---
name: create-kody-rule
description: Kody Rule Creation Guidelines - Use when the user wants to create a new Kody Rule for Kodus to follow when generating code.
---

# Kody Rule Creation Guidelines

## Overview

When creating a new Kody Rule, it's important to ensure that the rule is clear, actionable, and aligned with the overall goals of code generation. A well-defined Kody Rule helps Kody produce code that meets the user's expectations and project requirements.

## Workflow for Creating a Kody Rule

1. **Collect the user's intent**: Understand the specific coding practice, style, or requirement that the user wants to enforce with the new Kody Rule. Ask clarifying questions if necessary to ensure you have a clear understanding of the user's intent.

2. **Draft the Kody Rule**: Based on the user's intent, draft a Kody Rule that includes a clear description, title, and any relevant metadata such as severity and scope. Use the guidelines outlined in the "Guidelines for Creating a Kody Rule" section to ensure the rule is well-structured and effective.

3. **Review the Kody Rule with the user**: Present the drafted Kody Rule to the user for feedback. Discuss any potential edge cases, exceptions, or clarifications needed to ensure the rule is comprehensive and actionable.

4. **Refine the Kody Rule**: Based on the user's feedback, refine the Kody Rule to address any concerns or suggestions. Ensure that the final version of the rule is clear, specific, and aligned with the user's goals.

5. **Save and Implement the Kody Rule**: Once the Kody Rule is finalized and approved by the user, save it. Send the title, rule, and any optional fields such as severity, scope, and path.

Always include the repository id when creating a rule. Use `global` when the user does not provide one.

Use the following command to save the Kody Rule:

```
kodus rules create --title <title> --rule <rule-content> [--repo-id <repository-id>] [--severity <severity-level>] [--scope <scope-level>] [--path <glob-pattern>]
```

If `--repo-id` is omitted, the default repository id is `global`.

6. **Communicate the new Kody Rule**: Inform the user about the new Kody Rule and how it will be applied in future code generation.

## Centralized Config Behavior

When centralized config is enabled, creating a rule may return a centralized PR result instead of a directly persisted rule.

In this case:

1. Report the PR URL (and PR number if present).
2. State that the rule is pending and will be applied after PR merge and sync.
3. Do not present the rule as already created in the database.

## Guidelines for Creating a Kody Rule

1. **Identify the Purpose**: Clearly define what the Kody Rule is intended to achieve. Is it meant to enforce a coding style, ensure best practices, or address a specific use case?

2. **Be Specific**: The rule should be specific and unambiguous. Avoid vague language and ensure that the rule can be easily understood and applied by Kody.

3. **Consider Edge Cases**: Think about any edge cases or exceptions that might arise when applying the rule. Address these in the rule definition to ensure Kody can handle them appropriately.

4. **Align with Project Goals**: Ensure that the Kody Rule aligns with the overall goals and requirements of the project. The rule should contribute to producing code that is maintainable, efficient, and meets the user's needs.

5. **Review and Refine**: After drafting the Kody Rule, review it for clarity and completeness. Present it to the user for feedback and refine it as necessary to ensure it effectively guides Kody's code generation process.
