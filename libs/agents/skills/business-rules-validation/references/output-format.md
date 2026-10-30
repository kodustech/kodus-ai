# Output Format Reference

## One verdict per requirement

Each entry in `requirements` carries:

- **requirement**: quoted from the task, in the task's language
- **source**: where in the task (`AC #2`, `Description`)
- **state**: `met` | `partial` | `missing` | `check_manually`
- **evidence**: `file` and `line` in PR_DIFF that show it, or show the gap
- **note**: what the diff does or lacks for it
- **action**: for `partial` and `missing`, the change to make
- **confidence**: `high` | `medium` | `low`
- **kind**: `behavior` (default), `visual` or `flow`
- **topic**: the area it is about

Use evidence wording:

- Prefer `No evidence in this PR diff of ...`
- Avoid `The system still...` or `The backend still...` unless that behavior appears in the diff

## Example: a gap, a partial, a visual check and an unrelated change

Task AB#8 asks for a compact density toggle: it persists per user, defaults to comfortable, shows in the user menu on all screen sizes and sits in the list toolbar.

```json
{
  "needsMoreInfo": false,
  "requirements": [
    {
      "requirement": "The density choice persists per user",
      "source": "AC #1",
      "state": "met",
      "topic": "data_and_persistence",
      "evidence": [{ "file": "src/settings/density.ts", "line": 14 }],
      "note": "Saves the choice to the user profile.",
      "confidence": "high"
    },
    {
      "requirement": "Defaults to comfortable",
      "source": "AC #2",
      "state": "missing",
      "topic": "default_values",
      "evidence": [{ "file": "src/settings/density.ts", "line": 6 }],
      "note": "Sets \"compact\" as the default.",
      "action": "Change the default to \"comfortable\".",
      "confidence": "high"
    },
    {
      "requirement": "The choice is shown in the user menu on all screen sizes",
      "source": "AC #3",
      "state": "partial",
      "topic": "ui_and_copy",
      "evidence": [{ "file": "src/components/UserMenu.tsx", "line": 31 }],
      "note": "Shown only in the desktop menu.",
      "action": "Add the toggle to the mobile menu too.",
      "confidence": "medium"
    },
    {
      "requirement": "The toggle is visible in the list toolbar",
      "source": "AC #4",
      "state": "check_manually",
      "kind": "visual",
      "topic": "ui_and_copy",
      "note": "Placement can't be confirmed from the code; check it in the preview.",
      "confidence": "medium"
    }
  ],
  "outOfScope": [
    {
      "change": "Changes the list pagination size",
      "evidence": [{ "file": "src/tickets/TicketList.tsx", "line": 88 }],
      "action": "Revert it, or reference the task that asks for it (e.g. AB#9)."
    }
  ],
  "scopeMismatch": false,
  "confidence": "high",
  "summary": "One requirement is missing and one is partial."
}
```

## Example: the PR works on something else

```json
{
  "needsMoreInfo": false,
  "requirements": [
    {
      "requirement": "Rules are resolved by organization and team",
      "source": "Description",
      "state": "missing",
      "topic": "permissions",
      "note": "No evidence in this PR diff of changes to rule resolution; the diff only touches the billing page layout.",
      "action": "Implement the task in this PR, or reference the task this PR belongs to.",
      "confidence": "high"
    }
  ],
  "outOfScope": [],
  "scopeMismatch": true,
  "confidence": "medium",
  "summary": "The PR changes the billing page, not rule resolution."
}
```

## Example: nothing to check against

```json
{
  "needsMoreInfo": true,
  "requirements": [],
  "confidence": "low",
  "missingInfo": "The task says only \"Export notes\". Add what format the export uses and what it includes (for example: \"exports as CSV\", \"includes archived notes\").",
  "summary": "The task has nothing the code can be checked against."
}
```
