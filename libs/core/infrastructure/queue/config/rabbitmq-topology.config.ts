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

        // =================================================================
        // NOTIFICATIONS DOMAIN EXCHANGES
        // =================================================================
        {
            name: 'notification.exchange',
            type: 'topic',
            durable: true,
        },
    ],
};
