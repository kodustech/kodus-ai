import { registerAs } from '@nestjs/config';
import { WorkflowQueueConfig } from '../types/general/workflow-queue.type';
import { DEFAULT_WORKFLOW_QUEUE_MAX_RETRIES } from '../../queue/config/workflow-queue.config';

function parseIntOrDefault(raw: string | undefined, defaultValue: number) {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

export const WorkflowQueueLoader = registerAs(
    'workflowQueue',
    (): WorkflowQueueConfig => ({
        WORKFLOW_QUEUE_WORKER_PREFETCH: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_WORKER_PREFETCH,
            20,
        ),
        WORKFLOW_QUEUE_PUBLISHER_PREFETCH: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_PUBLISHER_PREFETCH,
            5,
        ),
        WORKFLOW_QUEUE_WEBHOOK_PREFETCH: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_WEBHOOK_PREFETCH,
            20,
        ),
        WORKFLOW_QUEUE_CODE_REVIEW_PREFETCH: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_CODE_REVIEW_PREFETCH,
            20,
        ),
        WORKFLOW_QUEUE_CHECK_IMPLEMENTATION_PREFETCH: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_CHECK_IMPLEMENTATION_PREFETCH,
            20,
        ),
        WORKFLOW_QUEUE_FEEDBACK_PREFETCH: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_FEEDBACK_PREFETCH,
            20,
        ),
        WORKFLOW_QUEUE_WORKER_MAX_RETRIES: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_WORKER_MAX_RETRIES,
            DEFAULT_WORKFLOW_QUEUE_MAX_RETRIES,
        ),
        WORKFLOW_QUEUE_WORKER_RETRY_DELAY_MS: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_WORKER_RETRY_DELAY_MS,
            1000,
        ),
        WORKFLOW_QUEUE_WEBHOOK_PROCESS_TIMEOUT_MS: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_WEBHOOK_PROCESS_TIMEOUT_MS,
            10 * 60 * 1000,
        ),
        WORKFLOW_QUEUE_CODE_REVIEW_PROCESS_TIMEOUT_MS: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_CODE_REVIEW_PROCESS_TIMEOUT_MS,
            2 * 60 * 60 * 1000,
        ),
        WORKFLOW_QUEUE_CHECK_IMPLEMENTATION_TIMEOUT_MS: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_CHECK_IMPLEMENTATION_TIMEOUT_MS,
            10 * 60 * 1000,
        ),
        WORKFLOW_QUEUE_HANDLER_TIMEOUT_MS: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_HANDLER_TIMEOUT_MS,
            60000,
        ),
        WORKFLOW_QUEUE_CIRCUIT_BREAKER_FAILURE_THRESHOLD: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
            5,
        ),
        WORKFLOW_QUEUE_CIRCUIT_BREAKER_TIMEOUT_MS: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_CIRCUIT_BREAKER_TIMEOUT_MS,
            60000,
        ),
        WORKFLOW_QUEUE_AUTO_SCALE_ENABLED:
            process.env.WORKFLOW_QUEUE_AUTO_SCALE_ENABLED === 'true' || false,
        WORKFLOW_QUEUE_AUTO_SCALE_MIN_WORKERS: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_AUTO_SCALE_MIN_WORKERS,
            1,
        ),
        WORKFLOW_QUEUE_AUTO_SCALE_MAX_WORKERS: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_AUTO_SCALE_MAX_WORKERS,
            10,
        ),
        WORKFLOW_QUEUE_AUTO_SCALE_QUEUE_THRESHOLD: parseIntOrDefault(
            process.env.WORKFLOW_QUEUE_AUTO_SCALE_QUEUE_THRESHOLD,
            50,
        ),
    }),
);
