import { randomUUID } from 'crypto';

import { Pool, type PoolClient } from 'pg';

import { generateCellRegistrationToken } from '@libs/runtime/contracts/cell-token';

import { type CellLocation, type CellRefusal, type InTransaction, PgCellDirectory, pgTransaction } from '../shared/persistence/cell-directory';
import { PgDistributedLocks } from '../shared/persistence/locks';
import { PgRunClaims } from '../worker/persistence/pg-run-claims';
import { PgCommandStore } from '../shared/persistence/pg-command-store';
import { PgRunStreamStore } from '@libs/runtime/run/adapters/pg-run-stream.store';
import { applyRetention, ensureRuntimeSchema } from '../shared/persistence/runtime-schema';
import { PgRuntimeRunStreamReader } from '@libs/runtime/api/infrastructure/pg-runtime-run-stream.reader';
import { PgRuntimeClaimUsageReader } from '@libs/runtime/api/infrastructure/pg-runtime-claim-usage.reader';
import { PgRuntimeHealthReader } from '@libs/runtime/api/infrastructure/pg-runtime-health.reader';
import { RuntimeReadDb } from '@libs/runtime/api/infrastructure/runtime-read-db';
import { type ClaimState, InvalidClaimTransitionError } from '@libs/runtime/contracts/enums';

import { PgHubStore } from './hub-store';
import { isolatedDatabase } from '../testing/isolated-database';

// Opt-in: runs against the Postgres RUNTIME_IT_DATABASE_URL names (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), and skips when
// none is named, as in the backend CI suite, which starts no such database.
// A database of its own: suites in parallel never read each other's rows (isolated-database.ts).
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'hub_store');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('Runtime Postgres stores (integration, real Postgres)', () => {
    let pool: Pool;
    let store: PgHubStore;
    const ids: string[] = [];
    const cells: string[] = [];
    const stepIds: string[] = [];
    const claim = (state: ClaimState = 'pending', cellId = 'cell-a') => {
        const claimId = `it-claim-${randomUUID()}`;
        ids.push(claimId);
        return { claimId, cellId, orgId: 'org-a', environmentId: 'env-1', runId: 'run-1', side: 'base', state, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), hardExpiresAt: new Date(Date.now() + 120_000).toISOString() };
    };
    const cellId = () => {
        const id = `it-cell-${randomUUID()}`;
        cells.push(id);
        return id;
    };
    const cellOf = (r: CellLocation | CellRefusal | null) => (r && 'cellId' in r ? r.cellId : r);
    /** InTransaction inside a test's own transaction (isolated): a savepoint, rolled back with it. */
    const savepoint =
        (db: PoolClient): InTransaction =>
        async (fn) => {
            await db.query('SAVEPOINT reserve');
            try {
                const out = await fn(db);
                await db.query('RELEASE SAVEPOINT reserve');
                return out;
            } catch (err) {
                await db.query('ROLLBACK TO SAVEPOINT reserve');
                throw err;
            }
        };

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 4 });
        await ensureRuntimeSchema(pool);
        store = new PgHubStore(pool);
    });

    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    it('applies each migration once, also when it runs again', async () => {
        expect(await ensureRuntimeSchema(pool)).toEqual([]);
        const versions = (await pool.query('SELECT version FROM runtime.schema_migrations ORDER BY version')).rows.map((r) => r.version);
        expect(versions).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    });

    it('admits exactly one concurrent fresh step across independent PostgreSQL connections and never re-admits its retry', async () => {
        const step = { stepId: randomUUID(), cellId: cellId(), claimId: claim().claimId, orgId: 'org-a', runId: `it-run-${randomUUID()}`, commandHash: 'a'.repeat(64) };
        stepIds.push(step.stepId);
        const [first, second] = await Promise.all([pool.connect(), pool.connect()]);
        try {
            const pids = await Promise.all([first.query('SELECT pg_backend_pid() AS pid'), second.query('SELECT pg_backend_pid() AS pid')]);
            expect(pids[0].rows[0].pid).not.toBe(pids[1].rows[0].pid);
            const outcomes = await Promise.all([
                new PgHubStore(first).insertStep(step, { requireFresh: true }),
                new PgHubStore(second).insertStep(step, { requireFresh: true }),
            ]);
            expect(outcomes.filter(Boolean)).toHaveLength(1);
            expect(outcomes.filter(value => !value)).toHaveLength(1);
            expect((await first.query('SELECT count(*)::int AS count FROM runtime.runtime_steps_index WHERE step_id = $1', [step.stepId])).rows[0].count).toBe(1);
            expect(await new PgHubStore(second).insertStep(step, { requireFresh: true })).toBe(false);
            await new PgHubStore(first).finishStep(step.stepId);
            expect(await new PgHubStore(second).insertStep(step, { requireFresh: true })).toBe(false);
        } finally {
            first.release(); second.release();
        }
    });

    it('preserves legacy same-command retries while refusing a different command or claim and fresh retries', async () => {
        const step = { stepId: randomUUID(), cellId: cellId(), claimId: claim().claimId, orgId: 'org-a', commandHash: 'b'.repeat(64) };
        stepIds.push(step.stepId);
        expect(await store.insertStep(step)).toBe(true);
        expect(await store.insertStep(step)).toBe(true);
        expect(await store.insertStep(step, { requireFresh: false })).toBe(true);
        expect(await store.insertStep(step, { requireFresh: true })).toBe(false);
        expect(await store.insertStep({ ...step, commandHash: 'c'.repeat(64) })).toBe(false);
        expect(await store.insertStep({ ...step, claimId: claim().claimId })).toBe(false);
    });

    it('records shared images only for an asked bake, the newest bake winning, the last two kept, and drops them with the environment', async () => {
        const org = `it-org-${randomUUID()}`;
        const fp = (c: string) => c.repeat(64);
        const dg = (c: string) => `sha256:${c.repeat(64)}`;
        const at = (m: number) => new Date(Date.parse('2026-11-17T10:00:00.000Z') + m * 60_000).toISOString();
        const shared = (envKey: string, images: { fingerprint: string; digest: string }[], pushedAt: string, cell = 'cell-a') =>
            store.recordSharedImages({ cellId: cell, orgId: org, environmentId: 'env-1', envKey, recipeSha: 'r1', images, pushedAt });
        expect(await shared('k1', [{ fingerprint: fp('1'), digest: dg('1') }], at(1))).toBe('not_asked');
        await store.recordBakeAsk({ cellId: 'cell-a', orgId: org, environmentId: 'env-1', envKey: 'k1', recipeSha: 'r1', askedAt: at(0) });
        await store.recordBakeAsk({ cellId: 'cell-c', orgId: org, environmentId: 'env-1', envKey: 'k2', recipeSha: 'r1', askedAt: at(1) });
        expect(await shared('k1', [{ fingerprint: fp('1'), digest: dg('1') }], at(2), 'cell-c')).toBe('not_asked');
        // The newer bake's record first, the older one's late.
        expect(await shared('k2', [{ fingerprint: fp('1'), digest: dg('2') }], at(3), 'cell-c')).toBe('recorded');
        expect(await shared('k1', [{ fingerprint: fp('1'), digest: dg('1') }, { fingerprint: fp('9'), digest: dg('9') }], at(4))).toBe('recorded');
        expect(await store.sharedImages(org, 'env-1', 64)).toEqual([{ fingerprint: fp('1'), digest: dg('2') }, { fingerprint: fp('9'), digest: dg('9') }]);
        await store.recordBakeAsk({ cellId: 'cell-a', orgId: org, environmentId: 'env-1', envKey: 'k3', recipeSha: 'r1', askedAt: at(5) });
        expect(await shared('k3', [{ fingerprint: fp('3'), digest: dg('3') }], at(6))).toBe('recorded');
        expect(await store.sharedImages(org, 'env-1', 64)).toEqual([{ fingerprint: fp('3'), digest: dg('3') }, { fingerprint: fp('1'), digest: dg('2') }]);
        expect(await store.sharedImages(`${org}-other`, 'env-1', 64)).toEqual([]);
        expect(await store.removeSharedImages(org, 'env-1')).toBe(2);
        expect(await store.sharedImages(org, 'env-1', 64)).toEqual([]);
    });

    it('keeps what a cell named in its hello, and a reconnect that names less forgets the rest', async () => {
        const id = cellId();
        await store.upsertSession({
            cellId: id, replicaId: 'r', replicaUrl: 'u', owner: 'kodus', driver: 'fake', features: ['seedsCache', 'claimSize'],
            maxClaimSize: { memoryMb: 16_384, cpus: 8 }, defaultClaimSize: { memoryMb: 4_096, cpus: 2 }, sandboxClaimSize: { memoryMb: 2_048, cpus: 2 },
        });
        expect(await store.session(id)).toMatchObject({
            features: ['seedsCache', 'claimSize'], maxClaimSize: { memoryMb: 16_384, cpus: 8 }, defaultClaimSize: { memoryMb: 4_096, cpus: 2 }, sandboxClaimSize: { memoryMb: 2_048, cpus: 2 },
        });
        // The cell came back downgraded (an older build): its hello names nothing.
        await store.upsertSession({ cellId: id, replicaId: 'r', replicaUrl: 'u', owner: 'kodus', driver: 'fake' });
        expect(await store.session(id)).toMatchObject({ features: [], maxClaimSize: null, defaultClaimSize: null, sandboxClaimSize: null });
    });

    it('keeps the free bytes and the floor a build state was evicted under, and an older cell that names neither keeps none', async () => {
        const id = cellId();
        await store.upsertSession({ cellId: id, replicaId: 'r', replicaUrl: `u-${id}`, owner: 'kodus', driver: 'fake' });
        const at = new Date().toISOString();
        await store.syncEvictedBuildStates(id, [
            { orgId: 'org-a', environmentId: 'env-floor', evictedAt: at, freeBytes: 8 * 1024 ** 3, floorBytes: 20 * 1024 ** 3 },
            { orgId: 'org-a', environmentId: 'env-old', evictedAt: at },
        ]);
        expect(await store.evictedBuildState(id, 'org-a', 'env-floor')).toMatchObject({ freeBytes: 8 * 1024 ** 3, floorBytes: 20 * 1024 ** 3 });
        const old = await store.evictedBuildState(id, 'org-a', 'env-old');
        expect(old).not.toHaveProperty('floorBytes');
        expect(old).not.toHaveProperty('freeBytes');
    });

    it('keeps whether a claim is the PR side of a fork, through a rebind; a claim that says nothing is not', async () => {
        const fork = { ...claim(), side: 'pr', forkPullRequest: true };
        const own = claim();
        await store.insertClaim(fork);
        await store.insertClaim(own);
        expect((await store.claim(fork.claimId))!.forkPullRequest).toBe(true);
        expect((await store.claim(own.claimId))!.forkPullRequest).toBe(false);
        expect(await store.rebindClaim(fork.claimId, { cellId: 'cell-b', leaseExpiresAt: fork.leaseExpiresAt, hardExpiresAt: fork.hardExpiresAt })).toBe(true);
        expect((await store.claim(fork.claimId))!.forkPullRequest).toBe(true);
    });

    it('rebinds an open claim to the cell of the retry, pending again, and leaves a released one alone', async () => {
        const c = claim();
        await store.insertClaim({ ...c, consumer: 'setup' });
        // claim.renew takes the lease TTL from the consumer recorded here, never from its caller.
        expect(await store.claim(c.claimId)).toMatchObject({ consumer: 'setup' });
        expect(await store.transitionClaim(c.claimId, ['pending'], 'failed', { reason: 'not_ready' })).toBe(true);
        const hard = new Date(Date.now() + 600_000).toISOString();
        expect(await store.rebindClaim(c.claimId, { cellId: 'cell-c', leaseExpiresAt: hard, hardExpiresAt: hard })).toBe(true);
        expect(await store.claim(c.claimId)).toMatchObject({ cellId: 'cell-c', state: 'pending', hardExpiresAt: hard });

        const r = claim();
        await store.insertClaim(r);
        await store.transitionClaim(r.claimId, ['pending'], 'released', { reason: 'released' });
        expect(await store.rebindClaim(r.claimId, { cellId: 'cell-c', leaseExpiresAt: r.leaseExpiresAt, hardExpiresAt: r.hardExpiresAt })).toBe(false);
        expect(await store.claim(r.claimId)).toMatchObject({ cellId: 'cell-a', state: 'released' });
    });

    it('never rebinds a compromised claim: it keeps its cell and its violation', async () => {
        const c = claim('bound');
        await store.insertClaim(c);
        expect(await store.transitionClaim(c.claimId, ['bound'], 'compromised', { reason: 'security_violation', detail: 'bait_exfiltration' })).toBe(true);
        const hard = new Date(Date.now() + 600_000).toISOString();
        expect(await store.rebindClaim(c.claimId, { cellId: 'cell-c', leaseExpiresAt: hard, hardExpiresAt: hard })).toBe(false);
        expect(await store.claim(c.claimId)).toMatchObject({ cellId: 'cell-a', state: 'compromised', reason: 'security_violation', reasonDetail: 'bait_exfiltration' });
    });

    it('refuses a move the claim transition table does not allow, before touching the row', async () => {
        const c = claim('bound');
        await store.insertClaim(c);
        await expect(store.transitionClaim(c.claimId, ['bound'], 'failed', { reason: 'not_ready' })).rejects.toThrow(InvalidClaimTransitionError);
        expect(await store.claim(c.claimId)).toMatchObject({ state: 'bound' });
    });

    it('records what each round held once per transition, and the API reads it org-scoped inside a read-only transaction', async () => {
        const c = { ...claim(), runId: `it-run-${randomUUID()}` };
        await store.insertClaim({ ...c, metering: { driver: 'docker-gvisor', bootMb: 12_288, readyMb: 2_048, allocatableMb: 14_745, cpus: 4 } });
        const admitted = (await store.claim(c.claimId))!;
        expect(admitted).toMatchObject({ metering: { driver: 'docker-gvisor', bootMb: 12_288, readyMb: 2_048, allocatableMb: 14_745, cpus: 4 }, readyAt: null, releasedAt: null });
        expect(admitted.admittedAt).not.toBeNull();
        await store.transitionClaim(c.claimId, ['pending'], 'bound', { reason: 'ready', start: 'bake' });
        const ready = (await store.claim(c.claimId))!;
        expect(ready.readyAt).not.toBeNull();
        expect(ready.start).toBe('bake');
        await store.transitionClaim(c.claimId, ['bound'], 'released', { reason: 'released' });
        const released = (await store.claim(c.claimId))!;
        expect(released).toMatchObject({ readyAt: ready.readyAt, admittedAt: admitted.admittedAt, start: 'bake' });
        expect(released.releasedAt).not.toBeNull();

        const readDb = new RuntimeReadDb(url);
        const reader = new PgRuntimeClaimUsageReader(readDb);
        try {
            const rows = await reader.claimsOfRuns('org-a', [c.runId]);
            expect(rows.get(c.runId)).toEqual([
                expect.objectContaining({ claimId: c.claimId, driver: 'docker-gvisor', bootMb: 12_288, readyMb: 2_048, allocatableMb: 14_745, cpus: 4, readyAt: ready.readyAt, releasedAt: released.releasedAt }),
            ]);
            expect((await reader.claimsOfRuns('org-b', [c.runId])).size).toBe(0);
        } finally {
            await readDb.onModuleDestroy();
        }

        // A new round on another cell (no memory reported there) is admitted again: not ready, its own metering.
        const r = claim();
        await store.insertClaim({ ...r, metering: { driver: 'docker-gvisor', bootMb: 12_288, readyMb: 2_048, allocatableMb: 14_745 } });
        await store.transitionClaim(r.claimId, ['pending'], 'bound', { reason: 'ready', start: 'pool' });
        const hard = new Date(Date.now() + 600_000).toISOString();
        await store.rebindClaim(r.claimId, { cellId: 'cell-c', leaseExpiresAt: hard, hardExpiresAt: hard, metering: { driver: 'aws-ec2', bootMb: null, readyMb: null, allocatableMb: null } });
        expect(await store.claim(r.claimId)).toMatchObject({ metering: { driver: 'aws-ec2', bootMb: null }, readyAt: null, start: null });
        expect((await store.claim(r.claimId))!.metering?.cpus).toBeUndefined();
    });

    it('a claim keeps why it is in its state and since when, through every write path', async () => {
        const c = claim();
        await store.insertClaim(c);
        expect(await store.claim(c.claimId)).toMatchObject({ reason: 'acquired', reasonDetail: null });
        expect(await store.transitionClaim(c.claimId, ['pending'], 'failed', { reason: 'boot_failed', detail: 'seed_data/migrate_failed' })).toBe(true);
        const failed = (await store.claim(c.claimId))!;
        expect(failed).toMatchObject({ state: 'failed', reason: 'boot_failed', reasonDetail: 'seed_data/migrate_failed' });
        expect(Date.parse(failed.stateChangedAt!)).not.toBeNaN();
        // A refused move changes nothing, the cause included.
        expect(await store.transitionClaim(c.claimId, ['bound'], 'released', { reason: 'released' })).toBe(false);
        expect(await store.claim(c.claimId)).toMatchObject({ reason: 'boot_failed' });
        // A new round clears the old detail.
        const hard = new Date(Date.now() + 600_000).toISOString();
        await store.rebindClaim(c.claimId, { cellId: 'cell-c', leaseExpiresAt: hard, hardExpiresAt: hard });
        expect(await store.claim(c.claimId)).toMatchObject({ state: 'pending', reason: 'reacquired', reasonDetail: null });
    });

    it('a transition only leaves the states it names: a late ready never binds a released claim', async () => {
        const c = claim();
        expect(await store.insertClaim(c)).toBe(true);
        expect(await store.insertClaim(c)).toBe(false);
        expect(await store.transitionClaim(c.claimId, ['pending', 'bound'], 'released', { reason: 'released' })).toBe(true);
        expect(await store.transitionClaim(c.claimId, ['pending'], 'bound', { reason: 'ready' })).toBe(false);
        const row = (await pool.query('SELECT state, released_at FROM runtime.runtime_claims WHERE claim_id = $1', [c.claimId])).rows[0];
        expect(row.state).toBe('released');
        expect(row.released_at).not.toBeNull();
    });

    it('a late disconnect from a replica that no longer holds the cell changes nothing', async () => {
        const id = cellId();
        await pool.query(`INSERT INTO runtime.runtime_cells (cell_id, owner, topology, status, certificate_serial) VALUES ($1, 'kodus', 'managed', 'disconnected', 'AA')`, [id]);
        await store.upsertSession({ cellId: id, replicaId: 'r1', replicaUrl: 'u1', owner: 'kodus', driver: 'fake' });
        await store.upsertSession({ cellId: id, replicaId: 'r2', replicaUrl: 'u2', owner: 'kodus', driver: 'fake' });
        await store.disconnect(id, 'r1');
        expect(await store.session(id)).toMatchObject({ replicaId: 'r2' });
        expect((await pool.query('SELECT status FROM runtime.runtime_cells WHERE cell_id = $1', [id])).rows[0].status).toBe('connected');
        await store.disconnect(id, 'r2');
        expect((await pool.query('SELECT status FROM runtime.runtime_cells WHERE cell_id = $1', [id])).rows[0].status).toBe('disconnected');
    });

    it('concurrent reservations take distinct slots', async () => {
        const org = `org-${randomUUID()}`;
        const [a, b] = [cellId(), cellId()];
        for (const id of [a, b]) {
            await store.upsertSession({ cellId: id, replicaId: 'r', replicaUrl: 'u', owner: 'customer', orgId: org, driver: 'fake' });
            await store.heartbeat(id, 'r', 1);
        }
        const picked = await Promise.all([store.reserveCell(org), store.reserveCell(org)]);
        expect(new Set(picked.map((p) => p!.cellId))).toEqual(new Set([a, b]));
    });

    it("prefers the environment's pool cell when it is eligible and has a slot, and only then", async () => {
        const org = `org-${randomUUID()}`;
        const other = `org-${randomUUID()}`;
        const [own, pool1, foreign] = [cellId(), cellId(), cellId()];
        await store.upsertSession({ cellId: own, replicaId: 'r', replicaUrl: 'u-own', owner: 'customer', orgId: org, driver: 'fake' });
        await store.heartbeat(own, 'r', 5);
        await store.upsertSession({ cellId: pool1, replicaId: 'r', replicaUrl: 'u-pool', owner: 'kodus', driver: 'fake' });
        await store.heartbeat(pool1, 'r', 1);
        await store.upsertSession({ cellId: foreign, replicaId: 'r', replicaUrl: 'u-foreign', owner: 'customer', orgId: other, driver: 'fake' });
        await store.heartbeat(foreign, 'r', 9);
        const cells = new PgCellDirectory(pool, { inTransaction: pgTransaction(pool) });

        // Without a preference the org's own cell comes first, as before.
        expect(cellOf(await cells.reserveCell(org))).toBe(own);
        // The pool cell goes first while it has a slot...
        expect(cellOf(await cells.reserveCell(org, { prefer: pool1 }))).toBe(pool1);
        // ...and once it has none, the claim goes where there is one.
        expect(cellOf(await cells.reserveCell(org, { prefer: pool1 }))).toBe(own);
        // Another org's cell is never chosen, whatever the preference says.
        expect(cellOf(await cells.reserveCell(org, { prefer: foreign }))).toBe(own);
    });

    // Scheduling on shared cells, each case in a transaction that first disconnects
    // every other session (rolled back after), so cells of other specs never compete.
    const isolated = async (fn: (db: PoolClient, s: PgHubStore, live: (org: string, cell: string, state?: ClaimState) => Promise<string>) => Promise<void>) => {
        const db = await pool.connect();
        try {
            await db.query('BEGIN');
            await db.query(`UPDATE runtime.runtime_cell_sessions SET disconnected_at = now() WHERE disconnected_at IS NULL`);
            const s = new PgHubStore(db);
            const live = async (org: string, cell: string, state: ClaimState = 'bound') => {
                const c = { ...claim(state, cell), orgId: org };
                await s.insertClaim(c);
                return c.claimId;
            };
            await fn(db, s, live);
        } finally {
            await db.query('ROLLBACK');
            db.release();
        }
    };
    const connect = async (s: PgHubStore, owner: 'kodus' | 'customer', slots: number, orgId?: string, maxClaimSize?: { memoryMb: number; cpus: number }) => {
        const id = cellId();
        // A cell with a max is one of this build (it decodes size); without, an older cell that names nothing.
        const caps = maxClaimSize ? { features: ['seedsCache', 'claimSize'] as const, maxClaimSize } : {};
        await s.upsertSession({ cellId: id, replicaId: 'r', replicaUrl: `u-${id}`, owner, ...(orgId ? { orgId } : {}), driver: 'fake', ...caps });
        await s.heartbeat(id, 'r', slots);
        return id;
    };
    const freeSlots = async (db: PoolClient, id: string) => (await db.query('SELECT free_slots FROM runtime.runtime_cell_sessions WHERE cell_id = $1', [id])).rows[0].free_slots;

    it("caps an org's live claims on shared cells, not on its own cells, and never counts the claim being acquired", () =>
        isolated(async (db, s, live) => {
            const [org, other] = [`org-${randomUUID()}`, `org-${randomUUID()}`];
            const shared = await connect(s, 'kodus', 10);
            const first = await live(org, shared, 'bound');
            await live(org, shared, 'pending');
            // Neither a released claim nor a blocked one holds machines: they do not count.
            await live(org, shared, 'blocked');
            const done = await live(org, shared);
            await s.transitionClaim(done, ['bound'], 'released', { reason: 'released' });
            await live(other, shared);
            const cells = new PgCellDirectory(db, { sharedClaimCap: 2, inTransaction: savepoint(db) });

            expect(await cells.reserveCell(org)).toMatchObject({ refused: 'org_capacity', cap: 2, open: 2 });
            expect(await freeSlots(db, shared)).toBe(10);
            // A new round of a claim the org already holds is not one more claim.
            expect(cellOf(await cells.reserveCell(org, { claimId: first }))).toBe(shared);
            // The cap is per org: another org still gets the shared cell.
            expect(cellOf(await cells.reserveCell(other))).toBe(shared);
            // The org's own cell is not capped.
            const own = await connect(s, 'customer', 1, org);
            expect(cellOf(await cells.reserveCell(org))).toBe(own);
            expect(await cells.reserveCell(org)).toMatchObject({ refused: 'org_capacity' });
        }));

    it("spreads an org over the shared cells where it holds fewer claims; the pool cell with a slot still goes first", () =>
        isolated(async (db, s, live) => {
            const [org, other] = [`org-${randomUUID()}`, `org-${randomUUID()}`];
            const [busy, some, idle] = [await connect(s, 'kodus', 10), await connect(s, 'kodus', 6), await connect(s, 'kodus', 5)];
            await live(org, busy);
            await live(org, busy);
            await live(org, some);
            // Another org's claims are not this org's spread.
            for (let i = 0; i < 3; i++) await live(other, idle);
            const cells = new PgCellDirectory(db, { sharedClaimCap: 100, inTransaction: savepoint(db) });

            // Most free slots alone would pick `busy`; the org holds fewest on `idle`.
            expect(cellOf(await cells.reserveCell(org))).toBe(idle);
            // The environment's pool cell wins while it has a slot, wherever the org's claims are.
            expect(cellOf(await cells.reserveCell(org, { prefer: busy }))).toBe(busy);
            await db.query('UPDATE runtime.runtime_cell_sessions SET free_slots = 0 WHERE cell_id = $1', [busy]);
            // The first reservation on `idle` counts before the hub records its claim: `some` and
            // `idle` now hold one each, and `some` has more free slots.
            expect(cellOf(await cells.reserveCell(org, { prefer: busy }))).toBe(some);
        }));

    // It used to count only the hub's claim rows, which the hub inserts after the worker reserved
    // the slot: a burst of acquires all read "under the cap" and all reserved.
    it("holds an org to its shared-cell cap through a burst of concurrent reservations", async () => {
        const org = `org-${randomUUID()}`;
        // One shared cell per acquire: the reservations lock different session rows, so only the
        // org's lock (not a row lock on one cell) can make them see each other.
        const shared = Array.from({ length: 5 }, () => cellId());
        for (const id of shared) {
            await store.upsertSession({ cellId: id, replicaId: 'r', replicaUrl: `u-${id}`, owner: 'kodus', driver: 'fake' });
            await store.heartbeat(id, 'r', 2);
        }
        const onShared = (r: CellLocation | CellRefusal | null) => shared.includes(cellOf(r) as string);
        try {
            const cells = new PgCellDirectory(pool, { sharedClaimCap: 2, inTransaction: pgTransaction(pool) });
            const burst = Array.from({ length: 5 }, () => `it-claim-${randomUUID()}`);
            ids.push(...burst);
            const picked = await Promise.all(burst.map((claimId) => cells.reserveCell(org, { claimId })));
            expect(picked.filter(onShared)).toHaveLength(2);
            expect(picked.filter((p) => p && 'refused' in p)).toMatchObject(Array(3).fill({ refused: 'org_capacity', cap: 2, open: 2 }));

            const won = burst.find((_, i) => onShared(picked[i]))!;
            // A new round of a reserved claim is not one more claim.
            expect(onShared(await cells.reserveCell(org, { claimId: won }))).toBe(true);
            // The hub's claim row replaces the reservation: still two, not three.
            await store.insertClaim({ ...claim('pending', shared[0]), claimId: won, orgId: org });
            expect(await cells.reserveCell(org, { claimId: `it-claim-${randomUUID()}` })).toMatchObject({ refused: 'org_capacity', cap: 2, open: 2 });
            // A reservation the hub never recorded stops counting when it expires.
            await pool.query(`UPDATE runtime.runtime_cell_reservations SET expires_at = now() - interval '1 second' WHERE org_id = $1 AND claim_id <> $2`, [org, won]);
            expect(onShared(await cells.reserveCell(org, { claimId: `it-claim-${randomUUID()}` }))).toBe(true);
        } finally {
            for (const id of shared) await store.disconnect(id, 'r');
            await pool.query(`DELETE FROM runtime.runtime_cell_reservations WHERE org_id = $1`, [org]);
        }
    });

    // Deterministic interleaving of two reservations of one org (cap 1), each on its own shared
    // cell: B starts while A has reserved and not committed. Without the org's lock B never saw
    // A's reservation and both reserved; with it, B waits for A's commit and is refused.
    it('a reservation that starts while another of the org is uncommitted waits for it and counts it', async () => {
        const org = `org-${randomUUID()}`;
        const shared = [cellId(), cellId()];
        for (const id of shared) {
            await store.upsertSession({ cellId: id, replicaId: 'r', replicaUrl: `u-${id}`, owner: 'kodus', driver: 'fake' });
            await store.heartbeat(id, 'r', 1);
        }
        const signal = () => {
            let fire!: () => void;
            const fired = new Promise<void>((r) => (fire = r));
            return { fire, fired };
        };
        const [aReserved, bStarted, bReserved] = [signal(), signal(), signal()];
        const tx = pgTransaction(pool);
        // A holds its transaction open until B started, and until B reserved or a second passed (B is waiting on the lock).
        const txA: InTransaction = (fn) =>
            tx(async (db) => {
                const out = await fn(db);
                aReserved.fire();
                await bStarted.fired;
                await Promise.race([bReserved.fired, new Promise((r) => setTimeout(r, 1_000))]);
                return out;
            });
        const txB: InTransaction = (fn) =>
            tx(async (db) => {
                const watched = { query: ((...args: Parameters<PoolClient['query']>) => (bStarted.fire(), (db.query as any)(...args))) as PoolClient['query'] };
                const out = await fn(watched);
                bReserved.fire();
                return out;
            });
        try {
            const a = new PgCellDirectory(pool, { sharedClaimCap: 1, inTransaction: txA }).reserveCell(org, { claimId: `it-claim-${randomUUID()}` });
            await aReserved.fired;
            const b = new PgCellDirectory(pool, { sharedClaimCap: 1, inTransaction: txB }).reserveCell(org, { claimId: `it-claim-${randomUUID()}` });
            const [ra, rb] = await Promise.all([a, b]);
            expect(shared).toContain(cellOf(ra));
            expect(rb).toMatchObject({ refused: 'org_capacity', cap: 1, open: 1 });
        } finally {
            for (const id of shared) await store.disconnect(id, 'r');
            await pool.query(`DELETE FROM runtime.runtime_cell_reservations WHERE org_id = $1`, [org]);
        }
    });

    it("another cell may hold a Run's two sides only when it is live, serves the org and has the memory (an unreported size may)", () =>
        isolated(async (_db, s) => {
            const org = `org-${randomUUID()}`;
            const other = `org-${randomUUID()}`;
            const self = cellId();
            await s.upsertSession({ cellId: self, replicaId: 'r', replicaUrl: `u-${self}`, owner: 'customer', orgId: org, driver: 'fake' });
            await s.heartbeat(self, 'r', 1, undefined, { allocatableMb: 64_000, committedMb: 0 });
            // Only the cell itself is big enough: no other cell may hold 20 GB.
            expect(await s.anotherCellMayHold(org, self, 20_000)).toBe(false);
            const small = cellId();
            await s.upsertSession({ cellId: small, replicaId: 'r', replicaUrl: `u-${small}`, owner: 'kodus', driver: 'fake' });
            await s.heartbeat(small, 'r', 1, undefined, { allocatableMb: 13_000, committedMb: 0 });
            expect(await s.anotherCellMayHold(org, self, 20_000)).toBe(false);
            // Another org's own big cell never serves this org.
            const foreign = cellId();
            await s.upsertSession({ cellId: foreign, replicaId: 'r', replicaUrl: `u-${foreign}`, owner: 'customer', orgId: other, driver: 'fake' });
            await s.heartbeat(foreign, 'r', 1, undefined, { allocatableMb: 64_000, committedMb: 0 });
            expect(await s.anotherCellMayHold(org, self, 20_000)).toBe(false);
            // A shared cell that has not reported its memory may hold it: the Run waits rather than fails.
            const unsized = cellId();
            await s.upsertSession({ cellId: unsized, replicaId: 'r', replicaUrl: `u-${unsized}`, owner: 'kodus', driver: 'fake' });
            await s.heartbeat(unsized, 'r', 1);
            expect(await s.anotherCellMayHold(org, self, 20_000)).toBe(true);
            await s.disconnect(unsized, 'r');
            expect(await s.anotherCellMayHold(org, self, 20_000)).toBe(false);
            // A big shared cell does.
            const big = cellId();
            await s.upsertSession({ cellId: big, replicaId: 'r', replicaUrl: `u-${big}`, owner: 'kodus', driver: 'fake' });
            await s.heartbeat(big, 'r', 1, undefined, { allocatableMb: 32_000, committedMb: 8_000 });
            expect(await s.anotherCellMayHold(org, self, 20_000)).toBe(true);
        }));

    it('no free slot on any eligible cell is no_capacity, never a full cell; no cell at all is none', () =>
        isolated(async (db, s) => {
            const [org, other] = [`org-${randomUUID()}`, `org-${randomUUID()}`];
            await connect(s, 'kodus', 0);
            await connect(s, 'customer', 0, org);
            // Another org's free cell is never eligible.
            await connect(s, 'customer', 9, other);
            const cells = new PgCellDirectory(db, { inTransaction: savepoint(db) });

            expect(await cells.reserveCell(org)).toEqual({ refused: 'no_capacity', hosts: 2 });
            // The hub store's reservation keeps its fallback: the best cell, full (the cell then refuses).
            expect((await s.reserveCell(org))?.cellId).toBeDefined();
            await db.query(`UPDATE runtime.runtime_cell_sessions SET disconnected_at = now()`);
            expect(await cells.reserveCell(org)).toBeNull();
        }));

    it('a sized claim goes only to a cell that grants the size; none granting it is size_unavailable with the largest grant', () =>
        isolated(async (db, s) => {
            const org = `org-${randomUUID()}`;
            const own = await connect(s, 'customer', 9, org); // older: grants no size
            const small = await connect(s, 'kodus', 9, undefined, { memoryMb: 8_192, cpus: 4 });
            const big = await connect(s, 'kodus', 1, undefined, { memoryMb: 32_768, cpus: 16 });
            const cells = new PgCellDirectory(db, { sharedClaimCap: 100, inTransaction: savepoint(db) });
            const medium = { memoryMb: 8_192, cpus: 4 };
            const large = { memoryMb: 16_384, cpus: 8 };

            // Unsized, the org's own cell still comes first, whatever it grants.
            expect(cellOf(await cells.reserveCell(org))).toBe(own);
            // Sized: the own cell cannot read a size, so it is never chosen; the preferred cell only when it grants it.
            expect(cellOf(await cells.reserveCell(org, { size: medium }))).toBe(small);
            expect(cellOf(await cells.reserveCell(org, { size: large, prefer: small }))).toBe(big);
            expect(await freeSlots(db, big)).toBe(0);
            // The one granting cell is full: no capacity (waiting helps), not size_unavailable.
            expect(await cells.reserveCell(org, { size: large })).toMatchObject({ refused: 'no_capacity' });
            // Above every cell's max, in memory or in CPUs: nothing reserved, the largest grant named.
            for (const size of [
                { memoryMb: 65_536, cpus: 8 },
                { memoryMb: 16_384, cpus: 32 },
            ]) {
                expect(await cells.reserveCell(org, { size })).toEqual({ refused: 'size_unavailable', size, largest: { memoryMb: 32_768, cpus: 16 } });
            }
            expect(await freeSlots(db, small)).toBe(8);
            // Only cells that grant no size: the refusal names no largest grant.
            await db.query('UPDATE runtime.runtime_cell_sessions SET disconnected_at = now() WHERE cell_id = ANY($1)', [[small, big]]);
            expect(await cells.reserveCell(org, { size: medium })).toEqual({ refused: 'size_unavailable', size: medium, largest: null });
        }));

    it('a claim goes only to a cell that satisfies its isolation minimum; none connected that does is isolation_unavailable, never a lower cell', () =>
        isolated(async (db, s) => {
            const org = `org-${randomUUID()}`;
            const at = async (isolation: string, slots: number) => {
                const id = await connect(s, 'kodus', slots);
                await db.query('UPDATE runtime.runtime_cell_sessions SET isolation = $2 WHERE cell_id = $1', [id, isolation]);
                return id;
            };
            const gvisor = await at('sandboxed-container', 9);
            const dev = await at('none', 9);
            const cells = new PgCellDirectory(db, { sharedClaimCap: 100, inTransaction: savepoint(db) });

            // No minimum (and 'any') takes the cell with the most free slots, whatever its isolation.
            expect([gvisor, dev]).toContain(cellOf(await cells.reserveCell(org)));
            expect([gvisor, dev]).toContain(cellOf(await cells.reserveCell(org, { isolation: 'any' })));
            // 'kernel' never takes the dev cell, even preferred.
            expect(cellOf(await cells.reserveCell(org, { isolation: 'kernel', prefer: dev }))).toBe(gvisor);
            // 'vm' with only gVisor and dev cells connected: refused, nothing reserved on either.
            const before = [await freeSlots(db, gvisor), await freeSlots(db, dev)];
            expect(await cells.reserveCell(org, { isolation: 'vm' })).toEqual({ refused: 'isolation_unavailable', isolation: 'vm' });
            expect([await freeSlots(db, gvisor), await freeSlots(db, dev)]).toEqual(before);
            // A microVM cell connects: the vm claim goes there; once it is full, it waits (no capacity), never lower.
            const microvm = await at('microvm', 1);
            expect(cellOf(await cells.reserveCell(org, { isolation: 'vm', prefer: gvisor }))).toBe(microvm);
            expect(await cells.reserveCell(org, { isolation: 'vm' })).toMatchObject({ refused: 'no_capacity' });
        }));

    it("a Run's second side goes only to a cell of the backend its first side is on, even preferred elsewhere; none connected is backend_unavailable", () =>
        isolated(async (db, s, live) => {
            const org = `org-${randomUUID()}`;
            const at = async (driver: string, isolation: string, slots: number) => {
                const id = await connect(s, 'kodus', slots);
                await db.query('UPDATE runtime.runtime_cell_sessions SET driver = $2, isolation = $3 WHERE cell_id = $1', [id, driver, isolation]);
                return id;
            };
            const gvisor = await at('gvisor', 'sandboxed-container', 9);
            const microvm = await at('microvm', 'microvm', 9);
            const cells = new PgCellDirectory(db, { sharedClaimCap: 100, inTransaction: savepoint(db) });
            const [base, pr] = [`it-claim-${randomUUID()}`, `it-claim-${randomUUID()}`];

            // No other side placed yet: any eligible cell, as before.
            expect(cellOf(await cells.reserveCell(org, { claimId: base, prefer: gvisor, sameBackendAs: [pr] }))).toBe(gvisor);
            // The base side is reserved on gVisor: the PR side follows it there, the preferred microVM cell is not eligible.
            expect(cellOf(await cells.reserveCell(org, { claimId: pr, prefer: microvm, sameBackendAs: [base] }))).toBe(gvisor);
            // A released claim of the other side still fixes the backend.
            const released = await live(org, microvm);
            await s.transitionClaim(released, ['bound'], 'released', { reason: 'released' });
            expect(cellOf(await cells.reserveCell(org, { claimId: `it-claim-${randomUUID()}`, prefer: gvisor, sameBackendAs: [released] }))).toBe(microvm);
            // The other side's backend is full: a capacity wait, never the other backend.
            await db.query('UPDATE runtime.runtime_cell_sessions SET free_slots = 0 WHERE cell_id = $1', [gvisor]);
            expect(await cells.reserveCell(org, { claimId: `it-claim-${randomUUID()}`, sameBackendAs: [base] })).toMatchObject({ refused: 'no_capacity' });
            // No cell of that backend connected any more: refused with the backend named, nothing taken on the other one.
            await db.query('UPDATE runtime.runtime_cell_sessions SET disconnected_at = now() WHERE cell_id = $1', [gvisor]);
            const before = await freeSlots(db, microvm);
            expect(await cells.reserveCell(org, { claimId: `it-claim-${randomUUID()}`, sameBackendAs: [base] })).toEqual({
                refused: 'backend_unavailable',
                driver: 'gvisor',
                isolation: 'sandboxed-container',
            });
            expect(await freeSlots(db, microvm)).toBe(before);
        }));

    it('registration commits the token and the cell together; a failed insert keeps the token', async () => {
        const commands = new PgCommandStore(pool);
        const { token, tokenHash } = generateCellRegistrationToken();
        await commands.recordCellToken({ tokenHash, organizationId: 'org-a', topology: 'hybrid', expiresAt: new Date(Date.now() + 60_000).toISOString(), issuedBy: 'it' });
        const id = cellId();
        await pool.query(`INSERT INTO runtime.runtime_cells (cell_id, owner, topology, status, certificate_serial) VALUES ($1, 'customer', 'hybrid', 'disconnected', 'AA')`, [id]);
        // The cell id already exists: the insert fails, the redemption rolls back.
        await expect(
            store.redeemAndRegister(token, 'hybrid', () => ({ cellId: id, organizationId: 'org-a', owner: 'customer', topology: 'hybrid', status: 'disconnected', certificateSerial: 'BB', certificateExpiresAt: new Date().toISOString() })),
        ).rejects.toThrow();
        const fresh = cellId();
        const r = await store.redeemAndRegister(token, 'hybrid', () => ({ cellId: fresh, organizationId: 'org-a', owner: 'customer', topology: 'hybrid', status: 'disconnected', certificateSerial: 'CC', certificateExpiresAt: new Date().toISOString() }));
        expect(r).toMatchObject({ ok: true, organizationId: 'org-a' });
        expect(await store.registeredCell(fresh)).toMatchObject({ certificateSerial: 'CC' });
    });

    it("a revoked token registers nothing; a revoke and a redemption of one token never both win", async () => {
        const commands = new PgCommandStore(pool);
        const issue = async () => {
            const t = generateCellRegistrationToken();
            await commands.recordCellToken({ tokenHash: t.tokenHash, organizationId: 'org-a', topology: 'self_hosted', expiresAt: new Date(Date.now() + 60_000).toISOString(), issuedBy: 'it' });
            return t;
        };
        const row = (organizationId: string) => () => ({ cellId: cellId(), organizationId, owner: 'customer' as const, topology: 'self_hosted', status: 'disconnected' as const, certificateSerial: 'DD', certificateExpiresAt: new Date().toISOString() });

        const revoked = await issue();
        expect(await commands.revokeCellToken({ tokenHash: revoked.tokenHash, organizationId: 'org-b', revokedAt: new Date().toISOString(), revokedBy: 'it' })).toBe(false);
        expect(await commands.revokeCellToken({ tokenHash: revoked.tokenHash, organizationId: 'org-a', revokedAt: new Date().toISOString(), revokedBy: 'it' })).toBe(true);
        expect(await store.redeemAndRegister(revoked.token, undefined, row('org-a'))).toEqual({ ok: false, reason: 'unknown_or_used' });

        for (let i = 0; i < 5; i++) {
            const t = await issue();
            const [revoke, reg] = await Promise.all([
                commands.revokeCellToken({ tokenHash: t.tokenHash, organizationId: 'org-a', revokedAt: new Date().toISOString(), revokedBy: 'it' }),
                store.redeemAndRegister(t.token, undefined, row('org-a')),
            ]);
            expect([revoke, reg.ok]).not.toEqual([true, true]);
            expect(revoke || reg.ok).toBe(true);
        }
    });

    it("a cell's live claims are its pending, bound and held ones, never one it released or one that failed", async () => {
        const id = cellId();
        const live = [claim('pending', id), claim('bound', id), claim('held', id)];
        const [released, failed, terminated] = [claim('bound', id), claim('pending', id), claim('bound', id)];
        for (const c of [...live, released, failed, terminated]) await store.insertClaim(c);
        await store.transitionClaim(released.claimId, ['bound'], 'released', { reason: 'released' });
        await store.transitionClaim(failed.claimId, ['pending'], 'failed', { reason: 'boot_failed' });
        // Rebound after it failed: open again, and live on its new cell only.
        await store.rebindClaim(failed.claimId, { cellId: 'cell-elsewhere', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), hardExpiresAt: new Date(Date.now() + 120_000).toISOString() });
        await store.transitionClaim(terminated.claimId, ['bound'], 'terminated', { reason: 'cell_revoked' });
        expect((await store.liveClaimsOfCell(id)).map((c) => c.claimId).sort()).toEqual(live.map((c) => c.claimId).sort());
        expect((await store.liveClaimsOfCell('cell-elsewhere')).map((c) => c.claimId)).toEqual([failed.claimId]);
    });

    it("Health lists an org's open claims oldest first, and never a released one", async () => {
        const org = `it-org-${randomUUID()}`;
        const row = (state: ClaimState, minutesAgo: number) => ({ ...claim(state, cellId()), orgId: org, minutesAgo });
        const rows = [row('bound', 1), row('failed', 30), row('released', 90), row('held', 10)];
        for (const r of rows) {
            await store.insertClaim(r);
            await pool.query(`UPDATE runtime.runtime_claims SET state_changed_at = now() - make_interval(mins => $2),
                                     released_at = CASE WHEN state = 'released' THEN now() END WHERE claim_id = $1`, [r.claimId, r.minutesAgo]);
        }
        const readDb = new RuntimeReadDb(url);
        try {
            const open = await new PgRuntimeHealthReader(readDb).openClaims(org);
            expect(open.map((c) => c.state)).toEqual(['failed', 'held', 'bound']);
        } finally {
            await readDb.onModuleDestroy();
        }
    });

    it('lists the pins of the cells whose certificate is still valid, and never one that expired', async () => {
        const [valid, expired, unset] = [cellId(), cellId(), cellId()];
        for (const [id, expiresAt] of [[valid, new Date(Date.now() + 3_600_000)], [expired, new Date(Date.now() - 2 * 3_600_000)], [unset, null]] as const)
            await pool.query(`INSERT INTO runtime.runtime_cells (cell_id, owner, topology, status, certificate_serial, certificate_expires_at) VALUES ($1, 'kodus', 'managed', 'revoked', 'AA', $2)`, [id, expiresAt]);
        const listed = (await store.cellPins()).map((p) => p.cellId);
        expect(listed).toEqual(expect.arrayContaining([valid, unset]));
        expect(listed).not.toContain(expired);
    });

    it('revoking a cell terminates its live claims in the same transaction', async () => {
        const id = cellId();
        await pool.query(`INSERT INTO runtime.runtime_cells (cell_id, owner, topology, status, certificate_serial) VALUES ($1, 'kodus', 'managed', 'connected', 'AA')`, [id]);
        const c = claim('bound', id);
        await store.insertClaim(c);
        await new PgCommandStore(pool).revokeCell({ cellId: id, revokedBy: 'it' });
        expect(await store.claim(c.claimId)).toMatchObject({ state: 'terminated', reason: 'cell_revoked' });
        expect(await store.filterRevoked([id])).toEqual([id]);
        await pool.query(`DELETE FROM runtime.runtime_cell_revocations WHERE cell_id = $1`, [id]);
    });

    it('names the held cells whose newest certificate expired, and not one that renewed', async () => {
        const stale = cellId();
        const renewed = cellId();
        const at = Date.now();
        for (const [id, expiresAt] of [[stale, at - 1_000], [renewed, at - 1_000]] as const)
            await pool.query(`INSERT INTO runtime.runtime_cells (cell_id, owner, topology, status, certificate_serial, certificate_expires_at) VALUES ($1, 'kodus', 'managed', 'connected', 'AA', $2)`, [id, new Date(expiresAt)]);
        expect(await store.pinCertificate(renewed, 'BB', new Date(at + 3_600_000).toISOString())).toBe(true);
        expect(await store.filterExpired([stale, renewed], new Date(at).toISOString())).toEqual([stale]);
    });

    it("the worker reads a Run's claims and egress events of its own org only", async () => {
        const c = claim('bound');
        await store.insertClaim(c);
        await store.insertEgress({ claimId: c.claimId, cellId: c.cellId, orgId: 'org-a', host: 'telemetry.example.test', port: 443, phase: 'test', at: new Date().toISOString() });
        const claims = new PgRunClaims(pool);
        expect((await claims.forRun('org-a', 'run-1')).map((x) => x.claimId)).toContain(c.claimId);
        expect((await claims.forRun('org-b', 'run-1')).map((x) => x.claimId)).not.toContain(c.claimId);
        expect(await claims.egressBlocked('org-a', [c.claimId])).toEqual([{ host: 'telemetry.example.test', port: 443, phase: 'test' }]);
        expect(await claims.egressBlocked('org-b', [c.claimId])).toEqual([]);
        await pool.query('DELETE FROM runtime.runtime_egress_events WHERE claim_id = $1', [c.claimId]);
    });

    it('a security violation is recorded once per claim and alert kind, and the worker reads it for the Run', async () => {
        const c = claim('bound');
        await store.insertClaim(c);
        expect(await store.transitionClaim(c.claimId, ['pending', 'bound', 'held'], 'compromised', { reason: 'security_violation', detail: 'bait_exfiltration' })).toBe(true);
        const row = { claimId: c.claimId, orgId: 'org-a', runId: 'run-1', cellId: 'cell-a', side: 'pr', kind: 'security_violation', signature: 'credential_exfiltration', message: 'x', at: new Date().toISOString() };
        await store.recordClaimBlocker(row);
        await store.recordClaimBlocker(row);
        expect(await store.claimBlockers([c.claimId])).toHaveLength(1);
        expect(await new PgRunClaims(pool).securityViolations('org-a', [c.claimId])).toEqual([{ claimId: c.claimId, side: 'pr', signature: 'credential_exfiltration' }]);
        expect(await new PgRunClaims(pool).securityViolations('org-b', [c.claimId])).toEqual([]);
        // A compromised claim is still released at the Run's end.
        expect(await store.transitionClaim(c.claimId, ['pending', 'bound', 'held', 'blocked', 'failed', 'compromised'], 'released', { reason: 'released' })).toBe(true);
        await pool.query('DELETE FROM runtime.runtime_claim_blockers WHERE claim_id = $1', [c.claimId]);
    });

    it("keeps each cell's evicted build states as exactly its last list, and one cell's never another's", async () => {
        const cell = `it-cell-${randomUUID()}`;
        const other = `it-cell-${randomUUID()}`;
        const at = '2026-11-13T07:31:31.000Z';
        await store.syncEvictedBuildStates(cell, [{ orgId: 'org-a', environmentId: 'env-1', evictedAt: at }, { orgId: 'org-a', environmentId: 'env-2', evictedAt: at }]);
        await store.syncEvictedBuildStates(other, [{ orgId: 'org-b', environmentId: 'env-1', evictedAt: at }]);
        expect(await store.evictedBuildStateAt(cell, 'org-a', 'env-1')).toBe(at);
        expect(await store.evictedBuildStateAt(cell, 'org-b', 'env-1')).toBeNull();
        await store.syncEvictedBuildStates(cell, [{ orgId: 'org-a', environmentId: 'env-2', evictedAt: at }]);
        expect(await store.evictedBuildStateAt(cell, 'org-a', 'env-1')).toBeNull();
        expect(await store.evictedBuildStateAt(cell, 'org-a', 'env-2')).toBe(at);
        await store.syncEvictedBuildStates(cell, []);
        expect(await store.evictedBuildStateAt(cell, 'org-a', 'env-2')).toBeNull();
        expect(await store.evictedBuildStateAt(other, 'org-b', 'env-1')).toBe(at);
        await store.syncEvictedBuildStates(other, []);
        // What the state cost to make is kept with its row, and replaced by the cell's next list.
        await store.syncEvictedBuildStates(cell, [{ orgId: 'org-a', environmentId: 'env-3', evictedAt: at, rebuildSeconds: 1_802 }]);
        expect(await store.evictedBuildState(cell, 'org-a', 'env-3')).toEqual({ orgId: 'org-a', environmentId: 'env-3', evictedAt: at, rebuildSeconds: 1_802 });
        await store.syncEvictedBuildStates(cell, [{ orgId: 'org-a', environmentId: 'env-3', evictedAt: at }]);
        expect(await store.evictedBuildState(cell, 'org-a', 'env-3')).toEqual({ orgId: 'org-a', environmentId: 'env-3', evictedAt: at });
        expect(await store.evictedBuildState(cell, 'org-b', 'env-3')).toBeNull();
        await store.syncEvictedBuildStates(cell, []);
    });

    it('a keyed Run event is written once; reads resume from the offset', async () => {
        const streams = new PgRunStreamStore(pool);
        const runId = `it-run-${randomUUID()}`;
        const e = { type: 'state' as const, at: new Date().toISOString(), data: { state: 'booting' } };
        await streams.append('org-a', runId, e, '1:state:booting');
        await streams.append('org-a', runId, e, '1:state:booting');
        await streams.append('org-a', runId, { ...e, data: { state: 'testing' } }, '1:state:testing');
        const first = (await streams.read('org-a', runId, undefined, 1))!;
        expect(first.events).toHaveLength(1);
        expect(first.upToDate).toBe(false);
        const rest = (await streams.read('org-a', runId, first.nextOffset))!;
        expect(rest.events.map((x) => x.data.state)).toEqual(['testing']);
        expect(await streams.read('org-b', runId)).toBeNull();
        await pool.query('DELETE FROM runtime.runtime_run_events WHERE run_id = $1', [runId]);
    });

    it('the API reads the Postgres stream inside a read-only transaction, org-scoped', async () => {
        const runId = `it-run-${randomUUID()}`;
        await new PgRunStreamStore(pool).append('org-a', runId, { type: 'phase', at: new Date().toISOString(), data: { phase: 'boot' } }, `step:${randomUUID()}:started`);
        const readDb = new RuntimeReadDb(url);
        const reader = new PgRuntimeRunStreamReader(readDb);
        try {
            expect((await reader.read('org-a', runId))!.events.map((e) => e.data.phase)).toEqual(['boot']);
            expect(await reader.read('org-b', runId)).toBeNull();
            await expect(reader.append('org-a', runId, { type: 'phase', at: '', data: {} })).rejects.toThrow('does not write');
        } finally {
            await readDb.onModuleDestroy();
            await pool.query('DELETE FROM runtime.runtime_run_events WHERE run_id = $1', [runId]);
        }
    });

    it('retention deletes stream rows past 30 days in batches, and keeps the rest', async () => {
        const runId = `it-run-${randomUUID()}`;
        for (let i = 0; i < 5; i++) {
            await pool.query(`INSERT INTO runtime.runtime_run_events (org_id, run_id, event, created_at) VALUES ('org-a', $1, '{}'::jsonb, now() - interval '31 days')`, [runId]);
        }
        await pool.query(`INSERT INTO runtime.runtime_run_events (org_id, run_id, event) VALUES ('org-a', $1, '{}'::jsonb)`, [runId]);
        expect(await applyRetention(pool, 30, 2)).toBeGreaterThanOrEqual(5);
        expect((await pool.query('SELECT count(*)::int AS n FROM runtime.runtime_run_events WHERE run_id = $1', [runId])).rows[0].n).toBe(1);
        await pool.query('DELETE FROM runtime.runtime_run_events WHERE run_id = $1', [runId]);
    });

    it("retention removes old env steps, ended env sessions, and a fleet host's rows once it ended, and keeps what is live", async () => {
        const old = "now() - interval '31 days'";
        const org = `it-org-${randomUUID()}`;
        const [liveSession, endedSession, oldEnded] = [randomUUID(), randomUUID(), randomUUID()];
        const session = (id: string, state: string, at: string) =>
            pool.query(`INSERT INTO runtime.runtime_env_sessions (session_id, organization_id, team_id, repository_id, key_id, environment_id, sha, state, created_at, last_used_at)
                         VALUES ($1, $2, 't', 'r', 'k', 'e', $3, $4, ${at}, ${at})`, [id, org, 'a'.repeat(40), state]);
        await session(liveSession, 'ready', old);
        await session(oldEnded, 'released', old);
        await session(endedSession, 'released', 'now()');
        const [oldStep, newStep] = [randomUUID(), randomUUID()];
        await pool.query(`INSERT INTO runtime.runtime_env_steps (step_id, session_id, organization_id, command, timeout_ms, state, started_at) VALUES ($1, $2, $3, 'npm test', 1000, 'done', ${old})`, [oldStep, liveSession, org]);
        await pool.query(`INSERT INTO runtime.runtime_env_steps (step_id, session_id, organization_id, command, timeout_ms, state, started_at) VALUES ($1, $2, $3, 'npm test', 1000, 'done', now())`, [newStep, liveSession, org]);
        const pool_ = `it-pool-${randomUUID()}`;
        await pool.query(`INSERT INTO runtime.runtime_host_pools (pool_id, scope, provider, lifecycle) VALUES ($1, 'kodus', 'fake', 'perRun')`, [pool_]);
        const [gone, failed] = [`it-host-${randomUUID()}`, `it-host-${randomUUID()}`];
        await pool.query(`INSERT INTO runtime.runtime_hosts (host_id, pool_id, provider, state, terminated_at) VALUES ($1, $2, 'fake', 'terminated', ${old})`, [gone, pool_]);
        await pool.query(`INSERT INTO runtime.runtime_hosts (host_id, pool_id, provider, state, updated_at) VALUES ($1, $2, 'fake', 'failed', ${old})`, [failed, pool_]);
        await pool.query(`INSERT INTO runtime.runtime_host_events (host_id, pool_id, to_state, reason, at) VALUES ($1, $2, 'terminated', 'destroyed', ${old}), ($1, $2, 'terminated', 'destroyed', now())`, [gone, pool_]);
        await pool.query(`INSERT INTO runtime.runtime_pool_demand (pool_id, bound_key, organization_id, expires_at) VALUES ($1, 'run:old', $2, ${old}), ($1, 'run:new', $2, now() + interval '2 minutes')`, [pool_, org]);

        await applyRetention(pool);

        const ids = async (sql: string, args: unknown[]) => (await pool.query(sql, args)).rows.map((r) => Object.values(r)[0]);
        expect((await ids(`SELECT session_id FROM runtime.runtime_env_sessions WHERE organization_id = $1 ORDER BY session_id`, [org])).sort()).toEqual([liveSession, endedSession].sort());
        expect(await ids(`SELECT step_id FROM runtime.runtime_env_steps WHERE organization_id = $1`, [org])).toEqual([newStep]);
        // A host that did not end (failed, its teardown still owed) is kept, whatever its age.
        expect(await ids(`SELECT host_id FROM runtime.runtime_hosts WHERE pool_id = $1`, [pool_])).toEqual([failed]);
        expect(await ids(`SELECT count(*)::int FROM runtime.runtime_host_events WHERE pool_id = $1`, [pool_])).toEqual([1]);
        expect(await ids(`SELECT bound_key FROM runtime.runtime_pool_demand WHERE pool_id = $1`, [pool_])).toEqual(['run:new']);
    });

    it('retention drains old audit rows a batch at a time and keeps the recent ones', async () => {
        const org = `it-org-${randomUUID()}`;
        for (let i = 0; i < 5; i++) {
            await pool.query(
                `INSERT INTO runtime.runtime_sandbox_audit (org_id, claim_id, cell_id, step_id, op, outcome, duration_ms, at) VALUES ($1, 'c', 'cell', $2, 'exec', 'ok', 1, now() - interval '31 days')`,
                [org, randomUUID()],
            );
        }
        await pool.query(`INSERT INTO runtime.runtime_sandbox_audit (org_id, claim_id, cell_id, step_id, op, outcome, duration_ms, at) VALUES ($1, 'c', 'cell', $2, 'exec', 'ok', 1, now())`, [org, randomUUID()]);
        await applyRetention(pool, 30, 2);
        expect((await pool.query('SELECT count(*)::int AS n FROM runtime.runtime_sandbox_audit WHERE org_id = $1', [org])).rows[0].n).toBe(1);
    });

    it("retention removes claims that ended past the report's year, old machine-minute rows and ended fleet cells, and keeps the rest", async () => {
        const org = `it-org-${randomUUID()}`;
        const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
        const insert = async (state: ClaimState, createdDaysAgo: number, releasedDaysAgo: number | null) => {
            const c = { ...claim(state), orgId: org };
            await store.insertClaim(c);
            await pool.query(`UPDATE runtime.runtime_claims SET created_at = $2, released_at = $3 WHERE claim_id = $1`, [c.claimId, days(createdDaysAgo), releasedDaysAgo === null ? null : days(releasedDaysAgo)]);
            return c.claimId;
        };
        const oldReleased = await insert('released', 420, 420);
        const oldTerminated = await insert('terminated', 410, 409);
        const recentReleased = await insert('released', 60, 60);
        const oldOpen = await insert('failed', 420, null);
        for (const [claimId, dayAgo] of [[recentReleased, 31], [oldOpen, 2]] as const) {
            await pool.query(
                `INSERT INTO runtime.runtime_machine_reservations (claim_id, org_id, day, round_started_at, round_reserved_seconds) VALUES ($1, $2, ((now() AT TIME ZONE 'UTC')::date - $3::int), now(), 0)`,
                [claimId, org, dayAgo],
            );
        }
        const [endedFleet, liveFleet, oldCustomer] = [cellId(), cellId(), cellId()];
        for (const [id, hostId, owner, expiredDaysAgo] of [[endedFleet, 'host-a', 'kodus', 401], [liveFleet, 'host-b', 'kodus', -1], [oldCustomer, null, 'customer', 900]] as const) {
            await pool.query(
                `INSERT INTO runtime.runtime_cells (cell_id, owner, topology, status, certificate_serial, certificate_expires_at, host_id) VALUES ($1, $2, 'managed', 'revoked', 'AA', $3, $4)`,
                [id, owner, days(expiredDaysAgo), hostId],
            );
            await pool.query(`INSERT INTO runtime.runtime_cell_revocations (cell_id, revoked_by) VALUES ($1, 'it')`, [id]);
        }

        await applyRetention(pool, 30, 2);

        const ids = async (sql: string, args: unknown[]) => (await pool.query(sql, args)).rows.map((r) => Object.values(r)[0]);
        expect((await ids(`SELECT claim_id FROM runtime.runtime_claims WHERE org_id = $1`, [org])).sort()).toEqual([recentReleased, oldOpen].sort());
        expect(oldTerminated && oldReleased).toBeTruthy();
        expect(await ids(`SELECT claim_id FROM runtime.runtime_machine_reservations WHERE org_id = $1`, [org])).toEqual([oldOpen]);
        expect((await ids(`SELECT cell_id FROM runtime.runtime_cells WHERE cell_id = ANY($1::text[])`, [[endedFleet, liveFleet, oldCustomer]])).sort()).toEqual([liveFleet, oldCustomer].sort());
        expect((await ids(`SELECT cell_id FROM runtime.runtime_cell_revocations WHERE cell_id = ANY($1::text[])`, [[endedFleet, liveFleet, oldCustomer]])).sort()).toEqual([liveFleet, oldCustomer].sort());
        await pool.query(`DELETE FROM runtime.runtime_cell_revocations WHERE cell_id = ANY($1::text[])`, [[liveFleet, oldCustomer]]);
    });

    it('a maintenance lock is held by one caller at a time across connections', async () => {
        const locks = new PgDistributedLocks(pool);
        let inner: unknown = 'not run';
        const outer = await locks.tryWithLock('it-lock', async () => {
            inner = await locks.tryWithLock('it-lock', async () => 'ran');
            return 'held';
        });
        expect(outer).toBe('held');
        expect(inner).toBeUndefined();
    });
});
