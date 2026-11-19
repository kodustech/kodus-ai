# Kodus AI

AI-powered code review platform. Monorepo with 4 NestJS/Next.js apps and 20 shared libs.

## Layout notes

- `libs/llm/` - In-repo LLM/BYOK layer (replaced the old `@kodus/kodus-common/llm` package). One format: a stored `BYOKConfig` routes to one resolved slot (`NormalizedModel`), and every call goes through the single `LLM.run` door. Full model in `libs/llm/README.md`

## Getting Started

- Node.js 22.23.4 required (`.nvmrc` at root). Run `nvm use` if you get version errors
- `pnpm run setup` - First-time project setup

## Commands

Everything runs via Docker (`docker-compose.dev.yml`); the `docker:*` and `dev:*` scripts in `package.json` start, stop and reset it. Tests run with `pnpm run test`, which needs `API_NODE_ENV=test`.

## Architecture Patterns

- NestJS modules follow: Module > Controller > UseCase > Service/Repository
- Dependency injection via NestJS tokens (e.g., `JOB_PROCESSOR_SERVICE_TOKEN`)
- Path aliases: `@libs/*` for shared libraries, `@apps/*` for applications
- Apps communicate via RabbitMQ using outbox relay pattern for eventual consistency
- Idempotency via inbox pattern with claim/release mechanism
- Retry with exponential backoff + dead letter queues (max 5 retries)
- Permission system: RBAC with `@CheckPolicies()` decorator + `PolicyGuard`

## Key Concepts

- "Kody" is the AI agent that performs automated code reviews
- "Kody Rules" are custom review rules (per org, per repo, or from library)
- "Custom agents" are extra reviewers a team configures in the app (not in `kodus-config.yml`): instructions, files, skills and docs, tools. Skills and docs are read from the PR's target branch, or (custom agents only, never the main review) from another repository at its default branch or a set ref, never a ref the PR controls (`libs/code-review/infrastructure/agents/knowledge/`). User docs: `docs/en/how_to_use/code_review/custom_agents*.mdx`; evals: `evals/custom-agents/`
- Organization > Team > Members hierarchy
- Git integrations: GitHub, GitLab, Bitbucket, Azure Repos, Forgejo
- Project management integrations: Jira, Linear, Azure Boards
- "Dry Run" is a preview mode to test code review rules before enabling
- CLI reviews via team API keys (`x-team-key` header or `Bearer kodus_*`)

## Issues

- Issues are opened with the `bug-report` (defect) or `issue-draft` (everything else) skill, and built after `issue-design` has posted a design comment on them. All three live in the kodus-growth repository and install with `./bin/sync-skills.sh --global`.
- An issue body carries what was observed, measured and read in the code. It is not a specification of the fix. A cause stated in an issue holds only for the version it was read at: confirm it in the current code before changing anything, and correct the issue when it no longer holds. Never ship a fix for a cause you did not confirm yourself.
- The approach is decided in the design comment, not in the issue and not silently in code. Anything the issue or the design left as an open question gets resolved with its author before it is built.
- A PR that touches the review pipeline, the agent harness or Kody Rules carries eval evidence: the run link, and for an improvement, the metric the issue named against its baseline.
- The evals themselves (the rules, how to create one, where to look) are in `evals/README.md`.
- Templates live in `.github/ISSUE_TEMPLATE/`. Blank issues are disabled on the web form, but `gh issue create` bypasses templates, which is why the skills exist.

## PRs and comments

- A PR description fits in 20 lines: what changed, why, how it was verified, with links. An issue comment fits in 25 lines. Design comments carry a Mermaid diagram when the change crosses stages or services.
- No preamble, no restatement of the task, no closing summary. Cite `path/file.ts:line` instead of pasting code. Delete every sentence that does not change what the reader will do next.
