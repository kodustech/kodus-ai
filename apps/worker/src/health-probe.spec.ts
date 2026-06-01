import * as http from 'http';
import { startHealthProbe } from './health-probe';

/**
 * Fetches GET /health from the probe HTTP server and parses the response.
 * Uses port 0 so each test gets a free OS-assigned port.
 */
function getHealth(server: http.Server): Promise<{
    statusCode: number;
    body: Record<string, unknown>;
}> {
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Probe server has no inet address');
    }
    const port = address.port;
    return new Promise((resolve, reject) => {
        const req = http.get(
            `http://127.0.0.1:${port}/health`,
            { timeout: 1000 },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    try {
                        resolve({
                            statusCode: res.statusCode ?? 0,
                            body: JSON.parse(
                                Buffer.concat(chunks).toString('utf-8'),
                            ),
                        });
                    } catch (err) {
                        reject(err);
                    }
                });
                res.on('error', reject);
            },
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('probe request timed out'));
        });
    });
}

function makeAppContext(amqp: unknown): any {
    return { get: () => amqp };
}

function closeServer(server: http.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

async function waitListening(server: http.Server): Promise<void> {
    if (server.listening) return;
    return new Promise((resolve) => server.once('listening', () => resolve()));
}

describe('startHealthProbe', () => {
    let server: http.Server | undefined;

    afterEach(async () => {
        if (server) {
            await closeServer(server);
            server = undefined;
        }
    });

    it('returns ok_no_amqp when requireAmqp is false', async () => {
        server = startHealthProbe({
            port: 0,
            appContext: makeAppContext(undefined),
            requireAmqp: false,
        });
        await waitListening(server);

        const res = await getHealth(server);

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok_no_amqp');
    });

    it('returns 503 amqp_not_resolved when DI cannot resolve AmqpConnection', async () => {
        const appContext = {
            get: () => {
                throw new Error('not found');
            },
        } as any;
        server = startHealthProbe({
            port: 0,
            appContext,
            requireAmqp: true,
        });
        await waitListening(server);

        const res = await getHealth(server);

        expect(res.statusCode).toBe(503);
        expect(res.body.status).toBe('amqp_not_resolved');
    });

    it('returns 503 amqp_disconnected when managedConnection.isConnected() is false', async () => {
        const amqp = {
            managedConnection: { isConnected: () => false },
        };
        server = startHealthProbe({
            port: 0,
            appContext: makeAppContext(amqp),
            requireAmqp: true,
        });
        await waitListening(server);

        const res = await getHealth(server);

        expect(res.statusCode).toBe(503);
        expect(res.body.status).toBe('amqp_disconnected');
    });

    it('returns ok_starting while inside the startup grace window', async () => {
        // Empty managedChannels + empty _consumers — would normally be 503,
        // but grace window short-circuits to healthy.
        const amqp = {
            managedConnection: { isConnected: () => true },
            managedChannels: {},
            _consumers: {},
        };
        server = startHealthProbe({
            port: 0,
            appContext: makeAppContext(amqp),
            requireAmqp: true,
            requiredChannels: ['channel-webhook'],
            startupGraceMs: 60_000,
        });
        await waitListening(server);

        const res = await getHealth(server);

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok_starting');
    });

    it('returns ok when all required channels have consumers in v9 layout', async () => {
        // v9 layout: consumers live on AmqpConnection._consumers (Record by
        // consumerTag) with consumer.msgOptions.channel naming the channel.
        const amqp = {
            managedConnection: { isConnected: () => true },
            managedChannels: {
                'channel-webhook': {},
                'channel-code-review': {},
                'channel-feedback': {},
            },
            _consumers: {
                'tag-wh': {
                    type: 'subscribe',
                    consumerTag: 'tag-wh',
                    msgOptions: { queueOptions: { channel: 'channel-webhook' } },
                },
                'tag-cr': {
                    type: 'subscribe',
                    consumerTag: 'tag-cr',
                    msgOptions: { queueOptions: { channel: 'channel-code-review' } },
                },
                'tag-fb': {
                    type: 'subscribe',
                    consumerTag: 'tag-fb',
                    msgOptions: { queueOptions: { channel: 'channel-feedback' } },
                },
            },
        };
        server = startHealthProbe({
            port: 0,
            appContext: makeAppContext(amqp),
            requireAmqp: true,
            requiredChannels: [
                'channel-webhook',
                'channel-code-review',
                'channel-feedback',
            ],
            startupGraceMs: 0,
        });
        await waitListening(server);

        const res = await getHealth(server);

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    it('returns 503 consumer_missing with `noConsumer` when a channel has zero consumers (zombie pattern)', async () => {
        // 'channel-feedback' is registered but no consumer ever attached.
        const amqp = {
            managedConnection: { isConnected: () => true },
            managedChannels: {
                'channel-webhook': {},
                'channel-feedback': {},
            },
            _consumers: {
                'tag-wh': {
                    type: 'subscribe',
                    consumerTag: 'tag-wh',
                    msgOptions: { queueOptions: { channel: 'channel-webhook' } },
                },
            },
        };
        server = startHealthProbe({
            port: 0,
            appContext: makeAppContext(amqp),
            requireAmqp: true,
            requiredChannels: ['channel-webhook', 'channel-feedback'],
            startupGraceMs: 0,
        });
        await waitListening(server);

        const res = await getHealth(server);

        expect(res.statusCode).toBe(503);
        expect(res.body.status).toBe('consumer_missing');
        expect(res.body.noConsumer).toEqual(['channel-feedback']);
        expect(res.body.missing).toEqual([]);
        expect(res.body.consumersByChannel).toEqual({ 'channel-webhook': 1 });
    });

    it('returns 503 consumer_missing with `missing` when a channel is not in managedChannels', async () => {
        const amqp = {
            managedConnection: { isConnected: () => true },
            managedChannels: {
                'channel-webhook': {},
                // 'channel-feedback' not declared at all
            },
            _consumers: {
                'tag-wh': {
                    type: 'subscribe',
                    consumerTag: 'tag-wh',
                    msgOptions: { queueOptions: { channel: 'channel-webhook' } },
                },
            },
        };
        server = startHealthProbe({
            port: 0,
            appContext: makeAppContext(amqp),
            requireAmqp: true,
            requiredChannels: ['channel-webhook', 'channel-feedback'],
            startupGraceMs: 0,
        });
        await waitListening(server);

        const res = await getHealth(server);

        expect(res.statusCode).toBe(503);
        expect(res.body.status).toBe('consumer_missing');
        expect(res.body.missing).toEqual(['channel-feedback']);
        expect(res.body.noConsumer).toEqual([]);
    });

    it('regression: empty _consumers (pre-fix bug shape) returns 503 noConsumer for every required channel', async () => {
        // Before the v9 fix, the probe inspected wrapper._consumers (which
        // didn't exist on ChannelWrapper in v9). This shape simulates that:
        // managedChannels populated but AmqpConnection._consumers empty.
        // After the fix, we correctly report all required channels as
        // missing-consumer instead of incorrectly reporting healthy.
        const amqp = {
            managedConnection: { isConnected: () => true },
            managedChannels: {
                'channel-webhook': {},
                'channel-code-review': {},
            },
            _consumers: {},
        };
        server = startHealthProbe({
            port: 0,
            appContext: makeAppContext(amqp),
            requireAmqp: true,
            requiredChannels: ['channel-webhook', 'channel-code-review'],
            startupGraceMs: 0,
        });
        await waitListening(server);

        const res = await getHealth(server);

        expect(res.statusCode).toBe(503);
        expect(res.body.noConsumer).toEqual([
            'channel-webhook',
            'channel-code-review',
        ]);
    });

    it('counts multiple consumers on the same channel correctly', async () => {
        // Some workers register more than one @RabbitSubscribe per channel
        // (different routing keys on the same named channel). Health should
        // still report ok and consumersByChannel should reflect the count.
        const amqp = {
            managedConnection: { isConnected: () => true },
            managedChannels: { 'channel-webhook': {} },
            _consumers: {
                'tag-1': {
                    type: 'subscribe',
                    consumerTag: 'tag-1',
                    msgOptions: { queueOptions: { channel: 'channel-webhook' } },
                },
                'tag-2': {
                    type: 'subscribe',
                    consumerTag: 'tag-2',
                    msgOptions: { queueOptions: { channel: 'channel-webhook' } },
                },
            },
        };
        server = startHealthProbe({
            port: 0,
            appContext: makeAppContext(amqp),
            requireAmqp: true,
            requiredChannels: ['channel-webhook'],
            startupGraceMs: 0,
        });
        await waitListening(server);

        const res = await getHealth(server);

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    it('returns 404 for unknown paths', async () => {
        server = startHealthProbe({
            port: 0,
            appContext: makeAppContext(undefined),
            requireAmqp: false,
        });
        await waitListening(server);

        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('no port');
        const port = address.port;

        const statusCode = await new Promise<number>((resolve, reject) => {
            http.get(
                `http://127.0.0.1:${port}/nope`,
                { timeout: 1000 },
                (res) => {
                    res.resume();
                    resolve(res.statusCode ?? 0);
                },
            ).on('error', reject);
        });

        expect(statusCode).toBe(404);
    });
});
