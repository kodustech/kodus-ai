// Limits both sides of the queue default to (the worker's config.ts and the API's runtime-api.config.ts).
/** Tokens a Run may spend when RUNTIME_MAX_TOKENS_PER_RUN is unset, on both sides of the queue. */
export const DEFAULT_MAX_TOKENS_PER_RUN = 200_000;
