/**
 * Timeouts for integration HTTP calls (GitHub, GitLab, Azure Repos,
 * Bitbucket, MCP Manager).
 *
 * LLM calls have their own (longer) budget configured via
 * configureLongFetchTimeouts() in fetch-timeouts.ts and per-request
 * AbortController inside the agent loop — do NOT use these constants for
 * those.
 *
 * Why 60s: covers the 99p of well-behaved REST APIs (including the long
 * tail of big-PR listings from GitHub/Azure) while keeping any single
 * slow peer from pinning the Node event loop past the AMQP heartbeat
 * window, which was the root cause of the zombie-worker pattern traced
 * in prod.
 */
export const INTEGRATION_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Timeout for calls to the internal MCP Manager service. Same budget as
 * integrations — the service has historically returned HTML error pages
 * under load, so failing fast is safer than waiting.
 */
export const MCP_REQUEST_TIMEOUT_MS = 60_000;
