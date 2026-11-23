import { randomUUID } from 'crypto';

import { Pool, type PoolClient } from 'pg';

import { PgHubStore } from '../../hub/hub-store';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgPhysicalAdmissionDirectory } from '../admission/physical-admission-directory';
import type { PhysicalAdmissionRequest } from '../admission/admission-contract';
import { claimIdFor } from '../claim-id';
import { type CellLocation, type CellRefusal, type InTransaction, PgCellDirectory, reserveCellRow } from './cell-directory';
import { PgHostPoolReader } from './host-pools';
import { ensureRuntimeSchema } from './runtime-schema';

// docs/runtime/host-providers.md §4.4 and §6: placement by pool, through both placement paths.
// Opt-in: RUNTIME_IT_DATABASE_URL (locally postgres://runtime:runtime@localhost:5442/kodus_runtime_it).
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'directory_pools');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const BOAT = 'boat-eu-perrun';

(skip ? describe.skip : describe)('placement by pool (real Postgres)', () => {
    let pool: Pool;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 4 });
        await ensureRuntimeSchema(pool);
    });

    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

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

    /** Each case in a transaction rolled back after it, with every other connected cell disconnected. */
    const isolated = async (fn: (db: PoolClient, s: PgHubStore) => Promise<void>) => {
        const db = await pool.connect();
        try {
            await db.query('BEGIN');
            await db.query(`UPDATE runtime.runtime_cell_sessions SET disconnected_at = now() WHERE disconnected_at IS NULL`);
            await fn(db, new PgHubStore(db));
        } finally {
            await db.query('ROLLBACK');
            db.release();
        }
    };

    const boatPool = (db: PoolClient, allowOrgs: string[]) =>
        db.query(
            `INSERT INTO runtime.runtime_host_pools (pool_id, scope, provider, lifecycle, weight, spec, status) VALUES ($1, 'kodus', 'boat', 'perRun', 100, $2, '{"scalable": true}')`,
            [BOAT, JSON.stringify({ admission: { allowOrgs }, labels: { isolation: 'microvm' } })],
        );

    /** A connected cell; a row first when it has a pool, host or binding of its own (what registration writes). */
    const connect = async (db: PoolClient, s: PgHubStore, row: { owner?: 'kodus' | 'customer'; orgId?: string; poolId?: string; boundKey?: string; slots?: number; epoch?: boolean } = {}) => {
        const cellId = `it-cell-${randomUUID()}`;
        const owner = row.owner ?? 'kodus';
        if (row.poolId || row.boundKey) {
            await db.query(
                `INSERT INTO runtime.runtime_cells (cell_id, organization_id, owner, topology, certificate_serial, pool_id, bound_key, host_id) VALUES ($1, $2, $3, 'fleet', 'ff', $4, $5, $6)`,
                [cellId, row.orgId ?? null, owner, row.poolId ?? null, row.boundKey ?? null, row.boundKey ? `host-${randomUUID()}` : null],
            );
        }
        await s.upsertSession({ cellId, replicaId: 'r', replicaUrl: `u-${cellId}`, owner, ...(row.orgId ? { orgId: row.orgId } : {}), driver: 'fake', ...(row.epoch ? { sessionEpoch: randomUUID() } : {}) });
        await s.heartbeat(cellId, 'r', row.slots ?? 4);
        return cellId;
    };
    const cellOf = (r: CellLocation | CellRefusal | null) => (r && 'cellId' in r ? r.cellId : r);
    const directory = (db: PoolClient) => new PgCellDirectory(db, { sharedClaimCap: 100, inTransaction: savepoint(db), pools: new PgHostPoolReader(db, { cacheMs: 0 }) });
    const freeSlots = async (db: PoolClient, id: string) => (await db.query('SELECT free_slots FROM runtime.runtime_cell_sessions WHERE cell_id = $1', [id])).rows[0].free_slots;

    it('a cordoned cell takes no new claim, with no pools configured, and its free slots stay untouched', () =>
        isolated(async (db, s) => {
            const org = `org-${randomUUID()}`;
            const cordoned = await connect(db, s, { slots: 9 });
            const open = await connect(db, s, { slots: 1 });
            await db.query('UPDATE runtime.runtime_cell_sessions SET cordoned_at = now() WHERE cell_id = $1', [cordoned]);
            const cells = new PgCellDirectory(db, { sharedClaimCap: 100, inTransaction: savepoint(db) });
            expect(cellOf(await cells.reserveCell(org))).toBe(open);
            expect(await cells.reserveCell(org)).toMatchObject({ refused: 'no_capacity' });
            expect(await freeSlots(db, cordoned)).toBe(9);
            expect(await reserveCellRow(db, org)).toMatchObject({ cell_id: open });
        }));

    it("a Run of an admitted org waits for its own host on the perRun pool, records the demand once, and never takes the static cell or another Run's host", () =>
        isolated(async (db, s) => {
            const org = `org-${randomUUID()}`;
            await boatPool(db, [org]);
            const fallback = await connect(db, s, { slots: 9 });
            const otherRun = await connect(db, s, { poolId: BOAT, boundKey: `run:${org}/other` });
            const cells = directory(db);
            const want = { claimId: claimIdFor(org, 'r-1:base:1'), consumer: 'runtime', runId: 'r-1', environmentId: 'env-1' } as const;

            expect(await cells.reserveCell(org, want)).toEqual({ refused: 'no_capacity', pool: BOAT, hostStarting: true });
            expect(await cells.reserveCell(org, want)).toEqual({ refused: 'no_capacity', pool: BOAT, hostStarting: true });
            const demand = (await db.query(`SELECT pool_id, bound_key, organization_id, environment_id, run_id, expires_at > now() AS live FROM runtime.runtime_pool_demand`)).rows;
            expect(demand).toEqual([{ pool_id: BOAT, bound_key: `run:${org}/r-1`, organization_id: org, environment_id: 'env-1', run_id: 'r-1', live: true }]);
            expect(await freeSlots(db, fallback)).toBe(9);
            expect(await freeSlots(db, otherRun)).toBe(4);
        }));

    it("once the Run's host registered, both sides land on it, in its pool", () =>
        isolated(async (db, s) => {
            const org = `org-${randomUUID()}`;
            await boatPool(db, [org]);
            await connect(db, s, { slots: 9 });
            const host = await connect(db, s, { poolId: BOAT, boundKey: `run:${org}/r-1` });
            const cells = directory(db);
            const [base, pr] = [claimIdFor(org, 'r-1:base:1'), claimIdFor(org, 'r-1:pr:1')];
            expect(cellOf(await cells.reserveCell(org, { claimId: base, consumer: 'runtime', runId: 'r-1', sameBackendAs: [pr] }))).toBe(host);
            expect(cellOf(await cells.reserveCell(org, { claimId: pr, consumer: 'runtime', runId: 'r-1', sameBackendAs: [base] }))).toBe(host);
        }));

    it("the other side follows the first side's pool, even when placement would now start elsewhere", () =>
        isolated(async (db, s) => {
            const org = `org-${randomUUID()}`;
            const fallback = await connect(db, s, { slots: 9 });
            const cells = directory(db);
            const [base, pr] = [claimIdFor(org, 'r-2:base:1'), claimIdFor(org, 'r-2:pr:1')];
            // No fleet pool yet: the base goes to the static cell.
            expect(cellOf(await cells.reserveCell(org, { claimId: base, consumer: 'runtime', runId: 'r-2', sameBackendAs: [pr] }))).toBe(fallback);
            // A boat pool appears between the two sides: the PR still goes where the base is.
            await boatPool(db, [org]);
            expect(cellOf(await cells.reserveCell(org, { claimId: pr, consumer: 'runtime', runId: 'r-2', sameBackendAs: [base] }))).toBe(fallback);
        }));

    it('a host the fleet could not make is host_unavailable, naming the pool and why, not a wait', () =>
        isolated(async (db, s) => {
            const org = `org-${randomUUID()}`;
            await boatPool(db, [org]);
            await connect(db, s, { slots: 9 });
            const cells = directory(db);
            const want = { claimId: claimIdFor(org, 'r-3:base:1'), consumer: 'runtime', runId: 'r-3' } as const;
            await cells.reserveCell(org, want);
            await db.query(`UPDATE runtime.runtime_pool_demand SET failed_at = now(), failure = 'registration_timeout'`);
            expect(await cells.reserveCell(org, want)).toEqual({ refused: 'host_unavailable', pool: BOAT, reason: 'registration_timeout' });
        }));

    it('an org the boat pool does not admit, and a setup of an admitted one, place as before', () =>
        isolated(async (db, s) => {
            const [admitted, other] = [`org-${randomUUID()}`, `org-${randomUUID()}`];
            await boatPool(db, [admitted]);
            const fallback = await connect(db, s, { slots: 9 });
            const cells = directory(db);
            expect(cellOf(await cells.reserveCell(other, { consumer: 'runtime', runId: 'r-4' }))).toBe(fallback);
            expect(cellOf(await cells.reserveCell(admitted, { consumer: 'setup' }))).toBe(fallback);
            expect((await db.query(`SELECT count(*)::int AS n FROM runtime.runtime_pool_demand`)).rows[0].n).toBe(0);
        }));

    it('a bound cell never serves an acquire that names no Run, through the hub fallback either', () =>
        isolated(async (db, s) => {
            const org = `org-${randomUUID()}`;
            await connect(db, s, { poolId: BOAT, boundKey: `run:${org}/r-5` });
            expect(await reserveCellRow(db, org)).toBeNull();
            expect(await new PgCellDirectory(db, { sharedClaimCap: 100, inTransaction: savepoint(db) }).reserveCell(org)).toBeNull();
        }));

    it('physical admission skips cordoned cells and cells bound to another Run, and waits for the Run host on a perRun pool', () =>
        isolated(async (db, s) => {
            const org = `org-${randomUUID()}`;
            const key = randomUUID();
            const req: PhysicalAdmissionRequest = {
                organizationId: org,
                kind: 'run',
                key,
                generation: 1,
                ticketOwnerToken: randomUUID(),
                executionId: randomUUID(),
                deadlineAt: new Date(Date.now() + 120_000).toISOString(),
                members: (['base', 'pr'] as const).map((side) => ({ side, idempotencyKey: `${key}:${side}:1` })),
            };
            const cordoned = await connect(db, s, { slots: 9, epoch: true });
            await db.query('UPDATE runtime.runtime_cell_sessions SET cordoned_at = now() WHERE cell_id = $1', [cordoned]);
            await connect(db, s, { poolId: BOAT, boundKey: `run:${org}/other`, epoch: true });
            const physical = new PgPhysicalAdmissionDirectory(db, { inTransaction: savepoint(db), sharedClaimCap: 100, pools: new PgHostPoolReader(db, { cacheMs: 0 }) });
            expect(await physical.reserve(req)).toMatchObject({ status: 'refused', reason: 'no_cell' });
            const open = await connect(db, s, { slots: 9, epoch: true });
            expect(await physical.reserve(req)).toMatchObject({ status: 'located', cell: { cellId: open } });

            const key2 = randomUUID();
            await boatPool(db, [org]);
            const run2 = { ...req, key: key2, ticketOwnerToken: randomUUID(), members: req.members.map((m) => ({ ...m, idempotencyKey: m.idempotencyKey.replace(key, key2) })) };
            expect(await physical.reserve(run2)).toMatchObject({ status: 'refused', reason: 'no_capacity', retryable: true });
            expect((await db.query(`SELECT bound_key FROM runtime.runtime_pool_demand`)).rows).toEqual([{ bound_key: `run:${org}/${key2}` }]);
            const host = await connect(db, s, { poolId: BOAT, boundKey: `run:${org}/${key2}`, epoch: true });
            expect(await physical.reserve(run2)).toMatchObject({ status: 'located', cell: { cellId: host } });
        }));

    describe("a template's setup (host-providers.md §8.2)", () => {
        const setup = (org: string, boundKey?: string) => ({ claimId: claimIdFor(org, 'setup:s-1:boot'), consumer: 'setup', environmentId: 'env-1', ...(boundKey ? { boundKey } : {}) }) as const;

        it('goes only to the cell bound to its key, whatever pool that cell is in, and records no pool demand', () =>
            isolated(async (db, s) => {
                const org = `org-${randomUUID()}`;
                await boatPool(db, [org]);
                const shared = await connect(db, s, { slots: 9 });
                const otherTemplate = await connect(db, s, { poolId: BOAT, boundKey: `template:${org}/env-2` });
                const host = await connect(db, s, { poolId: 'some-other-pool', boundKey: `template:${org}/env-1` });
                const cells = directory(db);

                expect(cellOf(await cells.reserveCell(org, setup(org, `template:${org}/env-1`)))).toBe(host);
                expect(await freeSlots(db, host)).toBe(3);
                expect(await freeSlots(db, shared)).toBe(9);
                expect(await freeSlots(db, otherTemplate)).toBe(4);
                expect((await db.query('SELECT 1 FROM runtime.runtime_pool_demand')).rows).toEqual([]);
            }));

        it('waits for its host while none is bound to the key: never the shared cell, never another template, and not the no-cell answer that ends the setup', () =>
            isolated(async (db, s) => {
                const org = `org-${randomUUID()}`;
                const shared = await connect(db, s, { slots: 9 });
                const other = await connect(db, s, { boundKey: `template:${org}/env-2` });
                const cells = directory(db);

                expect(await cells.reserveCell(org, setup(org, `template:${org}/env-1`))).toEqual({ refused: 'no_capacity', hostStarting: true });
                expect(await freeSlots(db, shared)).toBe(9);
                expect(await freeSlots(db, other)).toBe(4);
                expect((await db.query('SELECT 1 FROM runtime.runtime_pool_demand')).rows).toEqual([]);
            }));

        it("a key of another org's template is ignored: the setup is an ordinary one, and no template-bound cell takes it", () =>
            isolated(async (db, s) => {
                const org = `org-${randomUUID()}`;
                const shared = await connect(db, s, { slots: 9 });
                const foreign = await connect(db, s, { boundKey: `template:other-org/env-1` });
                const cells = directory(db);

                expect(cellOf(await cells.reserveCell(org, setup(org, `template:other-org/env-1`)))).toBe(shared);
                expect(await freeSlots(db, foreign)).toBe(4);
            }));

        it('a cell bound to a template takes no other claim: not a Run, not an ordinary setup, not a setup of another template', () =>
            isolated(async (db, s) => {
                const org = `org-${randomUUID()}`;
                const host = await connect(db, s, { poolId: BOAT, boundKey: `template:${org}/env-1` });
                const cells = directory(db);

                for (const want of [
                    { claimId: claimIdFor(org, 'r-9:base:1'), consumer: 'runtime', runId: 'r-9' },
                    { claimId: claimIdFor(org, 'r-9:base:1'), consumer: 'runtime', runId: 'r-9', boundKey: `template:${org}/env-1` },
                    setup(org),
                ] as const) {
                    expect(await cells.reserveCell(org, want)).toBeNull();
                }
                expect(await cells.reserveCell(org, setup(org, `template:${org}/env-2`))).toEqual({ refused: 'no_capacity', hostStarting: true });
                expect(await reserveCellRow(db, org)).toBeNull();
                expect(await freeSlots(db, host)).toBe(4);
            }));
    });
});
