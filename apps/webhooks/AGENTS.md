# Webhooks - Event Ingestion Server

NestJS REST API that receives webhooks from git platforms. Producer only (never consumes from RabbitMQ).

## What Agents Get Wrong

- Durable acknowledgement: return HTTP 200 only after WorkflowJob + OutboxMessage commit. Return 503 so the provider retries when persistence is unavailable; business processing remains asynchronous
- Uses **outbox pattern**: creates WorkflowJob + OutboxMessage in a single PostgreSQL transaction, then publishes to RabbitMQ. This ensures delivery even if RabbitMQ is down
- One controller per git platform: GitHub, GitLab, Bitbucket, Azure Repos, Forgejo
- Azure Repos validates its encrypted query token. GitHub, GitLab, Bitbucket and Forgejo use `WebhookSignatureService`; validation is migration-safe by default and fail-closed when configured/required
- Provider delivery IDs become workflow idempotency keys, so webhook redeliveries reuse the original job
- Forgejo controller checks multiple headers for compatibility: `x-forgejo-event`, `x-gitea-event`, `x-github-event`, `x-gogs-event`
- PostgreSQL pool size is 8 (smaller than API's 25) — this app is lightweight
