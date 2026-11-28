import type { EnvironmentSetupRecord } from '@libs/runtime/run';
import { recipeDigest } from '@libs/runtime/run/recipe';

import { EnvironmentViewBuilder } from '../application/use-cases/environments.use-cases';
import { clock, ORG, REPO, storeWith } from './fixtures';

// The repairs of Kody's recipe inside a setup reach the environment view
// (digests, outcomes and the catalog's titles), and a setup without any shows
// no field for them.

const SHA = 'a'.repeat(40);
const RECIPE = 'version: 1\nservices:\n  compose:\n    public: app\n# second\n';

const setup = (over: Partial<EnvironmentSetupRecord> = {}): EnvironmentSetupRecord => ({
    environmentId: 'env-1',
    organizationId: ORG,
    repositoryId: REPO,
    key: 'env-1:2026-11-11T12:00:00.000Z',
    state: 'active',
    steps: [
        { name: 'boot', state: 'failed', startedAt: '2026-11-11T12:01:00.000Z' },
        { name: 'recipe', state: 'done', startedAt: '2026-11-11T12:02:00.000Z', repair: 1 },
        { name: 'boot', state: 'done', startedAt: '2026-11-11T12:03:00.000Z', repair: 1 },
    ],
    blockers: [],
    sha: SHA,
    refSource: 'default_branch',
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', content: RECIPE, digest: recipeDigest(RECIPE), origin: 'authored', cleanBoots: 1 },
    requestedAt: '2026-11-11T12:00:00.000Z',
    updatedAt: '2026-11-11T12:05:00.000Z',
    ...over,
});

const view = async (rec: EnvironmentSetupRecord) =>
    new EnvironmentViewBuilder(
        { listByOrganization: async () => [], get: async () => null } as any,
        await storeWith(),
        { blockedForRuns: async () => [], approvals: async () => [] } as any,
        clock,
        { get: async () => rec },
    ).view({ environmentId: 'env-1', organizationId: ORG, repositoryId: REPO }, [], false);

describe('repairs of Kody\'s recipe in the environment view', () => {
    it('shows each repair and the steps it ran, labelled with it', async () => {
        const repairs: EnvironmentSetupRecord['repairs'] = [
            {
                n: 1,
                max: 2,
                blocker: { kind: 'toolchain', signature: 'compose_up', title: 'The project failed to build or start' },
                failedDigest: 'sha256:first',
                recipeDigest: recipeDigest(RECIPE),
                outcome: 'booted',
                at: '2026-11-11T12:02:00.000Z',
            },
        ];
        const v = await view(setup({ repairs }));
        expect(v.setup?.repairs).toEqual(repairs);
        expect(v.setup?.steps.map((s) => s.repair)).toEqual([undefined, 1, 1]);
    });

    it('has no repairs field for a setup that made none', async () => {
        const v = await view(setup({ steps: [] }));
        expect(v.setup).toBeDefined();
        expect(v.setup).not.toHaveProperty('repairs');
    });
});
