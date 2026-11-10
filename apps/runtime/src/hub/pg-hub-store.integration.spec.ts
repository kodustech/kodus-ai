import { randomUUID } from 'crypto';

import { Pool, type PoolClient } from 'pg';

import { generateCellRegistrationToken } from '@libs/runtime/api/domain/cell-token';

import { type CellLocation, type CellRefusal, type InTransaction, PgCellDirectory, pgTransaction } from '../shared/persistence/cell-directory';
import { PgDistributedLocks } from '../shared/persistence/locks';
import { PgRunClaims } from '../worker/persistence/pg-run-claims';
import { PgCommandStore } from '../shared/persistence/pg-command-store';
import { PgRunStreamStore } from '../shared/persistence/pg-run-stream-store';
import { applyRetention, ensureRuntimeSchema } from '../shared/persistence/runtime-schema';
import { PgRuntimeRunStreamReader } from '@libs/runtime/api/infrastructure/pg-runtime-run-stream.reader';
import { PgRuntimeClaimUsageReader } from '@libs/runtime/api/infrastructure/pg-runtime-claim-usage.reader';
import { PgHubStore, type ClaimState } from './hub-store';

// Opt-in: runs against the Postgres RUNTIME_IT_DATABASE_URL names (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), and skips when
// none is named, as in the backend CI suite, which starts no such database.
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
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
        pool = new Pool({ connectionString: url, max: 4 });
        await ensureRuntimeSchema(pool);
        store = new PgHubStore(pool);
    });

    afterAll(async () => {
        await pool?.query(`DELETE FROM runtime.runtime_steps_index WHERE step_id = ANY($1)`, [stepIds]);
        await pool?.query(`DELETE FROM runtime.runtime_claims WHERE claim_id = ANY($1) OR cell_id = ANY($2)`, [ids, cells]);
        await pool?.query(`DELETE FROM runtime.runtime_cell_sessions WHERE cell_id = ANY($1)`, [cells]);
        await pool?.query(`DELETE FROM runtime.runtime_cells WHERE cell_id = ANY($1)`, [cells]);
        await pool?.end();
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

    it('keeps what a cell named in its hello, and a reconnect that names less forgets the rest', async () => {
        const id = cellId();
        await store.upsertSession({ cellId: id, replicaId: 'r', replicaUrl: 'u', owner: 'kodus', driver: 'fake', features: ['seedsCache', 'claimSize'], maxClaimSize: { memoryMb: 16_384, cpus: 8 } });
        expect(await store.session(id)).toMatchObject({ features: ['seedsCache', 'claimSize'], maxClaimSize: { memoryMb: 16_384, cpus: 8 } });
        // The cell came back downgraded (an older build): its hello names nothing.
        await store.upsertSession({ cellId: id, replicaId: 'r', replicaUrl: 'u', owner: 'kodus', driver: 'fake' });
        expect(await store.session(id)).toMatchObject({ features: [], maxClaimSize: null });
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

    it('records what each round held once per transition, and the API reads it org-scoped inside a read-only transaction', async () => {
        const c = { ...claim(), runId: `it-run-${randomUUID()}` };
        await store.insertClaim({ ...c, metering: { driver: 'docker-gvisor', bootMb: 12_288, readyMb: 2_048, allocatableMb: 14_745 } });
        const admitted = (await store.claim(c.claimId))!;
        expect(admitted).toMatchObject({ metering: { driver: 'docker-gvisor', bootMb: 12_288, readyMb: 2_048, allocatableMb: 14_745 }, readyAt: null, releasedAt: null });
        expect(admitted.admittedAt).not.toBeNull();
        await store.transitionClaim(c.claimId, ['pending'], 'bound', { reason: 'ready' });
        const ready = (await store.claim(c.claimId))!;
        expect(ready.readyAt).not.toBeNull();
        await store.transitionClaim(c.claimId, ['bound'], 'released', { reason: 'released' });
        const released = (await store.claim(c.claimId))!;
        expect(released).toMatchObject({ readyAt: ready.readyAt, admittedAt: admitted.admittedAt });
        expect(released.releasedAt).not.toBeNull();

        const reader = new PgRuntimeClaimUsageReader(url);
        try {
            const rows = await reader.claimsOfRuns('org-a', [c.runId]);
            expect(rows.get(c.runId)).toEqual([
                expect.objectContaining({ claimId: c.claimId, driver: 'docker-gvisor', bootMb: 12_288, readyMb: 2_048, allocatableMb: 14_745, readyAt: ready.readyAt, releasedAt: released.releasedAt }),
            ]);
            expect((await reader.claimsOfRuns('org-b', [c.runId])).size).toBe(0);
        } finally {
            await reader.onModuleDestroy();
        }

        // A new round on another cell (no memory reported there) is admitted again: not ready, its own metering.
        const r = claim();
        await store.insertClaim({ ...r, metering: { driver: 'docker-gvisor', bootMb: 12_288, readyMb: 2_048, allocatableMb: 14_745 } });
        await store.transitionClaim(r.claimId, ['pending'], 'bound', { reason: 'ready' });
        const hard = new Date(Date.now() + 600_000).toISOString();
        await store.rebindClaim(r.claimId, { cellId: 'cell-c', leaseExpiresAt: hard, hardExpiresAt: hard, metering: { driver: 'aws-ec2', bootMb: null, readyMb: null, allocatableMb: null } });
        expect(await store.claim(r.claimId)).toMatchObject({ metering: { driver: 'aws-ec2', bootMb: null }, readyAt: null });
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

            expect(await cells.reserveCell(org)).toEqual({ refused: 'org_capacity', cap: 2, open: 2 });
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
            expect(picked.filter((p) => p && 'refused' in p)).toEqual(Array(3).fill({ refused: 'org_capacity', cap: 2, open: 2 }));

            const won = burst.find((_, i) => onShared(picked[i]))!;
            // A new round of a reserved claim is not one more claim.
            expect(onShared(await cells.reserveCell(org, { claimId: won }))).toBe(true);
            // The hub's claim row replaces the reservation: still two, not three.
            await store.insertClaim({ ...claim('pending', shared[0]), claimId: won, orgId: org });
            expect(await cells.reserveCell(org, { claimId: `it-claim-${randomUUID()}` })).toEqual({ refused: 'org_capacity', cap: 2, open: 2 });
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
            expect(rb).toEqual({ refused: 'org_capacity', cap: 1, open: 1 });
        } finally {
            for (const id of shared) await store.disconnect(id, 'r');
            await pool.query(`DELETE FROM runtime.runtime_cell_reservations WHERE org_id = $1`, [org]);
        }
    });

    it('no free slot on any eligible cell is no_capacity, never a full cell; no cell at all is none', () =>
        isolated(async (db, s) => {
            const [org, other] = [`org-${randomUUID()}`, `org-${randomUUID()}`];
            await connect(s, 'kodus', 0);
            await connect(s, 'customer', 0, org);
            // Another org's free cell is never eligible.
            await connect(s, 'customer', 9, other);
            const cells = new PgCellDirectory(db, { inTransaction: savepoint(db) });

            expect(await cells.reserveCell(org)).toEqual({ refused: 'no_capacity' });
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
            expect(await cells.reserveCell(org, { size: large })).toEqual({ refused: 'no_capacity' });
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

    it('a security violation is recorded once per claim and alert kind, and the worker reads it for the Run', async () => {
        const c = claim('bound');
        await store.insertClaim(c);
        expect(await store.transitionClaim(c.claimId, ['pending', 'bound', 'held'], 'compromised', { reason: 'security_violation', detail: 'bait_exfiltration' })).toBe(true);
        const row = { claimId: c.claimId, orgId: 'org-a', runId: 'run-1', cellId: 'cell-a', side: 'pr', kind: 'security_violation', signature: 'credential_exfiltration', message: 'x', at: new Date().toISOString() };
        await store.recordClaimBlocker(row);
        await store.recordClaimBlocker(row);
        expect(await store.claimBlockers([c.claimId])).toHaveLength(1);
        expect(await new PgRunClaims(pool).securityViolations([c.claimId])).toEqual([{ claimId: c.claimId, side: 'pr', signature: 'credential_exfiltration' }]);
        // A compromised claim is still released at the Run's end.
        expect(await store.transitionClaim(c.claimId, ['pending', 'bound', 'held', 'blocked', 'failed', 'compromised'], 'released', { reason: 'released' })).toBe(true);
        await pool.query('DELETE FROM runtime.runtime_claim_blockers WHERE claim_id = $1', [c.claimId]);
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
        const reader = new PgRuntimeRunStreamReader(url);
        try {
            expect((await reader.read('org-a', runId))!.events.map((e) => e.data.phase)).toEqual(['boot']);
            expect(await reader.read('org-b', runId)).toBeNull();
            await expect(reader.append('org-a', runId, { type: 'phase', at: '', data: {} })).rejects.toThrow('does not write');
        } finally {
            await reader.onModuleDestroy();
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
