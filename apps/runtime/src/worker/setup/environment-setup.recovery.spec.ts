import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { Claim, EnvironmentRuntime } from '@libs/runtime/environment';
import { DBOSWorkflowConflictError } from '@dbos-inc/dbos-sdk';

import { testSetupService } from '../../testing/setup-service';
import { InMemoryEnvironmentSetupStore, type SetupStepRunner } from './environment-setup.service';

const cmd: RuntimeEnvironmentSetupRequested = {
    environmentId: 'env-1', organizationId: 'org-1', teamId: 'team-1', repositoryId: 'repo-1', repositoryName: 'shop',
    requestedBy: { userId: 'user-1' }, requestedAt: '2026-11-07T12:00:00Z', key: 'setup-key', ref: { sha: 'c'.repeat(40), branch: 'main' },
};
const claim: Claim = {
    claimId: 'claim-1', cellId: 'cell-1', cellOwner: 'kodus', leaseExpiresAt: '2026-11-07T12:30:00Z', hardExpiresAt: '2026-11-07T12:45:00Z',
    observer: { id: 'observer-1', state: 'ready' },
    manifest: { services: [], expose: [{ service: 'app', port: 3000, kind: 'http' }], imageId: 'setup', seedSha: cmd.ref!.sha },
};

function build() {
    const env: EnvironmentRuntime = {
        acquire: jest.fn(async () => claim),
        probe: jest.fn(async () => ({ http: { status: 200 }, vmHealth: 'ok' }) as any),
        exec: jest.fn(), reset: jest.fn(), release: jest.fn(async () => undefined),
        renew: jest.fn(async () => ({ status: 'gone' as const })),
        bake: jest.fn(async () => ({ status: 'accepted' as const })),
    };
    const store = new InMemoryEnvironmentSetupStore();
    const service = testSetupService({ envForSetup: () => env }, store, { now: () => new Date(cmd.requestedAt) });
    return { env, store, service };
}

describe('setup claim recovery', () => {
    it('propagates lost SDK ownership at a health step without release, close, or paid repair', async () => {
        const { env, store, service } = build();
        const conflict = new DBOSWorkflowConflictError(`setup:${cmd.key}`);
        const learn = jest.spyOn(service as any, 'learn');
        const fixes = jest.spyOn(service as any, 'tryFixes');
        const step: SetupStepRunner = async (name, callback) => {
            if (name === 'health') return (async () => { throw conflict; })();
            return callback();
        };

        await expect(service.run(cmd, step)).rejects.toBe(conflict);

        expect(env.release).not.toHaveBeenCalled();
        expect(learn).not.toHaveBeenCalled();
        expect(fixes).not.toHaveBeenCalled();
        expect((await store.get(cmd.environmentId))?.state).toBe('setting_up');
        expect((await store.get(cmd.environmentId))?.blockers).toEqual([]);
    });

    it('rechecks a restored boot and replays a recorded lease failure without checking again', async () => {
        const { env, service } = build();
        const outputs = new Map<string, unknown>();
        const interruption = Object.assign(new Error('paused before health'), { name: 'DBOSWorkflowCancelledError' });
        let paused = true;
        const step: SetupStepRunner = async (name, fn) => {
            if (outputs.has(name)) return structuredClone(outputs.get(name)) as any;
            if (paused && name === 'health') throw interruption;
            const value = await fn();
            outputs.set(name, structuredClone(value));
            return value;
        };
        await expect(service.run(cmd, step)).rejects.toBe(interruption);
        expect(env.acquire).toHaveBeenCalledTimes(1);
        expect(env.renew).not.toHaveBeenCalled();
        paused = false;

        expect((await service.run(cmd, step)).state).toBe('blocked');
        expect(env.renew).toHaveBeenCalledTimes(1);
        expect(env.acquire).toHaveBeenCalledTimes(1);
        expect(env.probe).not.toHaveBeenCalled();
        expect(env.bake).not.toHaveBeenCalled();
        env.renew = jest.fn(async () => ({ status: 'renewed' as const, leaseExpiresAt: claim.leaseExpiresAt, hardExpiresAt: claim.hardExpiresAt, atCeiling: false }));

        expect((await service.run(cmd, step)).state).toBe('blocked');
        expect(env.renew).not.toHaveBeenCalled();
        expect(env.acquire).toHaveBeenCalledTimes(1);
        expect(env.probe).not.toHaveBeenCalled();
    });

    it('does not probe or bake when a journaled claim is gone before the ready check', async () => {
        const { env, service } = build();
        const learn = jest.spyOn(service as any, 'learn');
        const fixes = jest.spyOn(service as any, 'tryFixes');

        const result = await service.run(cmd);

        expect(env.renew).toHaveBeenCalledWith(claim.claimId, 'setup');
        expect(env.probe).not.toHaveBeenCalled();
        expect(env.bake).not.toHaveBeenCalled();
        expect(result.state).toBe('blocked');
        expect(learn).not.toHaveBeenCalled();
        expect(fixes).not.toHaveBeenCalled();
    });

    it('checks again before bake and cannot record a stale setup as active', async () => {
        const { env, service } = build();
        env.renew = jest.fn()
            .mockResolvedValueOnce({ status: 'renewed', leaseExpiresAt: claim.leaseExpiresAt, atCeiling: false })
            .mockResolvedValue({ status: 'gone' });

        const result = await service.run(cmd);

        expect(env.probe).toHaveBeenCalledTimes(1);
        expect(env.renew).toHaveBeenCalledTimes(2);
        expect(env.bake).not.toHaveBeenCalled();
        expect(result.state).toBe('blocked');
    });
});
