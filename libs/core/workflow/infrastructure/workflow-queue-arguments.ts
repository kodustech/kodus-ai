/**
 * Single source of truth for workflow.jobs.*.queue AMQP queue arguments.
 *
 * RabbitMQ rejects a queue (re)declaration whose arguments differ from the
 * live queue's by closing the channel with 406 PRECONDITION_FAILED — and
 * amqp-connection-manager then tears the whole connection down and retries,
 * producing an infinite reconnect loop where NO consumer stays registered.
 * That is exactly what happened when RabbitMQDLQInitializer asserted these
 * queues from its own (stale) copy of the arguments that lacked the AST
 * queues' `x-single-active-consumer`/`x-consumer-timeout`.
 *
 * Both declaration sites — the @RabbitSubscribe decorators in
 * workflow-job-consumer.service.ts and the eager assert in
 * rabbitmq-dlq.initializer.ts — MUST reference this module so they can never
 * drift apart again. Do not inline queue arguments at either site.
 */
export const WORKFLOW_JOB_QUEUE_ARGUMENTS: Record<
    string,
    Record<string, unknown>
> = {
    'workflow.jobs.webhook.queue': {
        'x-queue-type': 'quorum',
        'x-dead-letter-exchange': 'workflow.exchange.dlx',
        'x-dead-letter-routing-key': 'workflow.job.failed',
    },
    'workflow.jobs.code_review.queue': {
        'x-queue-type': 'quorum',
        'x-dead-letter-exchange': 'workflow.exchange.dlx',
        'x-dead-letter-routing-key': 'workflow.job.failed',
    },
    'workflow.jobs.cli_code_review.queue': {
        'x-queue-type': 'quorum',
        'x-dead-letter-exchange': 'workflow.exchange.dlx',
        'x-dead-letter-routing-key': 'workflow.job.failed',
    },
    'workflow.jobs.check_implementation.queue': {
        'x-queue-type': 'quorum',
        'x-dead-letter-exchange': 'workflow.exchange.dlx',
        'x-dead-letter-routing-key': 'workflow.job.failed',
    },
    'workflow.jobs.ast_graph_build.queue': {
        'x-queue-type': 'quorum',
        'x-single-active-consumer': true,
        'x-consumer-timeout': 25 * 60 * 1000,
        'x-dead-letter-exchange': 'workflow.exchange.dlx',
        'x-dead-letter-routing-key': 'workflow.job.failed',
    },
    'workflow.jobs.ast_graph_incremental.queue': {
        'x-queue-type': 'quorum',
        'x-single-active-consumer': true,
        'x-consumer-timeout': 15 * 60 * 1000,
        'x-dead-letter-exchange': 'workflow.exchange.dlx',
        'x-dead-letter-routing-key': 'workflow.job.failed',
    },
};
