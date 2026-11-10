import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/contracts/runtime-commands';
import type { EnvironmentRuntime } from '@libs/runtime/environment';

import { capacityBlocked } from '../env/hub-environment-runtime';
import { EnvironmentSetupService, InMemoryEnvironmentSetupStore } from './environment-setup.service';

const request: RuntimeEnvironmentSetupRequested = {
    environmentId: 'environment', organizationId: 'organization', teamId: 'team', repositoryId: 'repo', repositoryName: 'shop',
    key: 'setup-key', requestedAt: '2026-11-07T12:00:00Z', requestedBy: { userId: 'user' }, ref: { sha: 'a'.repeat(40), branch: 'main' },
};
const env = (): EnvironmentRuntime => ({ acquire: jest.fn(async () => capacityBlocked({ refused: 'no_capacity' })), probe: jest.fn(), exec: jest.fn(), reset: jest.fn(), release: jest.fn() });

describe('admitted setup execution', () => {
    it('records a prestart admission blocker before dev ref overrides, recipe work or acquiring a claim', async () => {
        const environment = env();
        const envForSetup = jest.fn(() => environment);
        const service = new EnvironmentSetupService({ envForSetup }, new InMemoryEnvironmentSetupStore(), { devSha: 'b'.repeat(40), capacityWaitMs: 0 });
        const result = await (service.run as any)(request, undefined, undefined, { admissionBlocker: { kind: 'resources', signature: 'admission_deadline', message: 'Admission deadline reached' } });
        expect(result.state).toBe('blocked');
        expect(result.blockers).toEqual([expect.objectContaining({ signature: 'admission_deadline' })]);
        expect(result.steps.map((s: any) => s.name)).not.toContain('resolve_ref');
        expect(envForSetup).not.toHaveBeenCalled();
        expect(environment.acquire).not.toHaveBeenCalled();
    });

    it('does not sleep or retry a capacity refusal inside the shared execution queue', async () => {
        let now = Date.parse(request.requestedAt);
        const environment = env();
        const sleep = jest.fn(async (ms: number) => { now += ms; });
        const service = new EnvironmentSetupService({ envForSetup: () => environment }, new InMemoryEnvironmentSetupStore(), { now: () => new Date(now), sleep, capacityWaitMs: 1000 });
        const fixes = jest.spyOn(service as any, 'tryFixes');
        const result = await (service.run as any)(request, undefined, undefined, { noCapacityWait: true });
        expect(result.state).toBe('blocked');
        expect(environment.acquire).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
        expect(fixes).not.toHaveBeenCalled();
    });
});
