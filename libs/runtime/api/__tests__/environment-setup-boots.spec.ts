import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { EnvironmentViewBuilder, setupBootMetrics } from '../application/use-cases/environments.use-cases';

// Environment Health's setup numbers: the boots the setup record carries,
// kept apart from the Run numbers (time to ready on the bake, the warm pool).

const NOW = new Date('2026-11-06T12:00:00.000Z');
const DAY = 24 * 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const since = new Date(NOW.getTime() - 7 * DAY);

describe('setupBootMetrics', () => {
    it('counts the week’s boots, the share that became ready and their time to ready', () => {
        const boots = [
            { at: ago(8 * DAY), outcome: 'ready' as const, ms: 1 },
            { at: ago(3 * DAY), outcome: 'failed' as const, ms: 40_000, signature: 'compose_up' },
            { at: ago(2 * DAY), outcome: 'ready' as const, ms: 600_000 },
            { at: ago(DAY), outcome: 'ready' as const, ms: 300_000 },
        ];
        expect(setupBootMetrics(boots, since)).toEqual({ boots7d: 3, bootRate7d: 2 / 3, readyP50Ms: 300_000, readyP90Ms: 600_000 });
    });

    it('no boot in the window is no number; only failed boots is a 0 rate without a time', () => {
        expect(setupBootMetrics(undefined, since)).toBeUndefined();
        expect(setupBootMetrics([{ at: ago(8 * DAY), outcome: 'ready', ms: 1 }], since)).toBeUndefined();
        expect(setupBootMetrics([{ at: ago(DAY), outcome: 'failed', ms: 1 }], since)).toEqual({ boots7d: 1, bootRate7d: 0 });
    });
});

describe('the environment view', () => {
    const record: EnvironmentSetupRecord = {
        environmentId: 'env-1',
        organizationId: 'org-1',
        repositoryId: 'repo-1',
        key: 'k',
        state: 'active',
        steps: [],
        blockers: [],
        requestedAt: ago(DAY),
        updatedAt: ago(DAY),
        bootTiming: { prepareMs: 95_000, bootMs: 90_000, buildMs: 70_000, upMs: 20_000 },
        boots: [{ at: ago(DAY), outcome: 'ready', ms: 95_000 }],
    };
    const builder = (rec: EnvironmentSetupRecord | null) =>
        new EnvironmentViewBuilder(
            { listByOrganization: async () => [], get: async () => null } as any,
            { list: async () => [] } as any,
            { blockedForRuns: async () => [], approvals: async () => [] } as any,
            () => NOW,
            { get: async () => rec },
        );

    it('an environment with setups and no Run this week has setup numbers, and no Run numbers', async () => {
        const view = await builder(record).view({ environmentId: 'env-1', organizationId: 'org-1', repositoryId: 'repo-1' }, [], false);
        expect(view.metrics).toEqual({ runs7d: 0, egressBlocked: [], setupBoots: { boots7d: 1, bootRate7d: 1, readyP50Ms: 95_000, readyP90Ms: 95_000 } });
        expect(view.setup!.bootTiming).toEqual(record.bootTiming);
    });

    it('a setup of another org is not read', async () => {
        const view = await builder({ ...record, organizationId: 'org-2' }).view({ environmentId: 'env-1', organizationId: 'org-1', repositoryId: 'repo-1' }, [], false);
        expect(view.metrics).not.toHaveProperty('setupBoots');
        expect(view).not.toHaveProperty('setup');
    });
});
