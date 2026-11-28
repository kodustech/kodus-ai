import { parseHostPool } from '@libs/runtime/fleet/pool';

import { InMemoryTemplateStore } from '../testing';
import { fleetTemplateTrigger } from './fleet-template-trigger';

const FP = 'e'.repeat(64);
const pool = parseHostPool({ kind: 'HostPool', name: 'boat-perrun', scope: 'kodus', provider: 'boat', lifecycle: 'perRun', hostClass: { kind: 'HostClass', name: 'c', provider: 'boat', boat: { type: 'large' } } });

/** A Postgres that holds one environment's own setup, and no template build's setup record. */
function database() {
    const environmentSetup = {
        environment_id: 'env-1',
        organization_id: 'org-1',
        repository_id: 'repo-1',
        setup_key: 'env-1:2026-11-24T16:55:45.625Z',
        state: 'active',
        image_id: null,
        requested_at: new Date('2026-11-24T16:55:45Z'),
        updated_at: new Date('2026-11-24T16:56:19Z'),
        finished_at: null,
        record: { refSource: 'default_branch', bakeRefsDigest: `sha256:${FP}`, steps: [], blockers: [] },
    };
    return {
        query: async (sql: string, params: unknown[] = []) => ({
            rows: sql.includes('runtime.runtime_environment_setups') && params[0] === 'env-1' ? [environmentSetup] : [],
        }),
    };
}

// docs/runtime/host-providers.md §8.2: a default-branch setup that baked a fingerprint no template holds yet gets a
// template on each boat perRun pool. The setup that says so is the environment's own, read by its environment id.
describe('the fleet template trigger', () => {
    it('builds a template from the environment setup that baked a new fingerprint', async () => {
        const builds: Array<{ environmentId: string; fingerprint: string }> = [];
        const trigger = fleetTemplateTrigger(database() as any, {
            store: new InMemoryTemplateStore(),
            poolOf: async (poolId) => ({ poolId, pool }),
            boatPoolsOf: async () => [{ poolId: 'boat-dev', pool }],
            build: async (req) => {
                builds.push({ environmentId: req.environmentId, fingerprint: req.fingerprint });
                return { ok: true, name: 'kodus-env-x', reused: true };
            },
        });

        await trigger.onSetupFinished({ environmentId: 'env-1', organizationId: 'org-1', repositoryId: 'repo-1', key: 'k', state: 'active', steps: [], blockers: [], refSource: 'default_branch', bakeRefsDigest: `sha256:${FP}` } as any);
        for (let i = 0; i < 50 && builds.length === 0; i++) await new Promise((r) => setTimeout(r, 2));

        expect(builds).toEqual([{ environmentId: 'env-1', fingerprint: FP }]);
    });
});
