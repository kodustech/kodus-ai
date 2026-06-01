<!-- TODO: Add banner image/logo here -->

<h1 align="center">Kodus CLI</h1>

<p align="center">
  <strong>Catch bugs before they reach your pull request — AI code review from the terminal.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kodus/cli"><img src="https://img.shields.io/npm/v/@kodus/cli.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@kodus/cli"><img src="https://img.shields.io/npm/dm/@kodus/cli.svg" alt="npm downloads"></a>
  <a href="https://github.com/kodustech/cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/kodustech/cli" alt="license"></a>
  <a href="https://github.com/kodustech/cli"><img src="https://img.shields.io/github/stars/kodustech/cli" alt="stars"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="node version"></a>
</p>

<p align="center">
  <a href="https://kodus.io">Website</a> &middot;
  <a href="https://app.kodus.io">Sign Up</a> &middot;
  <a href="https://github.com/kodustech/cli/issues">Issues</a>
</p>

---

```bash
yarn global add @kodus/cli
```

---

## Quick Start

```bash
# 1. Install
yarn global add @kodus/cli

# 2. Authenticate (or skip for trial mode — no account needed)
kodus auth login

# 3. Review your code
kodus review
```

That's it. Kodus analyzes your changes, finds issues, and lets you fix them interactively — or auto-fix everything at once with `kodus review --fix`.

<!-- TODO: Add demo GIF showing interactive review in action -->

## What It Does

### Code Review

Analyze local changes, staged files, commits, or branch diffs. Kodus finds bugs, security issues, performance problems, and style violations — then suggests fixes with real code.

```bash
kodus review                    # Review working tree changes (interactive)
kodus review --staged           # Only staged files
kodus review --branch main      # Compare against a branch
kodus review --fix              # Auto-apply all fixable issues
kodus review --prompt-only      # Structured output for AI agents
```

Reviews are **context-aware** — Kodus reads your `.cursorrules`, `claude.md`, and `.kodus.md` so suggestions follow your team's standards. [More on review modes](#review-modes)

### Kody Rules

Create, update, and inspect the Kody Rules that guide Kodus behavior for your team.

```bash
kodus rules create --title "Use async/await" --rule "Prefer async/await over raw promises" --repo-id global --severity high --scope file --path "**/*.ts"
kodus rules update --uuid <uuid> --repo-id global --severity critical
kodus rules view --repo-id global
```

`kodus rules update` requires `--uuid`.

Defaults:

- `repo-id` defaults to `global`
- `severity` defaults to `medium`
- `scope` defaults to `file`
- `path` is optional (omitted means all files)

### PR Suggestions

Fetch AI-powered suggestions for open pull requests directly from your terminal.

```bash
kodus pr suggestions --pr-url https://github.com/org/repo/pull/42
kodus pr suggestions --pr-number 42 --repo-id <id>
```

Filter by severity, export as JSON or Markdown, or pipe into an AI agent with `--prompt-only` for automated fixes.

### Business Validation (Local Diff vs Task)

Run Kodus business-rules validation directly from your local diff with optional task reference.

```bash
# Working tree diff (default)
kodus pr business-validation

# Staged-only with explicit task reference
kodus pr business-validation --staged --task-id KC-1441

# Branch or files scope
kodus pr business-validation --branch main --task-id KC-1441
kodus pr business-validation src/service.ts src/use-case.ts --task-id KC-1441
```

### Decision Memory

AI agents make dozens of decisions per session — architecture choices, trade-offs, why approach X was picked over Y. Without a record, that reasoning vanishes when the session ends.

Kodus captures agent decisions into your repo as structured markdown. When you or another agent return to the code, the full context is there.

```bash
kodus decisions enable           # Install hooks + initialize config
kodus decisions status           # See what's been captured
kodus decisions show [name]      # View PR or module memory
kodus decisions promote          # Promote decisions to long-term memory
```

Stored in `.kody/pr/by-sha/<head-sha>.md` — versioned with your code, readable by humans and agents. [More on decision memory](#decision-memory-1)

---

## Best With AI Agents

Kodus is designed to work **inside AI coding agents**. While you can use it standalone, the real power comes when your agent runs reviews automatically and fixes issues in a loop — no manual intervention needed.

**Works with:** Claude Code, Cursor, Windsurf, GitHub Copilot, Gemini CLI, and 20+ more environments.

### Install the Skill (recommended)

The fastest way to get started. Auto-detects your installed IDEs and sets everything up:

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/kodustech/cli/main/install.sh | bash
```

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'kodus-install.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/kodustech/cli/main/install.ps1 -OutFile $tmp; & $tmp"
```

This installs the Kodus CLI globally and deploys the review skill into every supported agent on your machine — Claude Code, Cursor, Windsurf, and others. One command, all environments.

### How It Works With Agents

Once installed, your AI agent can autonomously:

1. **Write code** as usual
2. **Run `kodus review --prompt-only`** to analyze changes
3. **Read the structured output** and understand each issue
4. **Fix the issues** automatically
5. **Repeat** until the review is clean

This creates a tight feedback loop: the agent writes, reviews, and fixes — all without leaving your IDE.

Beyond reviews, Kodus also captures **what your agent decided and why** via [Decision Memory](#decision-memory). Every reasoning step is saved into your repo — so when you (or another agent) pick up the work later, the full context is already there. No more re-explaining what was done or losing decisions between sessions.

### Setup: Claude Code

Add to your project's `CLAUDE.md`:

```markdown
## Code Review

After implementing changes, run `kodus review --prompt-only` to check for issues.
If issues are found, fix them and re-run until clean.
```

Or use the skill directly — after installing via the command above, just ask Claude Code to review your code and it will use Kodus automatically.

### Setup: Cursor / Windsurf

Add to your `.cursorrules` or equivalent:

```
When writing code:
1. Implement the feature
2. Run: kodus review --prompt-only
3. If issues are found, fix them automatically
4. Repeat until review is clean
5. Show final result
```

### Setup: Headless / Shared Environments

Set a team key so agents and shared machines are authenticated without individual logins:

```bash
export KODUS_TEAM_KEY=kodus_xxxxx
kodus review --prompt-only
```

Works with Codex, CI runners, remote dev environments, and any context where personal login isn't practical. Get your key at [app.kodus.io/organization/cli-keys](https://app.kodus.io/organization/cli-keys).

### Copy & Paste Workflow (interactive)

If you prefer manual control:

1. Run `kodus review`
2. Navigate to a file with issues
3. Select **"Copy fix prompt for AI agent"**
4. Paste into Claude Code or Cursor — the AI fixes it

The copied prompt includes file path, line numbers, severity, and detailed suggestions — optimized for AI agents.

## Installation

### Skill installer (recommended — CLI + all your agents)

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/kodustech/cli/main/install.sh | bash
```

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'kodus-install.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/kodustech/cli/main/install.ps1 -OutFile $tmp; & $tmp"
```

Installs the CLI and deploys the review skill to all detected agents in one step.

### Keep everything updated

`kodus update` updates the CLI package.

For end users, the recommended way to refresh skills and agent integrations is:

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/kodustech/cli/main/install.sh | bash
```

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'kodus-install.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/kodustech/cli/main/install.ps1 -OutFile $tmp; & $tmp"
```

Fallback via CLI for common local agent roots:

```bash
kodus skills install        # install into detected local agent roots
kodus skills resync         # re-sync/refresh managed skills
kodus skills uninstall      # remove managed skills from detected targets
```

If you want to inspect the script before execution:

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/kodustech/cli/main/install.sh -o /tmp/kodus-install.sh
less /tmp/kodus-install.sh
bash /tmp/kodus-install.sh
```

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest https://raw.githubusercontent.com/kodustech/cli/main/install.ps1 -OutFile install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

### CLI only

<details>
<summary><strong>yarn</strong></summary>

```bash
yarn global add @kodus/cli
```

</details>

<details>
<summary><strong>npx (no install)</strong></summary>

```bash
npx @kodus/cli review
```

</details>

<details>
<summary><strong>curl</strong></summary>

```bash
curl -fsSL https://raw.githubusercontent.com/kodustech/cli/main/install.sh | bash
```

</details>

<details>
<summary><strong>PowerShell</strong></summary>

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'kodus-install.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/kodustech/cli/main/install.ps1 -OutFile $tmp; & $tmp"
```

</details>

<details>
<summary><strong>Homebrew (coming soon)</strong></summary>

```bash
brew install kodus/tap/kodus
```

</details>

## Agent Mode

Kodus now supports an explicit **agent mode** for deterministic automation output.

### Global flag

Use `--agent` on any command to return a stable JSON envelope:

```json
{
    "ok": true,
    "command": "review",
    "data": {},
    "error": null,
    "meta": {
        "schemaVersion": "1.0",
        "cliVersion": "x.y.z",
        "mode": "agent",
        "durationMs": 123
    }
}
```

### Command schema introspection

```bash
kodus schema
kodus schema --command "pr suggestions"
```

### Field selection for smaller payloads

Available on `review` and `pr suggestions`:

```bash
kodus review --agent --fields summary,issues.file,issues.line
kodus pr suggestions --agent --pr-url https://github.com/org/repo/pull/42 --fields summary,issues.file
```

`--fields` requires `--agent` or `--format json`.

### Dry-run for mutable commands

```bash
kodus hook install --dry-run
kodus hook uninstall --dry-run
kodus decisions enable --dry-run
kodus decisions disable --dry-run
kodus decisions promote --dry-run
```

Dry-run prints the planned actions and does not mutate local hooks/config/files.

## Review Modes

### Interactive (default)

```bash
kodus review
```

Navigate files with issue counts, preview fixes before applying, and copy AI-friendly prompts to paste into Claude Code or Cursor.

### Auto-fix

```bash
kodus review --fix
```

Applies all fixable issues at once. Shows a confirmation prompt before making changes.

### AI Agent

```bash
kodus review --prompt-only
```

Minimal, structured output designed for Claude Code, Cursor, and Windsurf. Perfect for autonomous generate-review-fix loops.

<details>
<summary><strong>More: output formats &amp; flags</strong></summary>

#### Output Formats

```bash
kodus review                           # Interactive (default)
kodus review --format json             # JSON output
kodus review --format markdown         # Markdown report
kodus review --prompt-only             # AI agent output
kodus review --format markdown -o report.md  # Save to file
```

#### Output Streams

- `stdout`: command result/payload (for example JSON/Markdown reports)
- `stderr`: debug traces (`--verbose`), spinner/progress messages, and errors

This keeps machine-readable output clean for piping:

```bash
kodus review --format json > review.json
kodus review --format json --verbose 1>review.json 2>review.debug.log
```

#### Diff Targets

```bash
kodus review                           # Working tree changes
kodus review --staged                  # Staged files only
kodus review --commit HEAD~1           # Specific commit
kodus review --branch main             # Compare against branch
kodus review src/index.ts src/utils.ts # Specific files
```

#### All Flags

| Flag                   | Description                                   |
| ---------------------- | --------------------------------------------- |
| `--staged`             | Analyze only staged files                     |
| `--commit <sha>`       | Analyze a specific commit                     |
| `--branch <name>`      | Compare against a branch                      |
| `--rules-only`         | Only check configured rules                   |
| `--fast`               | Faster analysis for large diffs               |
| `--fix`                | Auto-apply all fixable issues                 |
| `--prompt-only`        | AI agent optimized output                     |
| `--context <file>`     | Include custom context file                   |
| `--format <fmt>`       | Output format: `terminal`, `json`, `markdown` |
| `--output <file>`      | Save output to file                           |
| `--fail-on <severity>` | Exit code 1 if issues meet or exceed severity |
| `-i, --interactive`    | Explicitly enable interactive mode            |

</details>

## Decision Memory

Full reference for the decision capture system ([intro above](#decision-memory)).

```bash
# Enable with specific agents
kodus decisions enable --agents claude,cursor,codex

# Custom Codex config path
kodus decisions enable --agents codex --codex-config ~/.codex/config.toml

# Overwrite existing config
kodus decisions enable --force

# Check what's been captured on current branch
kodus decisions status

# View decisions for a PR or specific module
kodus decisions show [name]

# Promote PR-level decisions to long-term module memory
kodus decisions promote --branch feat/auth --modules auth,users

# Disable hooks (preserves all captured data in .kody/)
kodus decisions disable
```

**How it works:** Hooks fire on agent turn-complete events and persist decisions to `.kody/pr/by-sha/<head-sha>.md`. Files are committed to your repo, versioned with your code, readable by humans and agents.

**Supported agents:** Claude Code, Cursor, Codex.

## CI/CD & Git Hooks

### Pre-push Hook

```bash
kodus hook install --fail-on error   # Block pushes with errors
kodus hook status                     # Check hook status
kodus hook uninstall                  # Remove hook
```

### Pipeline Usage

```bash
# Strict rules check with JSON output
kodus review --rules-only --format json --fail-on error

# Generate markdown report artifact
kodus review --format markdown --output review-report.md
```

## Authentication

Kodus supports multiple auth methods depending on your setup:

### Trial Mode (no account)

Just run `kodus review`. No signup needed. You get 5 reviews/day with up to 10 files and 500 lines per file — enough to try it out. [Sign up free](https://app.kodus.io) to remove limits.

### Personal Login

For individual developers. Creates a session with automatic token refresh.

```bash
kodus auth login           # Sign in with email/password
kodus auth status          # Check auth status and usage
kodus auth logout          # Sign out
```

Credentials are stored locally in `~/.kodus/credentials.json`.

### Team Key

For teams where not everyone needs their own account. A single shared key gives the whole team access — developers just set the key and start reviewing, no individual signup required.

```bash
kodus auth team-key --key kodus_xxxxx
```

Or set it as an environment variable:

```bash
export KODUS_TEAM_KEY=kodus_xxxxx
```

Get your team key at [app.kodus.io/organization/cli-keys](https://app.kodus.io/organization/cli-keys). Team keys have configurable device limits managed from the dashboard.

This is also the recommended auth method for AI coding agents (Claude Code, Cursor, Codex) — set the env var once and every agent session is authenticated automatically.

### Repository Configuration

Repository configuration requires team-key auth:

- team keys work across `add`, `list`, `show`, `setup`, `set`, and pattern mutations through the CLI config endpoints

These commands always read and update the repository's current settings directly. There is no reset-to-default flow in the CLI.

`kodus config -r` and `kodus config --remote` are shortcuts for `kodus config remote add`.

```bash
kodus config -r .                       # Shortcut for: kodus config remote add .
kodus config --remote .                 # Shortcut for: kodus config remote add .
kodus config --remote . --json          # Add and print machine-readable result
kodus config --remote . --no-prompt     # Add without starting setup
kodus config remote add .               # Add the current repository explicitly
kodus config remote show .              # Inspect current repository settings
kodus config remote setup .             # Run guided setup again
kodus config remote setup . --json      # Print structured setup result
kodus config remote set . review.enabled true
kodus config remote set . review.enabled true --json
kodus config remote set . patterns.ignoreFiles "**/*.lock,dist/**"
kodus config remote add-pattern . ignore-files "dist/**"
kodus config remote add-ignore-file . "dist/**"
kodus config remote remove-base-branch . "release/*"
kodus config remote remove-pattern . base-branches "release/*"
kodus config remote open . --section suggestion-control
kodus config remote list --json
kodus config remote list                # List repositories already configured
```

When a repository is added from an interactive terminal, Kodus offers a guided setup for:

- automated review
- auto approve
- minimum severity level
- ignored file patterns
- base branch patterns
- ignored title patterns

Pattern fields accept glob expressions such as `**/*.lock`, `dist/**`, `release/*`, and `draft*`.

Use `kodus config remote open` when you need advanced repository settings that are still web-only. The CLI opens the Kodus app and prints the repository/section path to navigate.

Use `--json` with `show`, `set`, `open`, `add-pattern`, `remove-pattern`, and the pattern aliases when you need stable machine-readable output for scripts or AI agents.

When targeting a repository that is different from your current working directory, pass `owner/repo` explicitly instead of `.`:

```bash
kodus config -r Wellington01/kodus-extension
kodus config remote show Wellington01/kodus-extension
```

#### Local API note

When testing against the local backend with `yarn start:local`, repository configuration works with a team key when the local API exposes:

- `GET /cli/config/repositories/available`
- `GET /cli/config/repositories/selected`
- `POST /cli/config/repositories`
- `GET /cli/config/repositories/:repositoryId/settings`
- `PATCH /cli/config/repositories/:repositoryId/settings`

```text
Repository configuration access denied: ...
```

Example local commands:

```bash
export KODUS_TEAM_KEY=kodus_xxxxx
yarn start:local config -r Wellington01/kodus-extension --no-prompt
yarn start:local config remote list --json
yarn start:local config remote show Wellington01/kodus-extension
```

### CI/CD Token

For pipelines and automated environments. Generated from your personal login:

```bash
kodus auth token           # Generate a CI/CD token
```

Then use it in your pipeline:

```bash
export KODUS_TOKEN=<your-token>
kodus review --format json --fail-on error
```

> **Note:** For PR-level reviews in CI/CD, we recommend using the [Kodus platform](https://app.kodus.io) GitHub/GitLab integration instead of the CLI. It's purpose-built for PR workflows with inline comments, status checks, and team dashboards.

<details>
<summary><strong>Environment variables</strong></summary>

| Variable         | Description                                                                    |
| ---------------- | ------------------------------------------------------------------------------ |
| `KODUS_API_URL`  | API endpoint (default: `https://api.kodus.io`). HTTPS only (except localhost). |
| `KODUS_APP_URL`  | Optional Kodus app URL override for `kodus config remote open`.                |
| `KODUS_TOKEN`    | CI/CD token for automated pipelines (generated via `kodus auth token`)         |
| `KODUS_TEAM_KEY` | Team key for shared team access and AI coding agents                           |

</details>

## Privacy & Security

Kodus sends your code diffs to the Kodus API for analysis. We take this seriously:

- **HTTPS only** — All API communication is encrypted. Custom API URLs are validated.
- **No training on your code** — Your code is not used to train models.
- **Minimal data** — Only diffs and context files are sent, not your entire codebase.
- **Credentials stored locally** — Auth tokens are kept in `~/.kodus/credentials.json` on your machine.

## Contributing

We welcome contributions! Please see our [issues page](https://github.com/kodustech/cli/issues) to get started.

```bash
yarn install      # Install dependencies
yarn build        # Build
yarn dev          # Watch mode
yarn test         # Run tests
```

## License

[MIT](LICENSE)
