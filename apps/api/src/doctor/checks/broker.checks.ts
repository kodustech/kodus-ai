import * as amqplib from 'amqplib';
import { DataSource } from 'typeorm';

import { DoctorCheck, DoctorContext, DoctorResult } from '../doctor.types';

/** Queues a code review needs a live consumer on (workflow-queue-arguments.ts). */
export const REVIEW_QUEUES = [
    {
        queue: 'workflow.jobs.webhook.queue',
        what: 'Git events (new PRs, pushes)',
    },
    {
        queue: 'workflow.jobs.code_review.queue',
        what: 'code reviews',
    },
];

/** Declared x-delayed-message (rabbitmq-topology.config.ts:18). */
export const DELAYED_EXCHANGE = 'workflow.exchange.delayed';

export const STALE_JOB_MINUTES = 30;

export interface BrokerProbe {
    connect(uri: string): Promise<{
        consumerCount(queue: string): Promise<number | null>;
        exchangeExists(exchange: string): Promise<boolean>;
        close(): Promise<void>;
    }>;
}

/**
 * A dedicated short-lived connection: passive checks close their channel on a
 * 404, so they must never run on the app's own channels. One channel per
 * check for the same reason.
 */
export const amqpBrokerProbe: BrokerProbe = {
    async connect(uri: string) {
        const connection = await amqplib.connect(uri, { timeout: 5000 });
        connection.on('error', () => undefined);

        const withChannel = async <T>(
            fn: (ch: amqplib.Channel) => Promise<T>,
            onMissing: T,
        ): Promise<T> => {
            const channel = await connection.createChannel();
            channel.on('error', () => undefined);
            try {
                return await fn(channel);
            } catch (error: any) {
                if (error?.code === 404) {
                    return onMissing;
                }
                throw error;
            } finally {
                await channel.close().catch(() => undefined);
            }
        };

        return {
            consumerCount: (queue) =>
                withChannel(
                    async (ch) => (await ch.checkQueue(queue)).consumerCount,
                    null,
                ),
            exchangeExists: (exchange) =>
                withChannel(async (ch) => {
                    await ch.checkExchange(exchange);
                    return true;
                }, false),
            close: () => connection.close().catch(() => undefined),
        };
    },
};

export function brokerCheck(probe: BrokerProbe): DoctorCheck {
    return {
        id: 'broker',
        async run({ env }: DoctorContext): Promise<DoctorResult[]> {
            if ((env.API_RABBITMQ_ENABLED ?? 'true').toLowerCase() === 'false') {
                return [
                    {
                        check: 'broker.enabled',
                        status: 'fail',
                        title: 'The message queue is turned off.',
                        impact: 'Git events are never handed to the worker, so no review runs.',
                        fix: 'Set API_RABBITMQ_ENABLED=true on api, worker and webhooks, and restart them.',
                    },
                ];
            }

            let broker: Awaited<ReturnType<BrokerProbe['connect']>>;
            try {
                broker = await probe.connect(
                    env.API_RABBITMQ_URI || 'amqp://localhost:5672/',
                );
            } catch (error: any) {
                return [
                    {
                        check: 'broker.connect',
                        status: 'fail',
                        title: 'Cannot connect to the message queue.',
                        impact: 'Git events are never handed to the worker, so no review runs.',
                        fix: `Check that RabbitMQ is running and that API_RABBITMQ_URI is correct (${String(error?.message ?? error).slice(0, 120)}).`,
                    },
                ];
            }

            const results: DoctorResult[] = [];
            try {
                for (const { queue, what } of REVIEW_QUEUES) {
                    const consumers = await broker.consumerCount(queue);
                    if (consumers === null) {
                        results.push({
                            check: 'worker.consumers',
                            status: 'fail',
                            title: `No worker has ever connected for ${what}.`,
                            impact: 'Nothing processes reviews.',
                            fix: `Start the worker service with WORKER_ROLE=code-review (queue ${queue} does not exist).`,
                        });
                    } else if (consumers === 0) {
                        results.push({
                            check: 'worker.consumers',
                            status: 'fail',
                            title: `No worker is taking ${what}.`,
                            impact: 'Reviews queue up and never run.',
                            fix: `Start or restart the worker service with WORKER_ROLE=code-review (queue ${queue} has 0 consumers).`,
                        });
                    }
                }
                if (!results.length) {
                    results.push({
                        check: 'worker.consumers',
                        status: 'ok',
                        title: 'A worker is taking Git events and code reviews.',
                    });
                }

                if (!(await broker.exchangeExists(DELAYED_EXCHANGE))) {
                    results.push({
                        check: 'broker.delayed_plugin',
                        status: 'fail',
                        title: 'The message queue cannot schedule delayed jobs.',
                        impact: 'Retries and scheduled review steps are lost.',
                        fix: `Enable the rabbitmq_delayed_message_exchange plugin (exchange ${DELAYED_EXCHANGE} is missing), or use the kodus-rabbitmq image, then restart the worker.`,
                    });
                }
            } finally {
                await broker.close();
            }

            return results;
        },
    };
}

export function staleJobsCheck(dataSource: DataSource): DoctorCheck {
    return {
        id: 'jobs.stale',
        async run(): Promise<DoctorResult[]> {
            // PENDING is never reaped (workflow-job.repository.ts:276); a job
            // scheduled for later is legitimately PENDING until then.
            const [pending] = await dataSource.query(
                `SELECT COUNT(*)::int AS count, MIN("createdAt") AS oldest
                   FROM kodus_workflow.workflow_jobs
                  WHERE status = 'PENDING'
                    AND "createdAt" < now() - make_interval(mins => $1)
                    AND ("scheduledAt" IS NULL OR "scheduledAt" < now() - make_interval(mins => $1))`,
                [STALE_JOB_MINUTES],
            );
            const [unsent] = await dataSource.query(
                `SELECT COUNT(*)::int AS count
                   FROM kodus_workflow.outbox_messages
                  WHERE status IN ('READY', 'FAILED')
                    AND attempts > 0
                    AND "createdAt" < now() - make_interval(mins => $1)`,
                [STALE_JOB_MINUTES],
            );

            const results: DoctorResult[] = [];
            if (unsent?.count > 0) {
                results.push({
                    check: 'jobs.outbox',
                    status: 'fail',
                    title: `${unsent.count} job(s) could not be handed to the message queue.`,
                    impact: 'Those reviews never start.',
                    fix: 'Check RabbitMQ health (disk and memory alarms block publishing) and the worker logs for "Error publishing message".',
                });
            }
            if (pending?.count > 0) {
                results.push({
                    check: 'jobs.pending',
                    status: 'fail',
                    title: `${pending.count} review job(s) have waited more than ${STALE_JOB_MINUTES} minutes to start (oldest ${new Date(pending.oldest).toISOString()}).`,
                    impact: 'Reviews are queued but not running.',
                    fix: 'Check that the worker is running and consuming (see the worker line above), then check the worker logs.',
                });
            }
            if (!results.length) {
                results.push({
                    check: 'jobs.pending',
                    status: 'ok',
                    title: 'No review job is stuck waiting.',
                });
            }
            return results;
        },
    };
}
