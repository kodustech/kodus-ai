import { Agent, setGlobalDispatcher } from 'undici';

/**
 * undici defaults (used by Node's native fetch) are 5 minutes for both
 * headersTimeout and bodyTimeout. Large Gemini calls with high reasoning
 * effort routinely take 4-7 minutes to produce the first byte, which
 * trips the headers timeout before our own abort signal fires.
 *
 * Bump the HTTP layer to 10 minutes so it aligns with LLM_CALL_TIMEOUT_MS
 * in agent-loop.ts. Our signal-based timeouts stay the authoritative
 * cutoff; this just prevents undici from aborting earlier.
 *
 * Call once, early in every app entry point (before NestFactory.create).
 */
export function configureLongFetchTimeouts(): void {
    setGlobalDispatcher(
        new Agent({
            headersTimeout: 10 * 60 * 1000,
            bodyTimeout: 10 * 60 * 1000,
            keepAliveTimeout: 60 * 1000,
            keepAliveMaxTimeout: 10 * 60 * 1000,
        }),
    );
}
