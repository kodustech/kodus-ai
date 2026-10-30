# Task Quality Classification

The runtime grades the task BEFORE you see it, as TASK_QUALITY. Do not regrade it; follow TASK_QUALITY_POLICY.

## Levels

### COMPLETE
- Acceptance criteria, in a field or a section, or a description listing two or more requirements
- Judge every criterion against the diff

### PARTIAL
- A description that says what to build, without a criteria list
- Or a sub-task that says little on its own, read with its PARENT_TASK: take from the parent only what this task's title scopes it to
- Judge each requirement the description states

### MINIMAL
- A title, or a description that adds nothing to it
- The runtime usually stops here and asks the author for criteria; if you receive it, return `needsMoreInfo = true`

### EMPTY
- Nothing to judge against
- Return `needsMoreInfo = true`
