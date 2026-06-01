import { Injectable, OnApplicationShutdown } from '@nestjs/common';

import { flushLangfuse, shutdownLangfuse } from './langfuse';

/**
 * Drains the Langfuse span batch on graceful shutdown (SIGTERM / SIGINT
 * routed through Nest's `enableShutdownHooks`). Without this, the up-to-5s
 * of spans sitting in the batch processor's queue are lost on every
 * deploy / restart.
 *
 * Crash paths (`uncaughtException`, `unhandledRejection`) bypass Nest's
 * lifecycle entirely — those are handled separately by the
 * `process.on(...)` handlers installed in `createLangfuseSpanProcessor()`.
 */
@Injectable()
export class LangfuseShutdownProvider implements OnApplicationShutdown {
    async onApplicationShutdown(): Promise<void> {
        await flushLangfuse();
        await shutdownLangfuse();
    }
}
