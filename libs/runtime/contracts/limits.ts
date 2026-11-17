// Limits both sides of the queue default to (the worker's config.ts and the API's runtime-api.config.ts).
/** Tokens a Run may spend when RUNTIME_MAX_TOKENS_PER_RUN is unset, on both sides of the queue. */
export const DEFAULT_MAX_TOKENS_PER_RUN = 200_000;
/** The share of a Run's measured changed lines that must run for it to stay green, in percent, when RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT is unset. */
export const DEFAULT_EXERCISED_LINES_THRESHOLD_PERCENT = 50;
