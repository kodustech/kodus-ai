/**
 * The `apps/worker` image runs in exactly one of three modes, chosen via
 * `WORKER_ROLE`:
 *
 *   code-review  → RabbitMQ consumers, code review pipeline, outbox
 *                  relay, monitors, and the self-hosted telemetry
 *                  heartbeat. Does not touch the analytics warehouse.
 *   analytics    → Analytics ingestion cron + warehouse connection.
 *                  No queue consumers (`enableConsumers: false`), but
 *                  RabbitMQWrapperModule is still imported because
 *                  OrganizationModule transitively pulls in
 *                  WorkflowModule, whose WorkflowJobQueueService
 *                  injects MESSAGE_BROKER_SERVICE_TOKEN at construction.
 *                  Cost is a single idle AMQP connection; the cleaner
 *                  alternative is a refactor of the
 *                  OrganizationParametersModule → PlatformModule edge.
 *
 *   security-scan → Only the deep scan's queue (#2451): long, model-heavy
 *                  jobs that would otherwise share a process with reviews.
 *                  Same job pipeline as code-review, none of its crons,
 *                  monitors or outbox relay. The deep scan is cloud-only,
 *                  so self-hosted installs run without it.
 *
 * Every deployment needs the code-review role. The analytics role is a
 * separate Cockpit/warehouse worker and may be absent in community
 * self-hosted installs, so any fleet-wide self-hosted responsibility must
 * live on the code-review role.
 */
export type WorkerRole = 'code-review' | 'analytics' | 'security-scan';

export function resolveWorkerRole(): WorkerRole {
    const raw = process.env.WORKER_ROLE?.toLowerCase();
    if (
        raw === 'code-review' ||
        raw === 'analytics' ||
        raw === 'security-scan'
    ) {
        return raw;
    }
    throw new Error(
        `WORKER_ROLE must be set to "code-review", "analytics" or "security-scan". Got ${
            raw ? `"${raw}"` : 'undefined'
        }.`,
    );
}
