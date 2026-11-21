import * as http from 'http';
import { connect } from 'amqp-connection-manager';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

import {
    createSilentAmqpLogger,
    FakeAmqpConnectionManager,
} from '@libs/core/infrastructure/queue/testing/fake-amqp-connection-manager';
import {
    OUTBOX_RELAY_HEALTH_TOKEN,
    OutboxRelayLiveness,
} from '@libs/core/workflow/domain/contracts/outbox-relay-health.contract';

import { startHealthProbe } from './health-probe';
import {
    closeServer,
    getHealth,
    waitListening,
} from './testing/health-probe-client';

jest.mock('amqp-connection-manager', () => ({ connect: jest.fn() }));

const silentLogger = { warn: jest.fn() };

/** Resolves AmqpConnection by class and the relay by its DI token. */
function makeAppContext(deps: {
    amqp?: unknown;
    relay?: { getLiveness: () => OutboxRelayLiveness };
}): any {
    return {
        get: (token: unknown) => {
            if (token === AmqpConnection) return deps.amqp;
            if (token === OUTBOX_RELAY_HEALTH_TOKEN) {
                if (!deps.relay) throw new Error('not found');
                return deps.relay;
            }
            return undefined;
        },
    };
}

const connectedAmqp = { managedConnection: { isConnected: () => true } };

function runningRelay(lastCycleAt = Date.now()) {
    return {
        getLiveness: (): OutboxRelayLiveness => ({
            state: 'running',
            lastCycleAt,
        }),
    };
}

describe('startHealthProbe with the outbox relay required', () => {
    let server: http.Server | undefined;

    const start = (appContext: any, extra: Record<string, unknown> = {}) => {
        server = startHealthProbe({
            port: 0,
            appContext,
            requireAmqp: true,
            requiredChannels: [],
            startupGraceMs: 0,
            requireOutboxRelay: true,
            logger: silentLogger,
            ...extra,
        });
        return waitListening(server);
    };

    afterEach(async () => {
        if (server) {
            await closeServer(server);
            server = undefined;
        }
    });

    it('is healthy while the relay loop runs and the broker is connected', async () => {
        await start(
            makeAppContext({ amqp: connectedAmqp, relay: runningRelay() }),
        );

        const res = await getHealth(server!);

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    it('returns 503 outbox_relay_not_resolved when the relay is not in the container', async () => {
        await start(makeAppContext({ amqp: connectedAmqp }));

        const res = await getHealth(server!);

        expect(res.statusCode).toBe(503);
        expect(res.body.status).toBe('outbox_relay_not_resolved');
    });

    it.each(['not_started', 'stopped'] as const)(
        'returns 503 outbox_relay_%s when the loop is not running',
        async (state) => {
            await start(
                makeAppContext({
                    amqp: connectedAmqp,
                    relay: { getLiveness: () => ({ state }) },
                }),
            );

            const res = await getHealth(server!);

            expect(res.statusCode).toBe(503);
            expect(res.body.status).toBe(`outbox_relay_${state}`);
        },
    );

    it('returns 503 outbox_relay_stalled when no cycle finished within the stall window', async () => {
        await start(
            makeAppContext({
                amqp: connectedAmqp,
                relay: runningRelay(Date.now() - 10_000),
            }),
            { outboxRelayStallMs: 5_000 },
        );

        const res = await getHealth(server!);

        expect(res.statusCode).toBe(503);
        expect(res.body.status).toBe('outbox_relay_stalled');
        expect(res.body.outboxRelayStallMs).toBe(5_000);
        expect(res.body.msSinceLastCycle).toBeGreaterThanOrEqual(10_000);
    });

    it('is healthy when the last cycle is inside the stall window', async () => {
        await start(
            makeAppContext({
                amqp: connectedAmqp,
                relay: runningRelay(Date.now() - 1_000),
            }),
            { outboxRelayStallMs: 5_000 },
        );

        const res = await getHealth(server!);

        expect(res.statusCode).toBe(200);
    });

    it('reports the broker first when both the broker and the relay are down', async () => {
        await start(
            makeAppContext({
                amqp: { managedConnection: { isConnected: () => false } },
                relay: { getLiveness: () => ({ state: 'stopped' }) },
            }),
        );

        const res = await getHealth(server!);

        expect(res.body.status).toBe('amqp_disconnected');
    });

    it('checks the relay even when AMQP is not required', async () => {
        await start(
            makeAppContext({
                relay: { getLiveness: () => ({ state: 'stopped' }) },
            }),
            { requireAmqp: false },
        );

        const res = await getHealth(server!);

        expect(res.statusCode).toBe(503);
        expect(res.body.status).toBe('outbox_relay_stopped');
    });

    it('does not look for the relay unless asked to', async () => {
        await start(makeAppContext({ amqp: connectedAmqp }), {
            requireOutboxRelay: false,
        });

        const res = await getHealth(server!);

        expect(res.statusCode).toBe(200);
    });
});

/**
 * The probe reads @golevelup's real AmqpConnection; only the connection
 * manager under it is faked, so the broker can be dropped and brought back.
 */
describe('startHealthProbe across a broker drop', () => {
    let server: http.Server | undefined;
    let manager: FakeAmqpConnectionManager;
    let amqp: AmqpConnection;

    beforeEach(async () => {
        manager = new FakeAmqpConnectionManager();
        (connect as jest.Mock).mockReset().mockReturnValue(manager);
        amqp = new AmqpConnection({
            uri: 'amqp://broker:5672',
            exchanges: [],
            // The worker's boot policy (rabbitmq.module.ts): fail-fast.
            connectionInitOptions: { wait: true, timeout: 5000 },
            logger: createSilentAmqpLogger() as any,
        } as any);
        const init = amqp.init();
        await manager.brokerUp();
        await init;

        server = startHealthProbe({
            port: 0,
            appContext: makeAppContext({ amqp, relay: runningRelay() }),
            requireAmqp: true,
            requiredChannels: [],
            startupGraceMs: 0,
            requireOutboxRelay: true,
            logger: silentLogger,
        });
        await waitListening(server);
    });

    afterEach(async () => {
        if (server) {
            await closeServer(server);
            server = undefined;
        }
    });

    it('goes unhealthy while the broker is gone and healthy again once it reconnects', async () => {
        expect((await getHealth(server!)).statusCode).toBe(200);

        manager.brokerDown();
        const down = await getHealth(server!);
        expect(down.statusCode).toBe(503);
        expect(down.body.status).toBe('amqp_disconnected');

        await manager.brokerUp();
        const back = await getHealth(server!);
        expect(back.statusCode).toBe(200);
        expect(back.body.status).toBe('ok');
    });
});
