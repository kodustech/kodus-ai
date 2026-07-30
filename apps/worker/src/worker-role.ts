/**
 * The `apps/worker` image runs in exactly one of two modes, chosen via
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
 * Every deployment needs the code-review role. The analytics role is a
 * separate Cockpit/warehouse worker and may be absent in community
 * self-hosted installs, so any fleet-wide self-hosted responsibility must
 * live on the code-review role.
 */
export type WorkerRole = 'code-review' | 'analytics';

export function resolveWorkerRole(): WorkerRole {
    const raw = process.env.WORKER_ROLE?.toLowerCase();
    if (raw === 'code-review' || raw === 'analytics') {
        return raw;
    }
    throw new Error(
        `WORKER_ROLE must be set to "code-review" or "analytics". Got ${
            raw ? `"${raw}"` : 'undefined'
        }.`,
    );
}
