# Agent Readiness Report: kodustech/kodus-ai

**Level:** 3/5
**Overall Score:** 62%
**Apps assessed:** 9 (apps/api, apps/worker, apps/webhooks, apps/web, apps/cli, apps/try, apps/mcp-manager, apps/analytics-cli, apps/ast-cli)
**Generated:** 2026-08-05T20:03:14.662Z

Coverage is the number of applicable apps that satisfy each criterion. The
overall score is app-weighted, so a capability adopted in only some apps
scores partially.

## Summary

| Metric | Value |
|--------|-------|
| Total Criteria | 39 |
| Passed (all apps) | 10 |
| Failed (some/no apps) | 29 |
| Skipped (n/a) | 0 |

## Pass Rate by Category

| Category | Pass Rate |
|----------|-----------|
| Style & Validation | 38% |
| Build System | 84% |
| Testing | 65% |
| Documentation | 57% |
| Development Environment | 73% |
| Observability | 62% |
| Security | 60% |
| Agent Readiness | 62% |

## Style & Validation

| Criterion | Coverage | Status | Rationale |
|-----------|----------|--------|-----------|
| Linter Configured | 7 / 9 | Failed | Root ESLint covers apps/api, apps/worker, apps/webhooks, libs and Nest app code, while apps/web and apps/cli have their own ESLint configs. apps/try, apps/analytics-cli, and apps/ast-cli have no app-specific lint enforcement and root ESLint ignores apps/web only but does not prove try/CLI app coverage in CI. |
| Code Formatter | 7 / 9 | Failed | Prettier is configured at the root and in apps/web/apps/cli, with root format scripts for backend/web. Formatting is not enforced for apps/try, apps/analytics-cli, or apps/ast-cli in CI. |
| Type Checker / Strict Typing | 3 / 9 | Failed | apps/web, apps/try, and apps/cli use strict TypeScript configs. The root/Nest config used by api, worker, webhooks, mcp-manager, analytics-cli, and ast-cli disables strict null checks and noImplicitAny, and CI only has a narrow libs TS2304 gate. |
| Pre-commit Hooks | 0 / 9 | Failed | .husky exists, but pre-commit only runs `node scripts/dev/check-yalc.js`; lint/format/tests are not enforced before commit. |
| Dead Code Detection | 0 / 9 | Failed | ESLint catches unused imports, but no knip, ts-prune, depcheck, or equivalent unused export/dead-code gate is configured. |

## Build System

| Criterion | Coverage | Status | Rationale |
|-----------|----------|--------|-----------|
| Single Command Setup | 9 / 9 | Passed | AGENTS.md documents `pnpm run setup`, and package.json provides the setup script for first-time project setup. |
| Dependencies Pinned | 9 / 9 | Passed | The repo commits pnpm lockfiles at the root and for independent apps such as apps/web, apps/cli, and apps/mcp-manager. |
| Build Command Documented | 7 / 9 | Failed | AGENTS.md documents root build commands for Nest apps and apps/web/apps/cli have package scripts. apps/try and the analytics/ast CLIs are less clearly documented as independently buildable units. |
| Task / Monorepo Tooling | 6 / 9 | Failed | Nest monorepo tooling in nest-cli.json covers api, worker, webhooks, mcp-manager, analytics-cli, and ast-cli. apps/web, apps/cli, and apps/try are independent pnpm projects rather than centrally orchestrated. |
| CI Configured | 7 / 9 | Failed | GitHub Actions run backend tests, CLI tests, type gates, e2e checks, and deploy/build workflows. apps/try, apps/analytics-cli, and apps/ast-cli do not have clear PR build/test CI coverage as standalone apps. |

## Testing

| Criterion | Coverage | Status | Rationale |
|-----------|----------|--------|-----------|
| Unit Tests Exist | 7 / 9 | Failed | There are many Jest/Vitest specs under apps/api, apps/worker, apps/webhooks, apps/web, apps/cli, apps/try, and apps/mcp-manager. No app-level specs were found under apps/analytics-cli or apps/ast-cli. |
| Tests Runnable | 7 / 9 | Failed | Root Jest and CLI Vitest commands are documented/run in CI, and web specs are included by the root Jest suite. apps/analytics-cli and apps/ast-cli lack dedicated runnable test commands. |
| Integration / E2E Tests | 5 / 7 | Failed | Backend, CLI, webhooks/worker behavior, mcp-manager, and e2e suites have integration/e2e coverage. apps/try and web dashboard coverage appears mostly unit-level; analytics-cli and ast-cli are not counted as requiring integration tests here. |
| Test File Conventions | 9 / 9 | Passed | Tests consistently use `*.spec.ts`, `*.spec.tsx`, `*.test.ts`, or `__tests__` directories across apps. |
| Coverage Thresholds | 0 / 9 | Failed | A `test:cov` script exists, but no enforced Jest/Vitest coverage threshold or CI coverage gate was found. |

## Documentation

| Criterion | Coverage | Status | Rationale |
|-----------|----------|--------|-----------|
| README | 3 / 9 | Failed | Root README exists and apps/web/apps/cli have READMEs. The backend apps, try, mcp-manager, analytics-cli, and ast-cli rely on broader docs rather than app READMEs. |
| Agent Context File | 4 / 9 | Failed | Root AGENTS.md exists, and apps/api, apps/web, apps/webhooks, and apps/worker have app-specific AGENTS.md files. apps/cli, apps/try, apps/mcp-manager, analytics-cli, and ast-cli lack app-specific agent context. |
| Architecture Docs | 6 / 9 | Failed | Root AGENTS.md, docs-internal, libs READMEs, and app docs cover core architecture and several services. Thin CLI apps and apps/try have less architecture-specific documentation. |
| API / Schema Docs | 3 / 4 | Failed | The API uses Swagger/OpenAPI tooling, apps/try has PUBLIC_API.md, and mcp-manager exposes Swagger docs. Webhooks do not appear to have maintained webhook contract/schema docs. |
| Documentation Freshness | 7 / 9 | Failed | Docs include recent plans, generated RBAC/env snippets, and CI checks for some generated docs. Some agent docs contain stale paths such as api AGENTS.md mentioning `libs/core/src/infrastructure/migrations` while migrations are under `libs/core/infrastructure/database/typeorm/migrations`. |

## Development Environment

| Criterion | Coverage | Status | Rationale |
|-----------|----------|--------|-----------|
| Environment Template | 9 / 9 | Passed | .env.example and .env.schema exist, with env drift/coverage CI that checks generated outputs and env usage. |
| Local Services Setup | 9 / 9 | Passed | docker-compose.dev.yml/test/prod/sim files and root docker scripts provide reproducible local dependencies for the monorepo. |
| Database Schema & Migrations | 6 / 6 | Passed | Database-using backend apps share TypeORM migrations, Mongo migration tooling, and migration scripts. Frontend/CLI-only apps are not applicable. |
| Dev Container | 0 / 9 | Failed | No `.devcontainer/devcontainer.json` or equivalent reproducible dev container config was found. |

## Observability

| Criterion | Coverage | Status | Rationale |
|-----------|----------|--------|-----------|
| Structured Logging | 4 / 7 | Failed | Backend services use shared Pino logging patterns, but mcp-manager uses Nest Logger directly and frontend/CLI apps have no clear structured logging standard. |
| Health Checks | 4 / 5 | Failed | API health is used by workflows, webhooks has a health controller, worker has a health probe, and mcp-manager has a health controller. Frontend health/version checks exist for web; apps/try health readiness is not evident. |
| Metrics / Telemetry | 6 / 9 | Failed | Backend apps and web use OpenTelemetry/Langfuse/PostHog/Pyroscope patterns. apps/cli, apps/try, analytics-cli, and ast-cli do not show consistent metrics/telemetry instrumentation. |
| Error Tracking | 4 / 7 | Failed | api, worker, and webhooks initialize Sentry; web has telemetry but no clear Sentry setup in inspected files; mcp-manager/try/cli do not show error tracking setup. |
| Distributed Tracing | 3 / 6 | Failed | Backend code includes OpenTelemetry/Langfuse instrumentation and AI SDK span helpers. mcp-manager, webhooks, and frontend/demo paths do not show consistent distributed trace propagation coverage. |

## Security

| Criterion | Coverage | Status | Rationale |
|-----------|----------|--------|-----------|
| Secret Scanning | 0 / 9 | Failed | No gitleaks, trufflehog, detect-secrets, Semgrep secrets, or equivalent secret scanning workflow was found. |
| Dependency Update Automation | 0 / 9 | Failed | Recent Dependabot PRs exist in history, but no `.github/dependabot.yml` or Renovate config is committed in this repo snapshot. |
| Gitignore Comprehensive | 9 / 9 | Passed | .gitignore covers node_modules, dist, env files, logs, local caches, Claude/Cursor local state, test artifacts, and app-specific generated files. |
| Secrets Management | 9 / 9 | Passed | CI and deploy workflows pull secrets from GitHub Secrets/AWS SSM and .env files are ignored; env schema/template tooling exists. |
| CODEOWNERS | 9 / 9 | Passed | .github/CODEOWNERS is present. |

## Agent Readiness

| Criterion | Coverage | Status | Rationale |
|-----------|----------|--------|-----------|
| Agent Context Quality | 4 / 9 | Failed | Root and key backend/web AGENTS.md files are concise and include common mistakes. Several apps lack app-specific agent context, and at least one inspected note appears stale. |
| Skills / Reusable Context | 6 / 9 | Failed | The repo contains CLI skills, Claude skills, and `.agents/skills` reusable context. There is no Tessl plugin manifest and several app-specific workflows are not packaged as reusable skills. |
| MCP Configuration | 4 / 9 | Failed | The repo includes mcp-manager app/config and some MCP-facing docs, but no project-level MCP server config for coding agents was found. |
| Editor / Agent Rules | 5 / 9 | Failed | .cursor commands/rules/hooks and .claude commands/skills are present, but `.cursor/rules/run.mdc` is effectively empty and several apps lack targeted rules. |
| Task Discovery | 9 / 9 | Passed | GitHub issue templates and PR template are present, and PR/title conventions plus changelog routing are documented. |

## Recommended actions

1. **Turn recurring review feedback into deterministic gates** — Add lint/ast-grep checks for empty catch blocks, missing PinoLoggerService metadata, missing endpoint guards, and service changes without nearby tests.
2. **Close CI coverage gaps for independent apps** — Add path-filtered PR jobs for apps/try, apps/analytics-cli, and apps/ast-cli, and expand typecheck/lint/format checks beyond the current narrow gates.
3. **Make agent context complete and fresh per app** — Add app-specific AGENTS.md files and reusable skills for CLI, try, mcp-manager, analytics-cli, ast-cli, logging, RBAC, Kody Rules sync, and context compression.

## Gaps → actions

| Category | Criterion | Coverage | Action |
|----------|-----------|----------|--------|
| Style & Validation | Linter Configured | 7 / 9 | Add lint scripts/config coverage for apps/try, apps/analytics-cli, and apps/ast-cli, then run them from a PR workflow. |
| Style & Validation | Code Formatter | 7 / 9 | Add a CI `format:check` job that runs Prettier checks for root backend apps, apps/web, apps/cli, apps/try, apps/analytics-cli, and apps/ast-cli. |
| Style & Validation | Type Checker / Strict Typing | 3 / 9 | Create per-app `tsconfig.strict.json` or incremental strictness configs for backend apps and wire a non-emitting typecheck job that expands beyond `typecheck:libs-gate`. |
| Style & Validation | Pre-commit Hooks | 0 / 9 | Update `.husky/pre-commit` to run a fast changed-file lint/format check, e.g. via lint-staged or a repo script. |
| Style & Validation | Dead Code Detection | 0 / 9 | Add `knip` with workspace-aware ignores and run it in advisory CI before making it required. |
| Build System | Build Command Documented | 7 / 9 | Add app-specific build/run notes for apps/try, apps/analytics-cli, and apps/ast-cli to AGENTS.md or per-app AGENTS.md files. |
| Build System | Task / Monorepo Tooling | 6 / 9 | Document the split workspace model and add root wrapper scripts for web, cli, and try build/test tasks so agents do not guess which package root to use. |
| Build System | CI Configured | 7 / 9 | Add path-filtered PR CI jobs for apps/try, apps/analytics-cli, and apps/ast-cli that run install, typecheck/build, and available tests. |
| Testing | Unit Tests Exist | 7 / 9 | Add minimal unit tests for apps/analytics-cli and apps/ast-cli entrypoint behavior or move their logic behind tested libs if they are thin wrappers. |
| Testing | Tests Runnable | 7 / 9 | Add `test:analytics-cli` and `test:ast-cli` scripts or document that their behavior is covered by specific root Jest test paths. |
| Testing | Integration / E2E Tests | 5 / 7 | Add at least one smoke/integration test for apps/try and key apps/web user flows, preferably via the existing tests/e2e harness. |
| Testing | Coverage Thresholds | 0 / 9 | Add coverage thresholds to `jest.config.ts` and `apps/cli/vitest.config.ts`, then run coverage in CI for the changed app set. |
| Documentation | README | 3 / 9 | Add short README files for apps/api, apps/worker, apps/webhooks, apps/try, apps/mcp-manager, apps/analytics-cli, and apps/ast-cli with purpose and local commands. |
| Documentation | Agent Context File | 4 / 9 | Add concise AGENTS.md files for apps/cli, apps/try, apps/mcp-manager, apps/analytics-cli, and apps/ast-cli focused on commands and common mistakes. |
| Documentation | Architecture Docs | 6 / 9 | Add a repo architecture map that links each app to its owning libs, queues, databases, and deploy workflow. |
| Documentation | API / Schema Docs | 3 / 4 | Add maintained webhook payload/response contract docs or generated schemas for apps/webhooks. |
| Documentation | Documentation Freshness | 7 / 9 | Run a documentation freshness pass over AGENTS.md/README files and add a lightweight doc-link/path check for referenced repo paths. |
| Development Environment | Dev Container | 0 / 9 | Add `.devcontainer/devcontainer.json` that uses Node 22.22.0, pnpm 11.9.0, Docker-in-Docker or compose support, and documented postCreate setup. |
| Observability | Structured Logging | 4 / 7 | Standardize logging guidance and wrappers for apps/mcp-manager, apps/cli, apps/web, and apps/try, and add lint/review checks for required metadata on backend logs. |
| Observability | Health Checks | 4 / 5 | Add a simple `/api/version` or `/health` route/readiness check for apps/try and wire it to deploy smoke checks if try is deployed. |
| Observability | Metrics / Telemetry | 6 / 9 | Define which CLI/demo apps need telemetry and add a minimal event/error reporting wrapper or explicitly document them as intentionally uninstrumented. |
| Observability | Error Tracking | 4 / 7 | Add Sentry or an intentional no-Sentry decision doc for apps/web, apps/try, apps/cli, and apps/mcp-manager. |
| Observability | Distributed Tracing | 3 / 6 | Create an observability map showing which apps emit traces and add tracing middleware/instrumentation for mcp-manager and webhooks if they are on request paths. |
| Security | Secret Scanning | 0 / 9 | Add a path-filtered `gitleaks` or `trufflehog` GitHub Actions workflow on pull_request and push. |
| Security | Dependency Update Automation | 0 / 9 | Commit `.github/dependabot.yml` or `renovate.json` covering root, apps/web, apps/cli, apps/mcp-manager, and npm subprojects. |
| Agent Readiness | Agent Context Quality | 4 / 9 | Add/update app-specific AGENTS.md files and run a path/command freshness check for all agent context files. |
| Agent Readiness | Skills / Reusable Context | 6 / 9 | Create a repo-local Tessl plugin or skill index for recurring Kodus workflows: backend logging, RBAC endpoints, Kody Rules sync, context compression, and Next.js dashboard work. |
| Agent Readiness | MCP Configuration | 4 / 9 | Add a project MCP configuration/runbook that tells agents which MCP servers are available, how to authenticate safely, and when to use them. |
| Agent Readiness | Editor / Agent Rules | 5 / 9 | Populate `.cursor/rules/run.mdc` and add targeted rules for logging, tests, RBAC guards, and Next.js app patterns. |
