import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { Claim, EnvironmentRuntime } from '@libs/runtime/environment';

import { testSetupService } from '../../testing/setup-service';
import { capacityBlocked } from '../env/hub-environment-runtime';
import { InMemoryEnvironmentSetupStore } from './environment-setup.service';

// A setup keeps its boot's claim.ready.timing and adds the boot to the
// environment's recent boots (Environment Health's setup numbers).

const SHA = 'c'.repeat(40);
const cmd = (key: string): RuntimeEnvironmentSetupRequested => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    repositoryName: 'shop',
    requestedBy: { userId: 'u-1' },
    requestedAt: '2026-11-06T12:00:00.000Z',
    key,
    ref: { sha: SHA, branch: 'main' },
});
const TIMING = { prepareMs: 95_000, bootMs: 90_000, buildMs: 70_000, upMs: 20_000 };

function env(acquire: EnvironmentRuntime['acquire']): EnvironmentRuntime {
    return {
        acquire,
        probe: async () => ({ http: { status: 200 }, vmHealth: 'ok' }) as any,
        exec: async () => ({}) as any,
        reset: async () => undefined,
        release: async () => undefined,
    };
}
const ready = (timing?: Claim['timing']): EnvironmentRuntime['acquire'] => async () =>
    ({
        claimId: 'claim-1',
        cellId: 'cell-1',
        cellOwner: 'kodus',
        leaseExpiresAt: '',
        hardExpiresAt: '',
        observer: { id: 'obs', state: 'ready' },
        manifest: { expose: [{ service: 'app', port: 3000, kind: 'http' }], services: [], imageId: 'setup', seedSha: 's' },
        ...(timing ? { timing } : {}),
    }) as Claim;

describe('setup boots', () => {
    it('keeps the boot timing and counts the boot; the next setup carries the boots and adds its failure', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const first = await testSetupService({ envForSetup: () => env(ready(TIMING)) }, store).run(cmd('k1'));
        expect(first.state).toBe('active');
        expect(first.bootTiming).toEqual(TIMING);
        const bootStep = first.steps.find((s) => s.name === 'boot')!;
        expect(first.boots).toEqual([{ at: bootStep.finishedAt, outcome: 'ready', ms: bootStep.durationMs }]);
        expect((await store.get('env-1'))!.boots).toEqual(first.boots);

        const failing = env(async () => ({ status: 'blocked', blockers: [{ kind: 'toolchain', signature: 'compose_up', message: 'boom' }] }));
        const second = await testSetupService({ envForSetup: () => failing }, store).run(cmd('k2'));
        expect(second.state).toBe('blocked');
        expect(second.boots!.map((b) => [b.outcome, b.signature])).toEqual([
            ['ready', undefined],
            ['failed', 'compose_up'],
        ]);
        expect((await store.get('env-1'))!.boots).toEqual(second.boots);
    });

    it('a boot no cell had room for is not a boot', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const rec = await testSetupService({ envForSetup: () => env(async () => capacityBlocked({ refused: 'no_capacity' })) }, store).run(cmd('k1'));
        expect(rec.state).toBe('blocked');
        expect(rec.boots ?? []).toEqual([]);
    });

    it('a boot no cell has room for yet waits and asks again with the same claim, then boots (ADR-070)', async () => {
        const keys: string[] = [];
        let refusals = 2;
        let clock = Date.now();
        const booting = env(ready());
        const real = booting.acquire.bind(booting);
        booting.acquire = async (req) => {
            keys.push(req.idempotencyKey);
            return refusals-- > 0 ? capacityBlocked({ refused: 'no_capacity' }) : real(req);
        };
        const rec = await testSetupService({ envForSetup: () => booting }, new InMemoryEnvironmentSetupStore(), {
            capacityWaitMs: 30 * 60_000,
            now: () => new Date(clock),
            sleep: async (ms) => void (clock += ms),
        }).run(cmd('k1'));
        expect(rec.state).toBe('active');
        expect(keys.slice(0, 3)).toEqual([keys[0], keys[0], keys[0]]);
        expect(rec.boots).toHaveLength(1);
    });

    it('a cell that sends no timing leaves bootTiming absent', async () => {
        const rec = await testSetupService({ envForSetup: () => env(ready()) }, new InMemoryEnvironmentSetupStore()).run(cmd('k1'));
        expect(rec).not.toHaveProperty('bootTiming');
        expect(rec.boots).toHaveLength(1);
    });
});
