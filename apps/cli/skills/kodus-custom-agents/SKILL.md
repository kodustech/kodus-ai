---
name: kodus-custom-agents
description: Use when the user wants to list, create, edit, turn on or off, delete, or try a Kodus custom agent (a dedicated reviewer that follows the team's own instructions, skills, docs and tools) via `kodus agents`.
---

# Kodus Custom Agents

## Overview

A custom agent is a reviewer the team defines: a name (which is also its `@kody -v <slug>` command), instructions, the files it runs on, the skills and docs of the repository it follows, optional tools (MCP plugins, CLIs, ast-grep rules), the model it runs on and how it comments. It runs next to Kody's own review on every pull request once it is turned on.

Agents live at a config level, exactly like the web app's Settings > Code Review:

- `global` (default): every repository gets these, unless a repository saved its own list.
- `--repo <repository>`: the repository's list. The first save at a repository that still reads the global list gives it its own list; changes to the global agents no longer reach it (the CLI prints this).
- `--repo <repository> --directory <path>`: a directory runs the repository's agents plus its own. An agent with the same id replaces the repository's one there.

## Trigger Hints

- "create an agent that…", "add a reviewer for…", "custom reviewer", "dedicated reviewer", "custom agent".
- "edit/update/rename agent X", "change what agent X reviews", "make agent X post only high severity".
- "turn agent X on/off", "enable/disable the security reviewer", "delete agent X".
- "try agent X on this PR", "what would agent X comment on PR #N".
- "which agents run on this repo", "how many comments did agent X post".

## Workflow

Unless the user says otherwise, YOU run the commands. Always pass `--json` and read the result.

1. Authentication: these commands need `kodus auth login`. A team key is rejected with `AUTH_REQUIRED`; tell the user to run `kodus auth login`.
2. Team: if the error says the organization has more than one team, re-run with `--team <name>` from the list it gives.
3. Find the level and the agents first:

```bash
kodus agents list --repo <repository> --json
```

Use the repository name or id from `kodus config remote list` (or the current git repository's name). Omit `--repo` for the global list. `status` per agent (pull requests, comments posted, dropped in the last `windowDays`) is filled when `--repo` is given.

4. Create. New agents start **turned off** so the team can try them first:

```bash
kodus agents create --repo <repository> --name "Data contracts" \
  --instructions "Flag migrations that lock large tables..." \
  --include "migrations/**" --min-severity high --json
```

- Long instructions: write them to a `.md` file and pass `--from-file agent.md`.
- Every other field (MCP tools, CLI tools with secrets, presentation) can come from a JSON file with agent fields: `--from-file agent.json`. Flags override the file.
- `--template architecture|e2e-coverage|regression-hallucination|security|blank` starts from the same templates as the web app.
- Link repository knowledge: `--skill <skill folder>` and `--doc <file>` (repeatable); `--unlink <path>` removes a link.
- To see every skill and doc of a scope, what the repository has that is not added yet, or to link one to the main review, use `kodus config remote skills list|discover|add|link` (skill `kodus-review-settings`).
- `--enable` turns it on right away; only do it when the user asked for that.

5. Try before enabling (nothing is posted; takes minutes on big PRs, do not interrupt):

```bash
kodus agents try <agent> --repo <repository> --pr <pull request url> --json
```

Agent fields passed to `try` change only that run, so you can iterate on instructions before saving them. Report the findings marked `wouldPost`.

6. Update only what changed; other fields stay:

```bash
kodus agents update <agent> --repo <repository> --max-comments 5 --json
kodus agents enable <agent> --repo <repository> --json
kodus agents disable <agent> --repo <repository> --json
kodus agents delete <agent> --repo <repository> --json
```

`<agent>` is the agent id, name, or its `@kody -v` command.

## Results to handle

- `centralized` in the result: the team uses centralized config; the change was proposed as a pull request (`prUrl`) instead of saved. Tell the user to merge it.
- `note`: say it to the user (e.g. the repository now has its own agents list).
- "Someone else changed these agents since this command read them": nothing was saved. Re-run the same command; never retry in a loop more than once without telling the user.
- "belongs to the repository": the agent is inherited at that directory; change it without `--directory`.
- A name clash ("already answers to @kody -v …"): pick another name.
- Plans without custom agents (not Teams/Enterprise) save nothing for agents; if `list` keeps showing the old state after a save, tell the user the plan does not include custom agents.

## Guardrails

- Never put secrets on the command line; CLI tool secrets go in a JSON file the user writes (`tools.cli[].secrets[].value`), and are write-only.
- Do not delete or disable agents the user did not name.
