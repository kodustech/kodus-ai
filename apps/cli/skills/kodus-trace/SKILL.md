---
name: kodus-trace
description: Use when about to edit files in an area you have not touched yet, or when the user asks why code is the way it is. Reads the decisions already recorded for those paths via `kodus trace <paths>`, so deliberate tradeoffs are not undone and settled questions are not re-litigated.
---

# Kodus Trace

## Overview

Kodus Trace records the reasoning behind changes — architectural choices,
conventions, tradeoffs, deliberate deferrals — and keys them to the paths they
apply to. Diffs show what changed; trace explains why.

The record covers work done by anyone on the team, not just this session, so it
is the fastest way to find out what a teammate decided about a module months ago.

## When to use this

Call recall **before editing**, not after:

- Before your first edit in a directory you have not touched this session.
- When the user asks why something is the way it is.
- When you are about to "clean up" something that looks wrong — it may be a
  recorded tradeoff.
- When you are choosing between two approaches in an area someone else owns.

Do **not** call it for a file you already recalled this session, and do not call
it in a repository where `kodus trace status` reports nothing captured.

## Reading

Reading needs no subcommand. Paths are positional on the group itself:

```bash
kodus trace src/billing/invoice.ts
kodus trace src/billing src/payments
kodus trace src/billing --limit 10
```

A directory returns everything scoped under it. A file returns everything whose
scope covers it, including decisions recorded against its directory.

Machine-readable output, for when you want to filter it yourself:

```bash
kodus trace src/billing --format json
```

If a path collides with a subcommand name (`enable`, `status`, `ui`, …),
disambiguate it with `--`:

```bash
kodus trace -- status
```

Do not invent a `recall` subcommand — it does not exist, and reading needs no
verb.

## Reading the output

Each decision carries:

- **type** — `architectural_decision`, `convention`, `tradeoff`,
  `implementation_detail`, `tooling`, `other`.
- **origin** — `human` if the person asked for it, `agent` if the agent chose it
  unprompted, `collaborative` if it was settled between them.
- **confidence** — 0 to 1, as judged during distillation.
- **scope** — the paths it applies to.
- **source** — `local` (recorded on this machine) or `branch` (came with the
  repository, from a teammate).
- **id** — the handle for `forget` and `pin`.

A `tradeoff` with high confidence is the most important thing on the list: it is
usually the reason the code looks the way it does. Treat one as a constraint on
your change unless the user says otherwise, and say so out loud rather than
silently working around it.

Treat `origin: human` as stronger than `origin: agent`. Low confidence is a hint,
not a rule.

## Correcting the record

When a decision is plainly wrong, or the user says it is:

```bash
kodus trace forget <id>
```

When a decision must never be dropped from the review context pack:

```bash
kodus trace pin <id>
```

Do not run either of these on your own judgement alone — confirm with the user
first, because both are shared corrections.

## What this skill does not do

- It does not write decisions. Capture happens through hooks installed by
  `kodus trace enable`, and distillation runs on `git push`.
- It does not search semantically. The lookup is path matching, so pass paths,
  not questions.
- It does not reach the network. Everything is read from the local store and the
  local object database.

## If nothing comes back

An empty result is a normal answer, not an error, and it exits zero. It means
either nothing has been recorded for those paths yet or capture is not enabled.
Check with:

```bash
kodus trace status
```

If it reports no sessions, tell the user they can enable capture with
`kodus trace enable`, then carry on with the task. Do not enable it for them
without being asked.
