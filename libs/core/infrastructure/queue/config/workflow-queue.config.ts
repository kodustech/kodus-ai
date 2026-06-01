const DEFAULT_WORKFLOW_QUEUE_MAX_RETRIES = 2;

export const WORKFLOW_QUEUE_MAX_RETRIES = (() => {
    const parsed = Number.parseInt(
        process.env.WORKFLOW_QUEUE_WORKER_MAX_RETRIES ?? '',
        10,
    );

    return Number.isFinite(parsed)
        ? parsed
        : DEFAULT_WORKFLOW_QUEUE_MAX_RETRIES;
})();
