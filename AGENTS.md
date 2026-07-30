# Kodus AI

AI-powered code review platform. Monorepo with 4 NestJS/Next.js apps, 20 shared libs, and 2 published npm packages.

## Structure

- `apps/api/` - NestJS REST API (auth, code review orchestration, kody rules, integrations, permissions)
- `apps/web/` - Next.js 15 dashboard (App Router, Radix UI, React Query, NextAuth)
- `apps/worker/` - RabbitMQ consumer (webhook processing, code review execution, suggestion checks, monitoring crons)
- `apps/webhooks/` - Webhook ingestion (GitHub, GitLab, Azure Repos, Bitbucket, Forgejo). Fire-and-forget with outbox pattern
- `libs/` - 20 NestJS domain modules (core, code-review, ai-engine, agents, integrations, platform, identity, organization, etc.)
- `packages/kodus-common/` - Published npm package with LLM abstraction layer (OpenAI, Anthropic, Gemini, Vertex AI, Novita)

## Stack

- Node.js 22, TypeScript (ES2022), Yarn workspaces
- Backend: NestJS with `@golevelup/nestjs-rabbitmq`
- Frontend: Next.js 15 (App Router + Turbopack), Radix UI + TailwindCSS 4, React Query v5
- Databases: PostgreSQL (TypeORM) + MongoDB (Mongoose)
- Queue: RabbitMQ with delayed message exchange plugin (quorum queues)
- Auth: JWT + refresh tokens, OAuth (GitHub/GitLab), SAML SSO, Team CLI keys (`kodus_*` prefix)
- Observability: OpenTelemetry, Pyroscope profiling, BetterStack heartbeats, Sentry
- LLM Providers: Anthropic, OpenAI, Google Gemini, Vertex AI, Novita (with BYOK support)

## Getting Started

- Node.js 22.22.0 required (`.nvmrc` at root). Run `nvm use` if you get version errors
- `pnpm run setup` - First-time project setup

## Commands

Everything runs via Docker (`docker-compose.dev.yml`):

- `pnpm run docker:start` - Start full dev environment (API + worker + webhooks + DBs)
- `pnpm run docker:start:api` - Start only API + databases
- `pnpm run docker:start:worker` - Start only worker + databases
- `pnpm run docker:start:webhooks` - Start only webhooks + databases
- `pnpm run docker:start:web` - Start web frontend
- `pnpm run docker:start:all` - Start all services including web
- `pnpm run docker:up:infra` - Start only infra (databases, RabbitMQ)
- `pnpm run docker:down` - Stop all containers
- `pnpm run docker:logs` - Follow logs (API, worker, webhooks)
- `pnpm run docker:logs:api` / `docker:logs:worker` / `docker:logs:webhooks` - Logs per service
- `pnpm run dev:restart` - Stop + rebuild + start
- `pnpm run dev:clean` - Full reset (prune + restart)
- `pnpm run test` - Jest test suite (API_NODE_ENV=test)
- `pnpm run build:apps` - Build all apps in parallel
- `pnpm run migration:generate` - Generate TypeORM migrations
- `pnpm run lint` - ESLint with auto-fix
- `pnpm run format` - Prettier

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
- Organization > Team > Members hierarchy
- Git integrations: GitHub, GitLab, Bitbucket, Azure Repos, Forgejo
- Project management integrations: Jira, Linear, Azure Boards
- "Dry Run" is a preview mode to test code review rules before enabling
- CLI reviews via team API keys (`x-team-key` header or `Bearer kodus_*`)
