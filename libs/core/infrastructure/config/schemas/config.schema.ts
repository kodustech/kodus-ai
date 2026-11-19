import * as Joi from 'joi';

export const configSchema = Joi.object({
    API_HOST: Joi.string().default('localhost'),
    API_PORT: Joi.number().required(),
    API_RATE_MAX_REQUEST: Joi.number().default(100),
    API_RATE_INTERVAL: Joi.number().default(60),
    API_BETTERSTACK_API_TOKEN: Joi.string().optional().allow('').default(''),
    API_BETTERSTACK_HEARTBEAT_ERROR_RATE_URL: Joi.string()
        .optional()
        .allow('')
        .default(''),
    API_BETTERSTACK_HEARTBEAT_REVIEW_MONITOR_URL: Joi.string()
        .optional()
        .allow('')
        .default(''),
    API_BETTERSTACK_HEARTBEAT_OUTBOX_URL: Joi.string()
        .optional()
        .allow('')
        .default(''),
    API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL: Joi.string()
        .optional()
        .allow('')
        .default(''),
    // Worker main-thread stall alerts (apps/worker/src/stall-watchdog.ts).
    API_BETTERSTACK_HEARTBEAT_WORKER_STALL_URL: Joi.string()
        .optional()
        .allow('')
        .default(''),
    METRICS_ERROR_RATE_THRESHOLD_PERCENT: Joi.number().optional().default(10),
    METRICS_ERROR_RATE_CRITICAL_PERCENT: Joi.number().optional().default(25),
    METRICS_ERROR_RATE_WINDOW_MINUTES: Joi.number().optional().default(5),
    REVIEW_RESPONSE_AVG_THRESHOLD_MS: Joi.number().optional().default(600000),
    REVIEW_RESPONSE_AVG_CRITICAL_MS: Joi.number().optional().default(1200000),
    REVIEW_RESPONSE_P95_THRESHOLD_MS: Joi.number().optional().default(600000),
    REVIEW_RESPONSE_P95_CRITICAL_MS: Joi.number().optional().default(1200000),
    WEBHOOK_FAILURE_THRESHOLD_PERCENT: Joi.number().optional().default(10),
    WEBHOOK_FAILURE_WINDOW_MINUTES: Joi.number().optional().default(30),
});
