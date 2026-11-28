import { randomUUID } from 'crypto';

import * as amqplib from 'amqplib';
import { DataSource } from 'typeorm';

import {
    DoctorCheck,
    DoctorContext,
    DoctorResult,
    RECENT_DAYS,
} from '../doctor.types';

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

/** Jobs a pull request goes through before Kody comments. */
export const REVIEW_JOB_TYPES = [
    'WEBHOOK_PROCESSING',
    'CODE_REVIEW',
    'CLI_CODE_REVIEW',
];

/**
 * A FAILED job is retried through the delayed exchange at most an hour later
 * (rate-limit waits are capped there, rabbitmq-error.handler.ts); past this it
 * will not run again.
 */
export const FINAL_FAILURE_MINUTES = 90;
/** Same thresholds as reviews.recent: a few failures in many are noise. */
const MIN_FAILED_JOBS = 3;
const FAILED_JOBS_SHARE = 0.1;

/**
 * Longest a review job may run (CODE_REVIEW_PROCESS_TIMEOUT_MS, 1h45) plus the
 * cleanup margin: a job PROCESSING longer than this lost its worker.
 */
export const STRANDED_JOB_MINUTES = 180;

/** The x-delay the probe asks for, and how long it waits for the message. */
export const DELAYED_PROBE_DELAY_MS = 1000;
export const DELAYED_PROBE_WAIT_MS = 8000;
/**
 * A blocked connection never answers channel.close or connection.close (it
 * stops reading frames), so closing is bounded and the socket dropped after.
 */
export const BROKER_CLOSE_TIMEOUT_MS = 2000;

/**
 * `blocked`: the broker answered the publish with connection.blocked, which
 * it sends while a memory or disk alarm stops every publisher (#1694).
 */
export type DelayedRoundTrip =
    | { outcome: 'arrived' }
    | { outcome: 'lost' }
    | { outcome: 'blocked'; reason: string };

export interface BrokerProbe {
    connect(uri: string): Promise<{
        consumerCount(queue: string): Promise<number | null>;
        exchangeExists(exchange: string): Promise<boolean>;
        /**
         * Publishes one message with an x-delay to a private queue bound to
         * the exchange, and says whether it arrived within `waitMs`.
         */
        delayedRoundTrip(
            exchange: string,
            delayMs: number,
            waitMs: number,
        ): Promise<DelayedRoundTrip>;
        close(): Promise<void>;
    }>;
}

function bounded(work: Promise<unknown>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
        work.then(
            () => undefined,
            () => undefined,
        ),
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ms);
        }),
    ]).finally(() => clearTimeout(timer));
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
        let blocked: string | null = null;
        const onBlocked: Array<(reason: string) => void> = [];
        connection.on('blocked', (reason: string) => {
            blocked = reason || 'resource alarm';
            onBlocked.forEach((notify) => notify(blocked!));
        });
        // The alarm cleared while the doctor ran: publishing works again.
        connection.on('unblocked', () => {
            blocked = null;
        });

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
                await bounded(channel.close(), BROKER_CLOSE_TIMEOUT_MS);
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
            // An exclusive, server-named queue bound with a key no consumer
            // pattern matches (workflow.jobs.*.<TYPE>): the probe message
            // reaches nobody else, and the queue goes away with the channel.
            delayedRoundTrip: (exchange, delayMs, waitMs) =>
                withChannel(
                    async (ch) => {
                        const { queue } = await ch.assertQueue('', {
                            exclusive: true,
                            autoDelete: true,
                            durable: false,
                        });
                        const routingKey = `kodus.doctor.probe.${randomUUID()}`;
                        await ch.bindQueue(queue, exchange, routingKey);
                        // The broker may have blocked the connection already,
                        // during the checks above: a publish now is swallowed.
                        if (blocked) {
                            return { outcome: 'blocked', reason: blocked };
                        }
                        let timer: NodeJS.Timeout | undefined;
                        const result = new Promise<DelayedRoundTrip>(
                            (resolve) => {
                                timer = setTimeout(
                                    () => resolve({ outcome: 'lost' }),
                                    waitMs,
                                );
                                onBlocked.push((reason) =>
                                    resolve({ outcome: 'blocked', reason }),
                                );
                                // Rejects with "Channel closed" when the
                                // channel goes before consume-ok (an early
                                // resolve closes it): nothing to report then.
                                ch.consume(
                                    queue,
                                    (msg) =>
                                        msg && resolve({ outcome: 'arrived' }),
                                    { noAck: true },
                                ).catch(() => undefined);
                            },
                        );
                        ch.publish(exchange, routingKey, Buffer.from('{}'), {
                            headers: { 'x-delay': delayMs },
                            persistent: false,
                        });
                        try {
                            return await result;
                        } finally {
                            clearTimeout(timer);
                        }
                    },
                    { outcome: 'lost' } as DelayedRoundTrip,
                ),
            close: async () => {
                await bounded(connection.close(), BROKER_CLOSE_TIMEOUT_MS);
                if (blocked) {
                    // close() never completes on a blocked connection.
                    (connection as any).connection?.stream?.destroy?.();
                }
            },
        };
    },
};

export function brokerCheck(probe: BrokerProbe): DoctorCheck {
    return {
        id: 'broker',
        blocking: true,
        async run({ env }: DoctorContext): Promise<DoctorResult[]> {
            if (
                (env.API_RABBITMQ_ENABLED ?? 'true').toLowerCase() === 'false'
            ) {
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
                } else {
                    // The exchange can exist and still drop every delayed
                    // message (RabbitMQ 4.2 with the khepri_db flag, #2654):
                    // only a message that comes back proves it works.
                    const trip = await broker.delayedRoundTrip(
                        DELAYED_EXCHANGE,
                        DELAYED_PROBE_DELAY_MS,
                        DELAYED_PROBE_WAIT_MS,
                    );
                    results.push(delayedTripResult(trip));
                }
            } finally {
                await broker.close();
            }

            return results;
        },
    };
}

function delayedTripResult(trip: DelayedRoundTrip): DoctorResult {
    if (trip.outcome === 'arrived') {
        return {
            check: 'broker.delayed_delivery',
            status: 'ok',
            title: 'A delayed test message came back: retries are delivered.',
        };
    }
    if (trip.outcome === 'blocked') {
        return {
            check: 'broker.blocked',
            status: 'fail',
            title: `The message queue is blocking publishers (${trip.reason}).`,
            impact: 'No Git event or review job can be queued, so no review runs, while every service still reads as running.',
            fix: 'Free disk space or memory on the RabbitMQ host (rabbitmq-diagnostics check_alarms names the alarm); the bundled broker needs free disk above 1.2 times the RAM.',
        };
    }
    return {
        check: 'broker.delayed_delivery',
        status: 'warn',
        title: `A test message sent with a ${DELAYED_PROBE_DELAY_MS / 1000}s delay never came back after ${DELAYED_PROBE_WAIT_MS / 1000}s.`,
        impact: 'Retries are lost: a review that hits a temporary error (rate limit, provider timeout) is never retried, so that pull request gets no review.',
        fix: 'A known problem of RabbitMQ 4.2 with the khepri_db feature flag on (rabbitmqctl list_feature_flags), tracked in kodustech/kodus-ai#2654. Until a broker image without it ships, ask again for a review that failed with @kody start-review.',
    };
}

export function staleJobsCheck(dataSource: DataSource): DoctorCheck {
    return {
        id: 'jobs.stale',
        blocking: true,
        async run(): Promise<DoctorResult[]> {
            // PENDING is never reaped (WorkflowJobRepository) and FAILED outbox
            // rows are never cleaned (OutboxRelayService.cleanupOldMessages), so
            // without a lower bound an incident from months ago reads as a
            // failure today. A job scheduled for later is legitimately PENDING
            // until then.
            const [pending] = await dataSource.query(
                `SELECT COUNT(*)::int AS count, MIN("createdAt") AS oldest
                   FROM kodus_workflow.workflow_jobs
                  WHERE status = 'PENDING'
                    AND "workflowType"::text = ANY($3)
                    AND "createdAt" < now() - make_interval(mins => $1)
                    AND "createdAt" > now() - make_interval(days => $2)
                    AND ("scheduledAt" IS NULL OR "scheduledAt" < now() - make_interval(mins => $1))`,
                [STALE_JOB_MINUTES, RECENT_DAYS, REVIEW_JOB_TYPES],
            );
            // Code graph builds queue one per selected repository and run one
            // at a time (single active consumer, up to 19 min each): a backlog
            // after selecting repositories is expected and stops no review.
            const backlog: Array<{ type: string; count: number }> =
                await dataSource.query(
                    `SELECT "workflowType"::text AS type, COUNT(*)::int AS count
                       FROM kodus_workflow.workflow_jobs
                      WHERE status = 'PENDING'
                        AND NOT ("workflowType"::text = ANY($3))
                        AND "createdAt" < now() - make_interval(mins => $1)
                        AND "createdAt" > now() - make_interval(days => $2)
                        AND ("scheduledAt" IS NULL OR "scheduledAt" < now() - make_interval(mins => $1))
                      GROUP BY 1`,
                    [STALE_JOB_MINUTES, RECENT_DAYS, REVIEW_JOB_TYPES],
                );
            // Review jobs of the window by how they ended. FAILED is final
            // once no retry came for longer than the longest retry delay;
            // PROCESSING past the longest run lost its worker (OOM, restart).
            const [outcome] = await dataSource.query(
                `SELECT COUNT(*)::int AS total,
                        COUNT(*) FILTER (WHERE status = 'FAILED'
                                           AND "updatedAt" < now() - make_interval(mins => $2))::int AS failed,
                        COUNT(*) FILTER (WHERE status = 'PROCESSING'
                                           AND COALESCE("startedAt", "updatedAt") < now() - make_interval(mins => $3))::int AS stranded,
                        MODE() WITHIN GROUP (ORDER BY left("lastError", 160))
                            FILTER (WHERE status = 'FAILED'
                                      AND "updatedAt" < now() - make_interval(mins => $2)) AS "topError"
                   FROM kodus_workflow.workflow_jobs
                  WHERE "workflowType"::text = ANY($4)
                    AND "createdAt" > now() - make_interval(days => $1)
                    AND "updatedAt" > now() - make_interval(days => $1)`,
                [
                    RECENT_DAYS,
                    FINAL_FAILURE_MINUTES,
                    STRANDED_JOB_MINUTES,
                    REVIEW_JOB_TYPES,
                ],
            );
            const [unsent] = await dataSource.query(
                `SELECT COUNT(*)::int AS count
                   FROM kodus_workflow.outbox_messages
                  WHERE status IN ('READY', 'FAILED')
                    AND attempts > 0
                    AND "createdAt" < now() - make_interval(mins => $1)
                    AND "createdAt" > now() - make_interval(days => $2)`,
                [STALE_JOB_MINUTES, RECENT_DAYS],
            );

            const results: DoctorResult[] = [];
            if (unsent?.count > 0) {
                results.push({
                    check: 'jobs.outbox',
                    status: 'fail',
                    title: `${unsent.count} job(s) from the last ${RECENT_DAYS} days could not be handed to the message queue.`,
                    impact: 'Those reviews never start.',
                    fix: 'Check RabbitMQ health (disk and memory alarms block publishing) and the worker logs for "Error publishing message".',
                });
            }
            if (pending?.count > 0) {
                results.push({
                    check: 'jobs.pending',
                    status: 'fail',
                    title: `${pending.count} review job(s) from the last ${RECENT_DAYS} days have waited more than ${STALE_JOB_MINUTES} minutes to start (oldest ${new Date(pending.oldest).toISOString()}).`,
                    impact: 'Reviews are queued but not running.',
                    fix: 'Check that the worker is running and consuming (see the worker line above), then check the worker logs.',
                });
            }

            const total = outcome?.total ?? 0;
            const failed = outcome?.failed ?? 0;
            if (failed > 0) {
                const all = failed === total && total >= MIN_FAILED_JOBS;
                results.push({
                    check: 'jobs.failed',
                    status: all
                        ? 'fail'
                        : failed >= MIN_FAILED_JOBS &&
                            failed / total >= FAILED_JOBS_SHARE
                          ? 'warn'
                          : 'info',
                    title: `${failed} of ${total} review job(s) in the last ${RECENT_DAYS} days failed for good (no retry left).`,
                    impact: 'The pull requests behind them got no review.',
                    fix: `Most common error: ${outcome?.topError ?? 'none recorded'}. Check the worker logs; a lost retry also shows here when delayed messages are not delivered (see the message queue lines).`,
                });
            }
            if (outcome?.stranded > 0) {
                results.push({
                    check: 'jobs.stranded',
                    status: 'warn',
                    title: `${outcome.stranded} review job(s) started more than ${STRANDED_JOB_MINUTES / 60} hours ago and never finished.`,
                    impact: 'The worker running them stopped mid-review, so those pull requests got no review.',
                    fix: 'Check whether the worker was killed (docker inspect: OOMKilled, RestartCount; Kubernetes: lastState) and give it more memory if so.',
                });
            }
            const waiting = backlog.reduce((n, b) => n + b.count, 0);
            if (waiting > 0) {
                results.push({
                    check: 'jobs.background',
                    status: 'info',
                    title: `${waiting} background job(s) are waiting their turn (${backlog
                        .map((b) => `${b.count} ${b.type}`)
                        .join(', ')}).`,
                    impact: 'Reviews are not affected; code graph builds run one at a time, so a backlog after selecting repositories is expected.',
                });
            }
            if (!unsent?.count && !pending?.count) {
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
