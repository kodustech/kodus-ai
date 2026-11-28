import { boundKeyOfSetup } from '@libs/runtime/placement/candidate-pools';
import { HttpException } from '@nestjs/common';

import { hashFleetToken } from '@libs/runtime/contracts/fleet-token';
import { FleetTokenLedger } from '@libs/runtime/contracts/fleet-token';
import { InMemoryFleetTokenStore } from '@libs/runtime/contracts/testing';

import { FleetEnrollment } from '../enrollment/fleet-enrollment';
import { InMemoryHubStore } from '../testing';
import { FleetInternalController } from './fleet.controller';

const status = async (p: Promise<unknown>) => {
    try {
        await p;
        return 200;
    } catch (e) {
        return e instanceof HttpException ? e.getStatus() : 500;
    }
};

// docs/runtime/host-providers.md §8.1: the fleet's only door to cell identity.
describe('the hub fleet routes', () => {
    const setup = () => {
        const tokens = new InMemoryFleetTokenStore();
        const store = new InMemoryHubStore({ fleetLedger: new FleetTokenLedger(tokens) });
        store.hostPools.set('boat-eu-perrun', { provider: 'boat', lifecycle: 'perRun' });
        store.hostPools.set('kodus-static', { provider: 'static', lifecycle: 'pooled' });
        const controller = new FleetInternalController(new FleetEnrollment(store, store.fleetLedger, () => undefined));
        return { tokens, store, controller };
    };
    const body = { hostId: 'host-1', poolId: 'boat-eu-perrun', boundKey: 'run:org-a/r-1', ttlSeconds: 600 };

    // Behavior: a Run whose pair does not fit one host gets a token per side (run:<org>/<run>/<base|pr>); any other third segment is refused.
    it('mints a token bound to one side of a Run (run:<org>/<run>/<base|pr>) and refuses another side name', async () => {
        const { controller, tokens } = setup();
        await controller.mint({}, { ...body, hostId: 'side-1', boundKey: 'run:org-a/r-1/base' });
        await controller.mint({}, { ...body, hostId: 'side-2', boundKey: 'run:org-a/r-1/pr' });
        const keys = [...(tokens.records?.values?.() ?? [])].map((x: any) => x.boundKey);
        expect(keys).toEqual(expect.arrayContaining(['run:org-a/r-1/base', 'run:org-a/r-1/pr']));
        expect(await status(controller.mint({}, { ...body, hostId: 'side-3', boundKey: 'run:org-a/r-1/main' }))).toBe(400);
    });

    it("mints a token bound to a template's environment (template:<org>/<env>) and refuses other shapes", async () => {
        const { controller, tokens } = setup();
        const r = await controller.mint({}, { ...body, hostId: 'tpl-1', boundKey: 'template:org-a/env-1' });
        expect(r.token.startsWith('kcf_')).toBe(true);
        expect([...tokens.records?.values?.() ?? []].some((x: any) => x.boundKey === 'template:org-a/env-1')).toBe(true);
        expect(await status(controller.mint({}, { ...body, hostId: 'tpl-2', boundKey: 'other:org-a/env-1' }))).toBe(400);
    });

    it("mints a token bound to one environment's own setup (setup:<org>/<hash>), the key placement gives it", async () => {
        const { controller, tokens } = setup();
        const boundKey = boundKeyOfSetup('org-a', 'env-1:2026-11-27T00:00:00.000Z');
        const r = await controller.mint({}, { ...body, hostId: 'su-1', boundKey });
        expect(r.token.startsWith('kcf_')).toBe(true);
        expect([...tokens.records.values()].some((x) => x.boundKey === boundKey)).toBe(true);
        expect(await status(controller.mint({}, { ...body, hostId: 'su-2', boundKey: 'setup:org-a/a/b' }))).toBe(400);
    });

    it('mints a token bound to a suite shard (suite:<org>/<suiteRun>/<shard>) and refuses a shard that is not a number', async () => {
        const { controller, tokens } = setup();
        await controller.mint({}, { ...body, hostId: 'sh-1', boundKey: 'suite:org-a/sr-1/2' });
        expect([...tokens.records.values()].some((x) => x.boundKey === 'suite:org-a/sr-1/2')).toBe(true);
        expect(await status(controller.mint({}, { ...body, hostId: 'sh-2', boundKey: 'suite:org-a/sr-1/main' }))).toBe(400);
        expect(await status(controller.mint({}, { ...body, hostId: 'sh-3', boundKey: 'suite:org-a/sr-1' }))).toBe(400);
    });

    it('mints a kcf_ token for a host of a pool a controller drives, storing only its hash, bound to pool, host and Run', async () => {
        const { tokens, controller } = setup();
        const r = await controller.mint({ socket: undefined }, body);
        expect(r.token).toMatch(/^kcf_/);
        const stored = tokens.records.get(hashFleetToken(r.token));
        expect(stored).toMatchObject({ poolId: 'boat-eu-perrun', hostId: 'host-1', boundKey: 'run:org-a/r-1' });
        expect(Date.parse(r.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('refuses a static pool, an unknown pool, a host that already registered, and a body it does not know', async () => {
        const { controller, store } = setup();
        expect(await status(controller.mint({ socket: undefined }, { ...body, poolId: 'kodus-static' }))).toBe(409);
        expect(await status(controller.mint({ socket: undefined }, { ...body, poolId: 'nope' }))).toBe(404);
        expect(await status(controller.mint({ socket: undefined }, { ...body, extra: 1 }))).toBe(400);
        expect(await status(controller.mint({ socket: undefined }, { ...body, boundKey: 'org-a/r-1' }))).toBe(400);
        const { token } = await controller.mint({ socket: undefined }, body);
        await store.fleetLedger.redeem(token);
        expect(await status(controller.mint({ socket: undefined }, body))).toBe(409);
    });

    it("retires a host's cell, and a host that never registered has none", async () => {
        const { controller, store } = setup();
        const { token } = await controller.mint({ socket: undefined }, body);
        await store.redeemFleetAndRegister(token, () => ({ cellId: 'cell-f', organizationId: null, owner: 'kodus', topology: 'fleet', status: 'connected', certificateSerial: 'aa', certificateExpiresAt: new Date().toISOString() }));
        expect(await controller.retire({ socket: undefined }, 'host-1')).toEqual({ cellId: 'cell-f' });
        expect(store.revokedCells).toEqual(['cell-f']);
        expect(await controller.retire({ socket: undefined }, 'host-never')).toEqual({ cellId: null });
    });

    // docs §8.2: only a template's setup host seals itself, on the hub's ask.
    describe('seal', () => {
        const register = async (store: InMemoryHubStore, controller: FleetInternalController, hostId: string, boundKey: string) => {
            const { token } = await controller.mint({ socket: undefined }, { ...body, hostId, boundKey });
            await store.redeemFleetAndRegister(token, () => ({ cellId: `cell-${hostId}`, organizationId: null, owner: 'kodus', topology: 'fleet', status: 'connected', certificateSerial: 'aa', certificateExpiresAt: new Date().toISOString() }));
        };
        const withConnections = (reply: { type: string; body?: unknown } = { type: 'ack' }) => {
            const sent: Array<{ cellId: string; type: string }> = [];
            const connections = { get: () => ({}) as never, request: async (cellId: string, type: string) => { sent.push({ cellId, type }); return reply as never; } };
            const tokens = new InMemoryFleetTokenStore();
            const store = new InMemoryHubStore({ fleetLedger: new FleetTokenLedger(tokens) });
            store.hostPools.set('boat-eu-perrun', { provider: 'boat', lifecycle: 'perRun' });
            const controller = new FleetInternalController(new FleetEnrollment(store, store.fleetLedger, () => undefined, connections));
            return { store, controller, sent };
        };

        it('forwards cell.seal to the cell of a template host and answers once it acked', async () => {
            const { store, controller, sent } = withConnections();
            await register(store, controller, 'tpl-1', 'template:org-a/env-1');
            expect(await controller.seal({ socket: undefined }, 'tpl-1')).toEqual({ cellId: 'cell-tpl-1' });
            expect(sent).toEqual([{ cellId: 'cell-tpl-1', type: 'cell.seal' }]);
        });

        it('refuses a host whose cell is bound to a Run or to nothing, and never asks its cell', async () => {
            const { store, controller, sent } = withConnections();
            await register(store, controller, 'run-1', 'run:org-a/r-1');
            expect(await status(controller.seal({ socket: undefined }, 'run-1'))).toBe(409);
            expect(await status(controller.seal({ socket: undefined }, 'host-never'))).toBe(404);
            expect(sent).toEqual([]);
        });

        it('refuses when the cell nacks (a claim is live, not a fleet install)', async () => {
            const { store, controller } = withConnections({ type: 'nack', body: { code: 'claim_live' } });
            await register(store, controller, 'tpl-1', 'template:org-a/env-1');
            expect(await status(controller.seal({ socket: undefined }, 'tpl-1'))).toBe(409);
        });

        it('says whether the host cell is connected, for the wait after the seal', async () => {
            const { store, controller } = withConnections();
            await register(store, controller, 'tpl-1', 'template:org-a/env-1');
            expect(await controller.connection('tpl-1')).toEqual({ cellId: 'cell-tpl-1', connected: true });
            expect(await controller.connection('host-never')).toEqual({ cellId: null, connected: false });
        });
    });
});
