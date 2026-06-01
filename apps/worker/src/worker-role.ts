/**
 * The `apps/worker` image runs in exactly one of two modes, chosen via
 * `WORKER_ROLE`:
 *
 *   code-review  → RabbitMQ consumers, code review pipeline, outbox
 *                  relay, monitors. Does not touch the analytics
 *                  warehouse.
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
 * Both cloud and self-hosted deploy both replicas. Keeping the topology
 * identical across environments is a non-negotiable property of this
 * migration (see issue #951): one pipeline, same bugs, same fixes.
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
