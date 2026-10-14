/**
 * Centralized RabbitMQ Topology Configuration.
 * This file serves as the single source of truth for ALL exchanges in the application.
 * Queues are defined directly in the @RabbitSubscribe decorators of their respective consumers.
 *
 * No `x-delayed-message` exchange is declared: declaring one fails on a broker
 * without the unmaintained delayed-message plugin, which RabbitMQ >= 4.3
 * cannot run (#1663). Delayed retries go through rabbitmq-retry-topology.ts.
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
            // Used to be `orchestrator.exchange.delayed` (x-delayed-type
            // direct), which consumers bound to directly with no base
            // exchange behind it.
            name: 'orchestrator.exchange',
            type: 'direct',
            durable: true,
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
            name: 'workflow.events',
            type: 'topic',
            durable: true,
        },
        {
            name: 'workflow.events.dlx',
            type: 'topic',
            durable: true,
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
