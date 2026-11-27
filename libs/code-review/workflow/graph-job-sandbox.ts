import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';
import { raceWithAbortSignal } from '@libs/core/workflow/infrastructure/abort-signal-race';
import { parseDrainTimeoutMs } from '@libs/core/workflow/infrastructure/drain-timeout';
import { runWithBoundedTimeout } from '@libs/core/workflow/infrastructure/run-with-bounded-timeout';
import { AcquireResult } from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';

@Injectable()
export class GraphJobSandbox implements BeforeApplicationShutdown {
    private readonly logger = createLogger(GraphJobSandbox.name);
    private readonly pending = new Set<Promise<void>>();
    private stopping = false;

    async acquire(
        acquire: () => Promise<AcquireResult>,
        signal: AbortSignal | undefined,
        release: (lease: AcquireResult) => Promise<void>,
    ): Promise<AcquireResult> {
        signal?.throwIfAborted();
        if (this.stopping)
            throw new Error('Graph sandbox worker is shutting down');

        const acquisition = acquire();
        const handoff = raceWithAbortSignal(acquisition, signal);
        // Track from the start: shutdown may begin before the job times out.
        const cleanup = handoff
            .then(
                () => {},
                () => acquisition.then(release, () => {}),
            )
            .catch((error) => {
                this.logger.error({
                    message: 'Failed to release a late graph sandbox',
                    context: GraphJobSandbox.name,
                    error,
                });
            });
        this.pending.add(cleanup);
        void cleanup.then(() => this.pending.delete(cleanup));
        return handoff;
    }

    async beforeApplicationShutdown(): Promise<void> {
        this.stopping = true;
        if (!this.pending.size) return;
        try {
            await runWithBoundedTimeout(
                Promise.all(this.pending),
                parseDrainTimeoutMs(),
                'graph sandbox cleanup',
            );
        } catch (error) {
            this.logger.warn({
                message:
                    'Graph sandbox cleanup exceeded the worker drain timeout',
                context: GraphJobSandbox.name,
                error,
                metadata: { pending: this.pending.size },
            });
        }
    }
}
