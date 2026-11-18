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
});
