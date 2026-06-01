---
name: update-kody-rule
description: Kody Rule Update Guidelines - Use when the user wants to update an existing Kody Rule to modify its behavior, scope, or severity for Kodus to follow when generating code.
---

# Kody Rule Update Guidelines

## Overview

When updating an existing Kody Rule, it's important to ensure that the changes are clear, justified, and aligned with the overall goals of code generation. Updating a Kody Rule can help refine its effectiveness and ensure that it continues to meet the user's expectations and project requirements.

## Workflow for Updating a Kody Rule

1. **Identify the Kody Rule to Update**:
    - If the user specified a specific `uuid` of the Kody Rule they want to update, use it to identify the rule.
    - If the user described the rule to update without providing a `uuid`, list all rules (or filter by repository if specified), select the most relevant one based on the description, and confirm with the user that this is the correct rule to update before proceeding.
    - Otherwise, ask the user to specify the rule they want to update by providing its `uuid` or a clear description that can be used to identify it. Emphasize that `uuid` is the most reliable way to identify the rule for updating.

2. **Collect the user's intent for the update**: Understand the specific changes the user wants to make to the existing Kody Rule. Ask clarifying questions if necessary to ensure you have a clear understanding of the user's intent.

3. **Review the existing Kody Rule**: Retrieve the current definition of the Kody Rule that is being updated. This will help you understand the existing behavior and identify what changes need to be made.

4. **Draft the updated Kody Rule**: Based on the user's intent and the existing rule, draft an updated version of the Kody Rule that includes the desired changes. Use the guidelines outlined in the "Guidelines for Updating a Kody Rule" section to ensure the updated rule is well-structured and effective.

5. **Review the updated Kody Rule with the user**: Present the drafted updated Kody Rule to the user for feedback. Discuss any potential edge cases, exceptions, or clarifications needed to ensure the updated rule is comprehensive and actionable.

6. **Refine the updated Kody Rule**: Based on the user's feedback, refine the updated Kody Rule to address any concerns or suggestions. Ensure that the final version of the updated rule is clear, specific, and aligned with the user's goals.

7. **Save and Implement the updated Kody Rule**: Once the updated Kody Rule is finalized and approved by the user, save it. Send only the fields that were updated, along with the `uuid` to identify which rule to update.

Use the following command to save the updated Kody Rule:

```
kodus rules update --uuid <uuid> [--repo-id <repository-id>] [--title <title>] [--rule <rule-content>] [--severity <severity-level>] [--scope <scope-level>] [--path <glob-pattern>]
```

8. **Communicate the updated Kody Rule**: Inform the user about the updated Kody Rule and how the changes will affect future code generation.

## Centralized Config Behavior

When centralized config is enabled, updating a rule may return centralized PR metadata instead of an immediate rule update.

In this case, report PR details and clarify the update is pending until PR merge and sync.

## Guidelines for Updating a Kody Rule

1. **Identify the Changes**: Clearly define what changes are being made to the existing Kody Rule. Are you modifying the rule's behavior, scope, severity, or other attributes?

2. **Justify the Changes**: Ensure that there is a clear justification for the changes being made to the Kody Rule. The updates should contribute to producing code that is more maintainable, efficient, or better aligned with the user's needs.

3. **Consider Edge Cases**: Think about any edge cases or exceptions that might arise from the updated rule. Address these in the updated rule definition to ensure Kody can handle them appropriately.

4. **Align with Project Goals**: Ensure that the updated Kody Rule continues to align with the overall goals and requirements of the project. The updated rule should contribute to producing code that meets the user's expectations and project requirements.

5. **Review and Refine**: After drafting the updated Kody Rule, review it for clarity and completeness. Present it to the user for feedback and refine it as necessary to ensure it effectively guides Kody's code generation process.
