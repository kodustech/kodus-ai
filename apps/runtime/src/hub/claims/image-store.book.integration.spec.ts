import { Pool } from 'pg';

import { PgPoolImageStores } from '../../shared/persistence/host-pools';
import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { InMemoryImageStoreBook } from '../testing';
import type { GrantRecord, ImageStoreBook } from './image-store.service';
import { PgImageStoreBook } from './pg-image-store.book';

// Opt-in: RUNTIME_IT_DATABASE_URL. The in-memory book (hub/testing.ts) and the Pg one answer the same cases the same way.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'image_store');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const FUTURE = '2099-01-01T00:00:00.000Z';
const grant = (over: Partial<GrantRecord> = {}): GrantRecord => ({
    claimId: 'c1', orgId: 'org', environmentId: 'env', poolId: 'boat', provider: 'oci-registry', sha: 'a'.repeat(40),
    repos: [{ scope: 'pr', name: 'p/o-a/e-b/pr-c', pull: true, push: true }], issuedAt: '2026-11-27T12:00:00.000Z', expiresAt: '2026-11-27T12:10:00.000Z', renewals: 0, ...over,
});
const image = { fingerprint: 'f'.repeat(64), digest: `sha256:${'d'.repeat(64)}`, bytes: 5, pushMs: 7 };
const key = { orgId: 'org', environmentId: 'env', prSha: 'a'.repeat(40) };

function cases(make: () => ImageStoreBook) {
    it('a renewed grant moves its expiry forward and counts the renewal, never back', async () => {
        const b = make();
        await b.recordGrant(grant());
        expect(await b.renewGrant('c1', '2026-11-27T12:20:00.000Z')).toBe(true);
        expect(await b.renewGrant('c1', '2026-11-27T12:05:00.000Z')).toBe(true);
        expect(await b.grantOf('c1')).toMatchObject({ expiresAt: '2026-11-27T12:20:00.000Z', renewals: 2 });
    });

    it('a revoked grant is not found and cannot be renewed', async () => {
        const b = make();
        await b.recordGrant(grant());
        await b.revokeGrant('c1', '2026-11-27T12:01:00.000Z');
        expect(await b.grantOf('c1')).toBeNull();
        expect(await b.renewGrant('c1', FUTURE)).toBe(false);
    });

    it("another org's grant for the same claim id does not overwrite the first", async () => {
        const b = make();
        await b.recordGrant(grant());
        await b.recordGrant(grant({ orgId: 'intruder', repos: [] }));
        expect(await b.grantOf('c1')).toMatchObject({ orgId: 'org' });
    });

    it('a PR image is pending from the builder, ready when only that builder finishes it, and a second finish changes nothing', async () => {
        const b = make();
        await b.startPrImage({ ...key, builderClaim: 'b1', expiresAt: FUTURE });
        expect((await b.prImage(key.orgId, key.environmentId, key.prSha))?.state).toBe('pending');
        expect(await b.finishPrImage({ ...key, builderClaim: 'someone-else', state: 'ready', images: [image] })).toBe(false);
        expect(await b.finishPrImage({ ...key, builderClaim: 'b1', state: 'ready', images: [image] })).toBe(true);
        expect(await b.finishPrImage({ ...key, builderClaim: 'b1', state: 'failed', images: [] })).toBe(false);
        expect(await b.prImage(key.orgId, key.environmentId, key.prSha)).toMatchObject({ state: 'ready', images: [image] });
    });

    it('a ready image is not made pending again by another builder for the same sha', async () => {
        const b = make();
        await b.startPrImage({ ...key, builderClaim: 'b1', expiresAt: FUTURE });
        await b.finishPrImage({ ...key, builderClaim: 'b1', state: 'ready', images: [image] });
        await b.startPrImage({ ...key, builderClaim: 'b2', expiresAt: FUTURE });
        expect(await b.prImage(key.orgId, key.environmentId, key.prSha)).toMatchObject({ state: 'ready', builderClaim: 'b1' });
    });

    it('a failed image is pending again when a new builder asks, and an ended builder fails only its own pending rows', async () => {
        const b = make();
        await b.startPrImage({ ...key, builderClaim: 'b1', expiresAt: FUTURE });
        expect(await b.failPendingOf('b1', 'builder_ended')).toBe(1);
        expect(await b.failPendingOf('b1', 'builder_ended')).toBe(0);
        await b.startPrImage({ ...key, builderClaim: 'b2', expiresAt: FUTURE });
        expect(await b.prImage(key.orgId, key.environmentId, key.prSha)).toMatchObject({ state: 'pending', builderClaim: 'b2' });
    });

    it('an image past its hard expiry is not found', async () => {
        const b = make();
        await b.startPrImage({ ...key, builderClaim: 'b1', expiresAt: '2000-01-01T00:00:00.000Z' });
        expect(await b.prImage(key.orgId, key.environmentId, key.prSha)).toBeNull();
    });

    it("never finds an image of another org or environment for the same sha", async () => {
        const b = make();
        await b.startPrImage({ ...key, builderClaim: 'b1', expiresAt: FUTURE });
        expect(await b.prImage('other', key.environmentId, key.prSha)).toBeNull();
        expect(await b.prImage(key.orgId, 'other', key.prSha)).toBeNull();
    });
}

describe('the image store book, in memory', () => cases(() => new InMemoryImageStoreBook()));

(skip ? describe.skip : describe)('the image store book in the Runtime database (real Postgres)', () => {
    let pool: Pool;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 4 });
        await ensureRuntimeSchema(pool);
    });
    beforeEach(async () => {
        await pool.query('TRUNCATE runtime.runtime_image_store_grants, runtime.runtime_pr_images');
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    cases(() => new PgImageStoreBook(pool));

    it("reads a pool's imageStore block from its spec, and a pool with none or a block it cannot parse reads as no store", async () => {
        await pool.query(`INSERT INTO runtime.runtime_host_pools (pool_id, scope, provider, lifecycle, spec) VALUES
            ('with', 'kodus', 'boat', 'perRun', '{"imageStore":{"provider":"oci-registry","endpoint":"https://store.example"}}'),
            ('without', 'kodus', 'boat', 'perRun', '{}'),
            ('broken', 'kodus', 'boat', 'perRun', '{"imageStore":{"provider":"oci-registry","endpoint":"http://plain.example"}}')`);
        const pools = new PgPoolImageStores(pool, { cacheMs: 0 });
        expect(await pools.imageStoreOf('with')).toMatchObject({ provider: 'oci-registry', prefix: 'kodus-ci', tokenTtlSeconds: 600 });
        expect(await pools.imageStoreOf('without')).toBeNull();
        expect(await pools.imageStoreOf('broken')).toBeNull();
        expect(await pools.imageStoreOf('missing')).toBeNull();
    });
});
