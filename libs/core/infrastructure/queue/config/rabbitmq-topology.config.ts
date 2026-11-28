/**
 * Where consumer retries wait, by the exchange the failed message came from.
 *
 * Fanout-typed delayed exchanges, bound to their base exchange, which routes
 * the message by its original key once the delay expires. The topic-typed
 * `workflow.*.delayed` exchanges deliver nothing on RabbitMQ 4.2 with
 * khepri_db (the default for a new broker): Khepri indexes topic bindings only
 * for exchanges of type topic, so the plugin's topic routing finds no
 * binding (#2654). Fanout routing does not use that index.
 */
export const RETRY_EXCHANGE_BY_BASE: Readonly<Record<string, string>> = {
    'workflow.exchange': 'workflow.exchange.retry',
    'workflow.events': 'workflow.events.retry',
};

const retryExchanges = Object.values(RETRY_EXCHANGE_BY_BASE).map((name) => ({
    name,
    type: 'x-delayed-message',
    durable: true,
    options: {
        arguments: {
            'x-delayed-type': 'fanout',
        },
    },
}));

/**
 * Centralized RabbitMQ Topology Configuration.
 * This file serves as the single source of truth for ALL exchanges in the application.
 * Queues are defined directly in the @RabbitSubscribe decorators of their respective consumers.
 */
export const RABBITMQ_TOPOLOGY_CONFIG = {
    exchanges: [
        // =================================================================
        // CORE EXCHANGES (Shared across multiple domains)
        // =================================================================
        {
            name: 'orchestrator.exchange.dlx',
            type: 'topic',
            durable: true,
        },
        {
            name: 'orchestrator.exchange.delayed',
            type: 'x-delayed-message',
            durable: true,
            options: {
                arguments: {
                    'x-delayed-type': 'direct',
                },
            },
        },

        // =================================================================
        // WORKFLOW DOMAIN EXCHANGES
        // =================================================================
        {
            name: 'workflow.exchange',
            type: 'topic',
            durable: true,
        },
        {
            name: 'workflow.exchange.dlx',
            type: 'topic',
            durable: true,
        },
        {
            // Delayed exchange for retry with backoff
            // Requires: rabbitmq_delayed_message_exchange plugin
            // Messages published here with x-delay header will be held and then
            // forwarded to the bound queues after the delay expires.
            name: 'workflow.exchange.delayed',
            type: 'x-delayed-message',
            durable: true,
            options: {
                arguments: {
                    'x-delayed-type': 'topic',
                },
            },
        },
        {
            name: 'workflow.events',
            type: 'topic',
            durable: true,
        },
        {
            name: 'workflow.events.dlx',
            type: 'topic',
            durable: true,
        },
        {
            // Delayed exchange for retry with backoff (events)
            // Requires: rabbitmq_delayed_message_exchange plugin
            name: 'workflow.events.delayed',
            type: 'x-delayed-message',
            durable: true,
            options: {
                arguments: {
                    'x-delayed-type': 'topic',
                },
            },
        },

        ...retryExchanges,

        // =================================================================
        // NOTIFICATIONS DOMAIN EXCHANGES
        // =================================================================
        {
            name: 'notification.exchange',
            type: 'topic',
            durable: true,
        },
    ],
    exchangeBindings: Object.entries(RETRY_EXCHANGE_BY_BASE).map(
        ([base, retry]) => ({
            source: retry,
            destination: base,
            // Ignored by a fanout source.
            pattern: '',
        }),
    ),
};
