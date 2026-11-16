import type { DistributedLocks } from '../../shared/persistence/locks';
import { type CommandHandlerDeps, runtimeCommandHandlers } from '../commands/runtime-command-handlers';
import { RuntimeCommandConsumer } from './run-request.consumer';
import type { RuntimeRunRetry } from './runtime-run-retry';
import { InMemoryDistributedLocks } from '../../shared/persistence/testing';

/** A consumer over the real handlers; the PR lock is a one-process lock unless the test passes one. */
export function consumerWith(deps: Omit<CommandHandlerDeps, 'locks'> & { locks?: DistributedLocks }, retry?: RuntimeRunRetry): RuntimeCommandConsumer {
    return new RuntimeCommandConsumer(runtimeCommandHandlers({ ...deps, locks: deps.locks ?? new InMemoryDistributedLocks() }), retry);
}
