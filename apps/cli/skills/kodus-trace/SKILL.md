---
name: kodus-trace
description: Use when starting work in an area of the codebase, to recall prior decisions about why code was written that way. Call `kodus trace <paths>` before editing files so intentional tradeoffs are not undone.
---

# Kodus Trace

## Goal

Before editing files, load the decisions that previous agents (and humans) recorded about those paths. Decision memory explains *why* the code looks the way it does.

## When to use

- Starting a task that touches existing modules
- User asks "why was this written this way?"
- Before a large refactor in an area with prior agent work
- After `kodus trace enable` is configured in the repository

## Workflow

1. Ensure Kodus CLI is available (`kodus --help`).

2. Recall decisions for the paths you are about to touch:

```bash
kodus trace src/billing/invoice.ts src/billing/
```

Paths are positional on the group. Registered subcommands (`enable`, `status`, `forget`, `pin`, `ui`, `disable`) always win over path ambiguity; use `--` to force a path that collides with a subcommand name.

3. Read the output. Each decision has an id, type, confidence, and optional rationale/paths.

4. If a decision is wrong, remove it:

```bash
kodus trace forget <id>
```

5. If a decision must always survive review context budgeting:

```bash
kodus trace pin <id>
```

6. Optional: open the local UI for session browsing (no auth, localhost only):

```bash
kodus trace ui
```

## Notes

- Recall is path-keyed (exact/prefix). There is no semantic or embedding search.
- Works offline against `~/.kodus/sessions/` and the orphan branch `kodus/trace/v1`.
- Empty output with exit 0 means nothing was recorded yet — not an error.
- Setup once per repo with `kodus trace enable` (installs agent hooks + push refspec).
