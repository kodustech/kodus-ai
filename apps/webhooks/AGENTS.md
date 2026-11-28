# Webhooks - Event Ingestion Server

NestJS REST API that receives webhooks from git platforms. Producer only (never consumes from RabbitMQ).

## What Agents Get Wrong

- Fire-and-forget: returns HTTP 200 immediately, then enqueues via `setImmediate()`. Never process webhooks synchronously
- Uses **outbox pattern**: creates WorkflowJob + OutboxMessage in a single PostgreSQL transaction, then publishes to RabbitMQ. This ensures delivery even if RabbitMQ is down
- GitHub `push` events pass only for merge queue branches and for a repository's default branch (a Runtime environment's setup, `docs/runtime/fork-from-checkpoint.md` R6); every other push is ignored before it is enqueued
- One controller per git platform: GitHub, GitLab, Bitbucket, Azure Repos, Forgejo
- Only **Azure Repos** validates webhook tokens (AES-256-CBC). Other platforms have no signature validation
- Forgejo controller checks multiple headers for compatibility: `x-forgejo-event`, `x-gitea-event`, `x-github-event`, `x-gogs-event`
- PostgreSQL pool size is 8 (smaller than API's 25) — this app is lightweight
