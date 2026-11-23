import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgTemplateSetupRequester } from './pg-template-setup-requester';
import { templateNameOf } from './template-name';
import { PgSetupCandidates } from './setup-candidates-store';
import { PgTemplateStore, StoreTemplateResolver } from './template-store';

// Opt-in: RUNTIME_IT_DATABASE_URL. docs/runtime/host-providers.md §8.2.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'env_templates');
const skip = !database.url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('environment templates (real Postgres)', () => {
    let pool: Pool;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: database.url, max: 2 });
        await ensureRuntimeSchema(pool);
    });

    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    it("a Run host starts from the environment's one ready template on its pool; a newer build replaces it and names the old snapshot", async () => {
        const store = new PgTemplateStore(pool);
        const resolver = new StoreTemplateResolver(store);
        const key = (fingerprint: string) => ({ organizationId: 'org-k', environmentId: 'env-1', poolId: 'boat-eu-perrun', fingerprint });
        const [a, b] = ['a'.repeat(64), 'b'.repeat(64)];
        await store.begin({ ...key(a), name: templateNameOf('org-k', 'env-1', a) });
        expect(await resolver.resolve({ organizationId: 'org-k', environmentId: 'env-1', poolId: 'boat-eu-perrun' })).toBeNull();
        expect(await store.promote(key(a))).toEqual([]);
        expect(await resolver.resolve({ organizationId: 'org-k', environmentId: 'env-1', poolId: 'boat-eu-perrun' })).toBe(templateNameOf('org-k', 'env-1', a));
        await store.begin({ ...key(b), name: templateNameOf('org-k', 'env-1', b) });
        expect(await store.promote(key(b))).toEqual([templateNameOf('org-k', 'env-1', a)]);
        expect(await resolver.resolve({ organizationId: 'org-k', environmentId: 'env-1', poolId: 'boat-eu-perrun' })).toBe(templateNameOf('org-k', 'env-1', b));
        expect(await resolver.resolve({ organizationId: 'org-other', environmentId: 'env-1', poolId: 'boat-eu-perrun' })).toBeNull();
        await store.fail(key(b), 'x');
        expect((await store.find('org-k', 'env-1', 'boat-eu-perrun', b))?.state).toBe('ready');
    });

    it('the setup request marks only the building row of that environment', async () => {
        const store = new PgTemplateStore(pool);
        const fp = 'd'.repeat(64);
        const row = (env: string) => ({ organizationId: 'org-r', environmentId: env, poolId: 'p', fingerprint: fp, name: templateNameOf('org-r', env, fp) });
        await store.begin(row('env-a'));
        await store.begin(row('env-b'));
        await new PgTemplateSetupRequester(pool).request({ organizationId: 'org-r', environmentId: 'env-a', poolId: 'p', fingerprint: fp, key: 'template:org-r/env-a:tpl-1', boundKey: 'template:org-r/env-a' });
        const keys = (await pool.query(`SELECT environment_id, setup_key FROM runtime.runtime_env_templates WHERE org_id = 'org-r' ORDER BY environment_id`)).rows;
        expect(keys).toEqual([
            { environment_id: 'env-a', setup_key: 'template:org-r/env-a:tpl-1' },
            { environment_id: 'env-b', setup_key: null },
        ]);
    });

    it("names the setup host of every template still building, a retry's new host replacing the failed one, and none once it is over", async () => {
        const store = new PgTemplateStore(pool);
        const fp = 'e'.repeat(64);
        const row = { organizationId: 'org-h', environmentId: 'env-h', poolId: 'p', fingerprint: fp, name: templateNameOf('org-h', 'env-h', fp) };
        await store.begin({ ...row, setupHostId: 'tpl-first' });
        expect(await store.buildingSetupHosts()).toContain('tpl-first');
        await store.fail(row, 'build_error');
        expect(await store.buildingSetupHosts()).not.toContain('tpl-first');
        await store.begin({ ...row, setupHostId: 'tpl-retry' });
        expect(await store.buildingSetupHosts()).toContain('tpl-retry');
        await store.promote(row);
        expect(await store.buildingSetupHosts()).not.toContain('tpl-retry');
    });
    it('holds a fingerprint while a ready or building template has it, or its build failed after the backoff start', async () => {
        const store = new PgTemplateStore(pool);
        const fp = 'f'.repeat(64);
        const row = { organizationId: 'org-b', environmentId: 'env-b', poolId: 'p', fingerprint: fp, name: templateNameOf('org-b', 'env-b', fp) };
        const ago = (ms: number) => new Date(Date.now() - ms);
        expect(await store.holds(row, ago(1_800_000))).toBe(false);
        await store.begin(row);
        expect(await store.holds(row, ago(1_800_000))).toBe(true);
        await store.fail(row, 'build_error');
        expect(await store.holds(row, ago(1_800_000))).toBe(true);
        expect(await store.holds(row, new Date(Date.now() + 60_000))).toBe(false);
        await store.begin(row);
        await store.promote(row);
        expect(await store.holds(row, new Date(Date.now() + 60_000))).toBe(true);
    });

    it("lists the orgs' active setups updated recently, never a template build's own setup", async () => {
        const insert = (env: string, org: string, key: string, state: string, ageMs: number) =>
            pool.query(
                `INSERT INTO runtime.runtime_environment_setups (environment_id, organization_id, repository_id, setup_key, state, requested_at, updated_at, record) VALUES ($1, $2, 'r', $3, $4, now(), now() - ($5 || ' milliseconds')::interval, '{"steps":[],"blockers":[],"refSource":"default_branch"}')`,
                [env, org, key, state, String(ageMs)],
            );
        await insert('c-new', 'org-c', 'k1', 'active', 1000);
        await insert('c-tpl', 'org-c', 'template:org-c/c-tpl:tpl-1', 'active', 1000);
        await insert('c-old', 'org-c', 'k2', 'active', 3 * 86_400_000);
        await insert('c-run', 'org-c', 'k3', 'setting_up', 1000);
        await insert('c-other', 'org-z', 'k4', 'active', 1000);
        const since = new Date(Date.now() - 86_400_000);
        const candidates = new PgSetupCandidates(pool);
        expect((await candidates.activeSince(since, ['org-c'], 50)).map((r) => r.environmentId)).toEqual(['c-new']);
        expect((await candidates.activeSince(since, null, 50)).map((r) => r.environmentId).sort()).toEqual(['c-new', 'c-other']);
    });
    it('a build left building for hours (its fleet died) is dead: a new build takes it over and it holds nothing', async () => {
        const store = new PgTemplateStore(pool);
        const fp = 'f'.repeat(64);
        const row = { organizationId: 'org-s', environmentId: 'env-s', poolId: 'p', fingerprint: fp, name: templateNameOf('org-s', 'env-s', fp) };
        await store.begin({ ...row, setupHostId: 'tpl-dead' });
        expect(await store.holds(row, new Date(Date.now() - 30 * 60_000))).toBe(true);
        await pool.query(`UPDATE runtime.runtime_env_templates SET updated_at = now() - interval '4 hours' WHERE org_id = 'org-s'`);
        expect(await store.holds(row, new Date(Date.now() - 30 * 60_000))).toBe(false);
        expect(await store.buildingSetupHosts()).not.toContain('tpl-dead');
        await store.begin({ ...row, setupHostId: 'tpl-new' });
        expect(await store.buildingSetupHosts()).toContain('tpl-new');
        // A recent building row is never taken over by a second build.
        await store.begin({ ...row, setupHostId: 'tpl-second' });
        expect(await store.buildingSetupHosts()).toContain('tpl-new');
        expect(await store.buildingSetupHosts()).not.toContain('tpl-second');
    });
});
