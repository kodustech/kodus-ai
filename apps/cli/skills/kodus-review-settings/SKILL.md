---
name: kodus-review-settings
description: Use when the user wants to see or change how Kody reviews code (Settings > Code Review in the web app) from the terminal, at the global, repository or directory level, choose the review model, edit the custom start/end/error messages, set the review language, or manage the Skills & docs the review follows, via `kodus config remote show|set|unset|keys|model|messages|language|skills`.
---

# Kodus Review Settings

## Goal

Read and change the code review settings the web app shows under Settings > Code Review, without opening the browser: review cadence, base branches, ignored paths, approval policy, categories and their instructions, severity filter and limits, PR summary, custom prompt, Kody Rules learning, Business Logic options, linked repositories, and the review model.

Run the commands yourself on the user's behalf; do not hand them commands to run.

## Trigger Hints

- "Stop reviewing drafts", "ignore `dist/**`", "only post high and critical", "turn off the PR summary", "review only `main`", "what severity filter is this repo using?"
- "Use model X for reviews in this repo", "which models can I use?", "does model X work?"
- "Change the message Kody posts when a review starts", "stop posting the end message", "post Kody comments as hidden", "add a copyable prompt to suggestions"
- "Review in Portuguese", "what language does Kody review in?"
- "Make the review follow `docs/payments.md`", "add our ledger skill", "which skills and docs does the review use?"
- Any mention of Kodus code review settings, overrides, or "Settings > Code Review".

Not this skill: Kody Rules (`kodus rules`), custom agents (`kodus agents`), centralized config (`kodus config centralized`).

`kodus config remote list --json` lists the team's configured repositories (with `--team` when logged in).

## Auth

Every command here needs a logged-in user:

```bash
kodus auth login
```

With a team key only six legacy repository settings work (`review.enabled`, `review.autoApprove`, `review.requestChanges.minSeverity`, `patterns.ignoreFiles`, `patterns.baseBranches`, `patterns.ignoreTitles`); anything else answers `AUTH_REQUIRED`. The user's role applies exactly as in the web app: a change they cannot make there fails here too.

If the organization has more than one team, pass `--team <name|id>` (the error lists the teams).

## Levels

Settings resolve from most general to most specific: `default` → `global` → `repository` → `directory`. A `kodus-config.yml` in the repository (`repository_file`, `directory_file`) sits on top when the repository lets the file override web settings.

The first argument picks the level:

- `global`: every repository of the team.
- `.` (current git repo), `owner/repo`, the repository name, or its id: one repository.
- add `--directory <path>` for a directory inside that repository.

Change the narrowest level that matches what the user asked. "In this repo" means the repository, not `global`.

## Workflow

1. Find the key and its allowed values:

```bash
kodus config remote keys --json
```

2. Read the current state before changing it. Every value comes with the level it comes from (`level`) and, when it overrides something, the value and level underneath (`overriddenValue`, `overriddenLevel`):

```bash
kodus config remote show . --json
kodus config remote show global --json
kodus config remote show . --directory apps/web --json
```

`--no-file-overlay` skips reading `kodus-config.yml` from the git provider (faster, stored settings only).

3. Change one setting:

```bash
kodus config remote set . suggestionControl.severityLevelFilter high --json
kodus config remote set global runOnDraft false --json
kodus config remote set . baseBranches "main, release/*" --json
kodus config remote set . v2PromptOverrides.generation.main "$(cat review-instructions.md)" --json
```

- Values: `true`/`false`, numbers, one of the listed enum values, plain text, lists as `a, b` or a JSON array, `linkedRepositories` as a JSON array of `{"repository","instructions"?,"ref"?}`.
- Lists replace the whole list. To add or remove one pattern use `kodus config remote add-pattern|remove-pattern . <ignore-files|base-branches|ignore-titles> <pattern>`.
- A directory without settings of its own needs `--create-directory`.
- If the output has `overriddenByFile`, tell the user the repository's `kodus-config.yml` keeps winning until they change the file.
- If the output has `centralized`, centralized config is on: the change went to a pull request (link in `centralized.prUrl`) and applies when it is merged.

4. Go back to the inherited value instead of copying it:

```bash
kodus config remote unset . runOnDraft --json
```

## Review model

Only when the organization connected its own provider (BYOK). Otherwise `model list` says reviews use the Kodus-managed model and there is nothing to choose.

```bash
kodus config remote model list --json
kodus config remote model test <modelId> --json
kodus config remote model set . <modelId> --json
kodus config remote model unset . --json
```

- Test a model before setting it when the user is unsure it works; `ok: false` carries the provider's message.
- `set` refuses an id outside the configured list; `--force` saves it anyway (only when the user insists).
- The current model of a scope is `model` in `kodus config remote show`; an empty value means the BYOK main model.

## Output Guidance

- Always pass `--json` and summarize: what changed, at which level, and anything that still overrides it.
- When the user asks "what is X set to", answer with the value and where it comes from ("high, set on this repository; global is medium").

## Custom messages

What Kody posts when a review starts, ends or fails, and how its comments show up. Same levels as the settings (`global`, a repository, `--directory`).

```bash
kodus config remote messages fields --json
kodus config remote messages show . --json
kodus config remote messages set . start.content "Kody is reviewing this PR" --json
kodus config remote messages set . start.content --from-file start-message.md --json
kodus config remote messages set . end.status off --json
kodus config remote messages set global hideComments true --json
kodus config remote messages unset . start.content --json
```

- Fields: `start.content`, `start.status`, `end.content`, `end.status`, `error.content`, `hideComments`, `suggestionCopyPrompt`.
- `start.status` and `end.status` take `every_push`, `only_when_opened` or `off` (`off` keeps the text for later).
- `error.content` is appended below Kody's default comment when a review fails. Setting it turns it on; an empty value posts only the default comment. It has no status.
- `hideComments` (GitHub only) posts Kody's review comments collapsed. `suggestionCopyPrompt` adds a prompt to each suggestion the developer can paste into an AI assistant.
- `set` and `unset` take the repository explicitly (`.` for the current one).

## Review language

A team setting: it covers every repository and directory of the team.

```bash
kodus config remote language list --json
kodus config remote language show --json
kodus config remote language set pt-BR --json
```

`set` takes the code (`pt-BR`) or the name (`Portuguese (Brazil)`).

## Skills & docs

Guides that live in the repository (a skill is a folder with a `SKILL.md`, a doc is a Markdown file) that the main review and custom agents follow. They are read from each pull request's target branch; skills open on demand, docs load whole, scripts never run.

```bash
kodus config remote skills list . --json
kodus config remote skills discover . --json
kodus config remote skills add . docs/payments.md .claude/skills/ledger --link main-review --json
kodus config remote skills link . docs/payments.md security-reviewer --json
kodus config remote skills unlink . docs/payments.md main-review --json
kodus config remote skills remove . docs/payments.md --json
```

- `list` shows each item, who follows it (`followedBy`), and, for a repository, whether it exists on the default branch with its issues (`report`). At `global` nothing is read: the paths apply to every repository.
- `discover` lists what was found on the default branch and is not added yet. A candidate with `kodyRuleSource: true` also feeds Kody Rules; linking it can make the same rule comment twice, so say so.
- An item nothing follows does nothing. `add` without `--link` registers it only; link it to `main-review` or an agent (`--link` is repeatable).
- At a directory, items inherited from the repository are listed under `inherited`; change them without `--directory`.
- A conflict ("Someone else changed these skills and docs…") means someone saved in between: run the command again; nothing was saved.
- Linking to a single agent is also available as `kodus agents update <agent> --skill/--doc`.

## Not Covered Here

- Connecting a Business Logic task source and BYOK provider credentials: web app only.
