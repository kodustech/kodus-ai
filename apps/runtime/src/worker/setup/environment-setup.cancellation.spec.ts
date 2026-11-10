import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { EnvironmentRuntime } from '@libs/runtime/environment';

import { capacityBlocked } from '../env/hub-environment-runtime';
import { EnvironmentSetupService, InMemoryEnvironmentSetupStore, type SetupStepRunner } from './environment-setup.service';

const cmd: RuntimeEnvironmentSetupRequested = {
    environmentId: 'env-1', organizationId: 'org-1', teamId: 'team-1', repositoryId: 'repo-1', repositoryName: 'shop',
    requestedBy: { userId: 'user-1' }, requestedAt: '2026-11-07T12:00:00Z', key: 'setup-key', ref: { sha: 'c'.repeat(40), branch: 'main' },
};
const cancellation = () => Object.assign(new Error('workflow cancelled'), { name: 'DBOSWorkflowCancelledError' });
const environment = (): EnvironmentRuntime => ({ acquire: jest.fn(), probe: jest.fn(), exec: jest.fn(), reset: jest.fn(), release: jest.fn() });

describe('setup cancellation', () => {
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('propagates SDK cancellation from boot unchanged without closing or learning from the setup', async () => {
        const error = cancellation();
        const env = environment();
        env.acquire = jest.fn(async () => { throw error; });
        const store = new InMemoryEnvironmentSetupStore();
        const service = new EnvironmentSetupService({ envForSetup: () => env }, store);
        const learn = jest.spyOn(service as any, 'learn');
        const fixes = jest.spyOn(service as any, 'tryFixes');

        await expect(service.run(cmd)).rejects.toBe(error);

        expect(learn).not.toHaveBeenCalled();
        expect(fixes).not.toHaveBeenCalled();
        expect((await store.get(cmd.environmentId))?.state).toBe('setting_up');
        expect((await store.get(cmd.environmentId))?.blockers).toEqual([]);
    });

    it('reads the signal inside boot and stops a capacity pause without another acquire or progress timer', async () => {
        jest.useFakeTimers({ now: Date.parse(cmd.requestedAt) });
        const controller = new AbortController();
        const error = cancellation();
        const env = environment();
        env.acquire = jest.fn(async () => capacityBlocked({ refused: 'no_capacity' }));
        env.progress = jest.fn(async () => null);
        const service = new EnvironmentSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore());
        let insideBoot = false;
        const step: SetupStepRunner = async (name, fn) => {
            insideBoot = name === 'boot';
            try { return await fn(); } finally { insideBoot = false; }
        };
        const signal = jest.fn(() => {
            expect(insideBoot).toBe(true);
            return controller.signal;
        });
        const result = service.run(cmd, step, signal).then(() => 'resolved', (e) => e);
        await jest.advanceTimersByTimeAsync(0);
        expect(env.acquire).toHaveBeenCalledTimes(1);

        controller.abort(error);
        await jest.advanceTimersByTimeAsync(0);

        expect(await Promise.race([result, Promise.resolve('pending')])).toBe(error);
        expect(signal).toHaveBeenCalledTimes(1);
        expect(env.acquire).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });
});
