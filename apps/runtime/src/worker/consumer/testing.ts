import { EventEmitter } from 'events';

import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { AmqpConnectionManagerClass } from 'amqp-connection-manager';

import type { DistributedLocks } from '../../shared/persistence/locks';
import { type CommandHandlerDeps, runtimeCommandHandlers } from '../commands/runtime-command-handlers';
import { RuntimeCommandConsumer } from './run-request.consumer';
import type { RuntimeRunRetry } from './runtime-run-retry';
import { InMemoryDistributedLocks } from '../../shared/persistence/testing';

/** A consumer over the real handlers; the PR lock is a one-process lock unless the test passes one. */
export function consumerWith(deps: Omit<CommandHandlerDeps, 'locks'> & { locks?: DistributedLocks }, retry?: RuntimeRunRetry): RuntimeCommandConsumer {
    return new RuntimeCommandConsumer(runtimeCommandHandlers({ ...deps, locks: deps.locks ?? new InMemoryDistributedLocks() }), retry);
}

/**
 * The installed publish path (AmqpConnection.publish over a confirm ChannelWrapper) on a channel
 * whose write buffer answers `writeHasRoom` and whose broker answers `confirm` (null = ack).
 * No network: the wrapper is handed the channel as on a connect.
 */
export async function confirmTransport(writeHasRoom: boolean, confirm: Error | null) {
    const manager = new AmqpConnectionManagerClass([]);
    const wrapper = manager.createChannel({ confirm: true });
    const channel = Object.assign(new EventEmitter(), {
        publish: (_exchange: string, _key: string, _content: Buffer, _options: unknown, done: (err: Error | null) => void) => {
            setImmediate(() => done(confirm));
            return writeHasRoom;
        },
    });
    await (wrapper as unknown as { _onConnect(c: unknown): Promise<void> })._onConnect({ connection: { createConfirmChannel: async () => channel } });
    const facade = { _managedChannel: wrapper, config: { defaultPublishOptions: {}, serializer: JSON.stringify } };
    return {
        publish: (AmqpConnection.prototype.publish as (...a: unknown[]) => Promise<boolean>).bind(facade) as AmqpConnection['publish'],
        close: () => manager.close(),
    };
}
