import { raceWithAbortSignal } from '@libs/core/workflow/infrastructure/abort-signal-race';
import { AcquireResult } from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';

export async function acquireGraphJobSandbox(
    acquire: () => Promise<AcquireResult>,
    signal: AbortSignal | undefined,
    release: (lease: AcquireResult) => Promise<void>,
): Promise<AcquireResult> {
    signal?.throwIfAborted();
    const pending = acquire();
    try {
        return await raceWithAbortSignal(pending, signal);
    } catch (error) {
        if (signal?.aborted) {
            // The provider can return a lease after the job's finally has run.
            void pending.then(release, () => {});
        }
        throw error;
    }
}
