---
name: change-kody-rule-status
description: Kody Rule Status Guidelines - Use when the user wants to pause, resume or delete existing Kody Rules.
---

# Kody Rule Status Guidelines

## Overview

- `pause`: the rule stays in the list but reviews stop enforcing it. Reversible.
- `resume`: a paused rule is enforced again.
- `delete`: the rule is removed. When the user only wants a rule to stop firing, offer `pause` first.

These subcommands need a logged-in user (`kodus auth login`). With a team key they fail with an auth error: tell the user to log in, do not retry.

## Workflow

1. **Identify the rules**: get each rule `uuid`. If the user described a rule instead, list the rules (`kodus rules view --repo-id <id> --json`), pick the matching ones and confirm them with the user, by title, before changing anything.

2. **Confirm deletes**: always confirm with the user before `delete`, naming the rules by title.

3. **Run the command**: one or several rules at once; repeat `--uuid` or comma-separate.

```
kodus rules pause --uuid <uuid> [--uuid <uuid>] [--team <team>] [--json]
kodus rules resume --uuid <uuid> [--uuid <uuid>] [--team <team>] [--json]
kodus rules delete --uuid <uuid> [--uuid <uuid>] [--team <team>] [--json]
```

4. **Report the result**: the command returns the changed rules with their new `status`.
    - A `resume` beyond the Free plan cap keeps the rule paused (`lockedByPlan: true` in `--json`); say so instead of reporting it as resumed.

## Centralized Config Context

When centralized config is enabled, the change may come back as centralized PR metadata (`mode: centralized-pr`) instead of changed rules.

In this case:

1. Report the PR URL (and PR number if present).
2. State that the change applies only after the PR is merged and synced.
3. Do not claim the rule is already paused, resumed or deleted.
