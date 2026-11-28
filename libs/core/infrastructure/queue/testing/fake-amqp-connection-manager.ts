import { EventEmitter } from 'events';

type ChannelSetup = (channel: FakeAmqpChannel) => Promise<unknown>;

/**
 * The amqplib channel surface that `@golevelup/nestjs-rabbitmq` touches while
 * it sets up a managed channel (prefetch, exchanges, the direct reply-to
 * consumer).
 */
export interface FakeAmqpChannel {
    prefetch: jest.Mock;
    assertExchange: jest.Mock;
    checkExchange: jest.Mock;
    bindExchange: jest.Mock;
    consume: jest.Mock;
}

function createFakeAmqpChannel(): FakeAmqpChannel {
    return {
        prefetch: jest.fn().mockResolvedValue(undefined),
        assertExchange: jest.fn().mockResolvedValue(undefined),
        checkExchange: jest.fn().mockResolvedValue(undefined),
        bindExchange: jest.fn().mockResolvedValue(undefined),
        consume: jest.fn().mockResolvedValue({ consumerTag: 'reply-to' }),
    };
}

/**
 * Stand-in for amqp-connection-manager's ChannelWrapper: keeps its setups
 * and runs every one of them on each (re)connect, as the real wrapper does.
 */
export class FakeChannelWrapper extends EventEmitter {
    private readonly setups: ChannelSetup[] = [];
    private channel?: FakeAmqpChannel;

    constructor(readonly name: string) {
        super();
    }

    addSetup(setup: ChannelSetup): Promise<unknown> {
        this.setups.push(setup);
        return this.channel ? setup(this.channel) : Promise.resolve();
    }

    async onConnect(): Promise<void> {
        this.channel = createFakeAmqpChannel();
        await Promise.all(this.setups.map((setup) => setup(this.channel!)));
        this.emit('connect');
    }

    onDisconnect(): void {
        this.channel = undefined;
        this.emit('close');
    }
}

/**
 * Stand-in for amqp-connection-manager's AmqpConnectionManager. The broker is
 * driven by the test: `brokerUp()` is the moment the manager's retry loop
 * finally reaches it, `brokerDown()` a dropped connection.
 */
export class FakeAmqpConnectionManager extends EventEmitter {
    readonly channels: FakeChannelWrapper[] = [];
    private connected = false;

    isConnected(): boolean {
        return this.connected;
    }

    createChannel({ name }: { name: string }): FakeChannelWrapper {
        const channel = new FakeChannelWrapper(name);
        this.channels.push(channel);
        return channel;
    }

    failAttempt(): void {
        this.emit('connectFailed', { err: new Error('ECONNREFUSED') });
    }

    async brokerUp(): Promise<void> {
        this.connected = true;
        this.emit('connect', { connection: {} });
        await Promise.all(this.channels.map((c) => c.onConnect()));
    }

    brokerDown(): void {
        this.connected = false;
        this.emit('disconnect', { err: new Error('CONNECTION_FORCED') });
        this.channels.forEach((c) => c.onDisconnect());
    }

    close(): Promise<void> {
        this.connected = false;
        return Promise.resolve();
    }
}

export function createSilentAmqpLogger() {
    return {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        verbose: jest.fn(),
    };
}
