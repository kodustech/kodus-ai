---
name: kodus-centralized-config
description: Use when the user wants to manage centralized configuration via `kodus config centralized` commands (status, init, sync, disable, and download).
---

# Kodus Centralized Config

## Overview

Centralized configuration allows teams to manage their Kodus configuration files in a single repository, providing a single source of truth for their settings. This skill enables users to manage their centralized configuration through Kodus CLI commands, including initializing centralized config, syncing configuration, disabling centralized config, and downloading generated config files.

The configuration files are generated based on the user's current settings, and users have the option to review these changes in a pull request before they are merged into the repository. This approach ensures that teams can maintain control over their configuration while benefiting from the convenience of centralized management.

If the setting is enabled, then any pull request merged to the selected repository will trigger a sync to update the configuration in Kodus. This allows teams to easily manage and update their configuration as needed, without having to manually apply changes in Kodus.

At any time the user can run a manual sync command to pull the latest configuration from the repository, however this is not recommended.

## Goal

Manage centralized configuration through Kodus CLI commands only.

Use this skill when the request involves enabling centralized config, selecting the source repository, syncing configuration, disabling centralized config, or downloading generated config files.

## Trigger Hints

- Mentions of centralized config, centralized configuration, config sync source repo, or source repository for rules.
- Requests to run: `kodus config centralized status|init|sync|disable|download`.
- Requests to enable or disable centralized config from terminal.

## Workflow

Unless specifically stated, YOU must run the Kodus CLI commands on behalf of the user. Do not provide instructions to run commands without also running them yourself.

1. Confirm team-key authentication is available.

- Centralized config commands require team-key auth.
- If missing, instruct the user to run:

```bash
kodus auth team-key --key <your-key>
```

2. Check current centralized status first when context is unclear.

```bash
kodus config centralized status
```

3. Initialize centralized config when requested.

- Preferred command shape:

```bash
kodus config centralized init [owner/repo] --sync-option <pr|manual>
```

ALWAYS run the command `kodus config remote list` first to get the list of repositories the user has access to and their current selection. You must provide the repo in the shape `owner/repo` for example `organization/repository-name`. If you cannot find the repository in the list, then tell the user about it.

- Defaults and behavior:
- `--sync-option` defaults to `pr`. Defines the behaviour of the initial sync after enabling centralized config.
    - `pr` creates a pull request with their current config. A link to the PR is provided in the command output. Merging the PR triggers a sync to update the configuration in Kodus.
    - `manual` simply enables centralized config without creating a PR, the user will need to create a PR themselves with their desired config or run a manual sync after pushing changes to the repository.
- If repository is omitted in an interactive terminal, CLI prompts repository selection.
- In non-interactive mode, repository must be provided explicitly.

Prefer providing the repository in the command to avoid interactive prompts, especially in non-interactive contexts. If the repository is not provided and the terminal is interactive, the CLI will prompt the user to select a repository from their accessible repositories. If the terminal is non-interactive and the repository is not provided, the command will fail with an error indicating that the repository is required.

4. Sync centralized config on demand.

A sync will pull the latest configuration from the repository and override the user's current configuration defined in the Kodus database with the config from the repository. Syncs happen automatically when a PR is merged regardless of the initial sync option selected, but users can also choose to run a manual sync at any time to pull the latest changes from the repository.

```bash
kodus config centralized sync
```

Avoid running sync automatically after init to give users control over when to pull changes, especially if they want to review or customize the generated config before applying it.

Running sync will override the user's current configuration with the config from the repository, so it's best to let users decide when to do this, be sure to warn them of this when they ask to run sync and recommend downloading the config first as a backup before syncing.

5. Disable centralized config when requested.

```bash
kodus config centralized disable
```

6. Download centralized config zip artifact.

```bash
kodus config centralized download --out <path/to/centralized-config.zip>
```

- `--out` is required.

## Output Guidance

- Prefer using `--json` to receive structured output.
- When providing output to the user, summarize the key information and next steps rather than dumping raw command output.

## Safety Notes

- Do not suggest manually editing backend parameters for centralized config when CLI commands exist.
- If repository selection fails, verify the repository is already selected in Kodus (`kodus config remote list`).
