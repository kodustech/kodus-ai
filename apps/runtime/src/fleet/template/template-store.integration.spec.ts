import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { templateNameOf } from './template-name';
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
});
