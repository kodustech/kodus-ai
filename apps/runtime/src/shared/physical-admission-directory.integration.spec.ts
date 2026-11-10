import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PgHubStore } from '../hub/hub-store';
import { PgCellDirectory, pgTransaction } from './cell-directory';
import { claimIdFor } from './claim-id';
import type {
    PhysicalAdmissionRequest,
    PhysicalAdmissionTicket,
} from './admission-contract';
import { PgPhysicalAdmissionDirectory } from './physical-admission-directory';
import { ensureRuntimeSchema } from './runtime-schema';

const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
(!url || process.env.SKIP_INTEGRATION === 'true' ? describe.skip : describe)(
    'paired physical reservations (real Postgres)',
    () => {
        let pool: Pool;
        let store: PgHubStore;
        const cells: string[] = [];
        const orgs: string[] = [];
        beforeAll(async () => {
            pool = new Pool({ connectionString: url, max: 4 });
            await ensureRuntimeSchema(pool);
            store = new PgHubStore(pool);
        });
        afterAll(async () => {
            await pool.query(
                'DELETE FROM runtime.runtime_cell_reservations WHERE org_id=ANY($1::text[])',
                [orgs],
            );
            await pool.query(
                'DELETE FROM runtime.runtime_claims WHERE org_id=ANY($1::text[])',
                [orgs],
            );
            await pool.query(
                'DELETE FROM runtime.runtime_cell_sessions WHERE cell_id=ANY($1::text[])',
                [cells],
            );
            await pool.end();
        });
        const request = (
            kind: 'run' | 'setup' = 'run',
        ): PhysicalAdmissionRequest => {
            const organizationId = `physical-it-${randomUUID()}`;
            orgs.push(organizationId);
            const key = randomUUID();
            return {
                organizationId,
                kind,
                key,
                generation: 1,
                ticketOwnerToken: randomUUID(),
                executionId: randomUUID(),
                deadlineAt: new Date(Date.now() + 120_000).toISOString(),
                members:
                    kind === 'run'
                        ? ['base', 'pr'].map((side) => ({
                              side: side as 'base' | 'pr',
                              idempotencyKey: `${key}:${side}:1`,
                          }))
                        : [{ side: 'setup', idempotencyKey: `setup:${key}` }],
            };
        };
        const cell = async (
            orgId: string,
            slots = 8,
            owner: 'customer' | 'kodus' = 'customer',
        ) => {
            const cellId = `physical-it-${randomUUID()}`;
            cells.push(cellId);
            await store.upsertSession({
                cellId,
                replicaId: 'physical-it',
                replicaUrl: 'http://hub',
                owner,
                orgId: owner === 'customer' ? orgId : null,
                driver: 'fake',
                sessionEpoch: randomUUID(),
            });
            await store.heartbeat(cellId, 'physical-it', slots);
            return cellId;
        };
        const directory = (cap = 8) =>
            new PgPhysicalAdmissionDirectory(pool, {
                inTransaction: pgTransaction(pool),
                sharedClaimCap: cap,
            });
        const ref = (
            r: PhysicalAdmissionRequest,
            c: string,
            epoch: string,
        ): PhysicalAdmissionTicket => ({
            ...r,
            ticketId: randomUUID(),
            cellId: c,
            sessionEpoch: epoch,
            expiresAt: r.deadlineAt,
            members: r.members.map((m) => ({
                ...m,
                claimId: claimIdFor(r.organizationId, m.idempotencyKey),
            })),
        });

        it('rotates across more than two eligible cells as durable generations advance', async () => {
        const req = request(); const available = await Promise.all(Array.from({ length: 4 }, () => cell(req.organizationId, 16)));
        const d = directory(); const selected: string[] = [];
        for (let generation = 1; generation <= 4; generation++) {
            const attempt = { ...req, generation, ticketOwnerToken: randomUUID() };
            // Exclude shared fixtures from other tests: production rotates the entire eligible set.
            const other = (await pool.query("SELECT cell_id FROM runtime.runtime_cell_sessions WHERE owner='kodus' AND disconnected_at IS NULL")).rows.map((r) => r.cell_id);
            const found = await d.reserve(attempt, other); expect(found.status).toBe('located');
            const selectedCell = (found as any).cell; selected.push(selectedCell.cellId);
            await d.release(ref(attempt, selectedCell.cellId, selectedCell.sessionEpoch));
        }
        expect([...new Set(selected)].sort()).toEqual(available.sort());
    });

    it('fences heartbeat and disconnect by the persisted session epoch', async () => {
            const req = request();
            const id = await cell(req.organizationId, 2);
            const old = (await store.session(id))!;
            const epoch = randomUUID();
            await store.upsertSession({
                ...old,
                sessionEpoch: epoch,
                isolation: 'vm',
            });
            await store.heartbeat(id, 'physical-it', 7, old.sessionEpoch);
            await store.disconnect(id, 'physical-it', old.sessionEpoch);
            expect(await store.session(id)).toMatchObject({
                sessionEpoch: epoch,
                isolation: 'vm',
            });
            const raw = (
                await pool.query(
                    'SELECT free_slots FROM runtime.runtime_cell_sessions WHERE cell_id=$1',
                    [id],
                )
            ).rows[0];
            expect(raw.free_slots).not.toBe(7);
            await store.heartbeat(id, 'physical-it', 3, epoch);
            expect(
                (
                    await pool.query(
                        'SELECT free_slots FROM runtime.runtime_cell_sessions WHERE cell_id=$1',
                        [id],
                    )
                ).rows[0].free_slots,
            ).toBe(3);
        });

        it('takes both slots atomically, reuses the owner debit, and refuses another generation owner', async () => {
            const req = request();
            const id = await cell(req.organizationId, 3);
            const d = directory();
            const found = await d.reserve(req);
            expect(found).toMatchObject({
                status: 'located',
                cell: { cellId: id },
            });
            expect(
                (
                    await pool.query(
                        'SELECT free_slots FROM runtime.runtime_cell_sessions WHERE cell_id=$1',
                        [id],
                    )
                ).rows[0].free_slots,
            ).toBe(1);
            expect(await d.reserve(req)).toEqual(found);
            expect(
                await d.reserve({ ...req, ticketOwnerToken: randomUUID() }),
            ).toMatchObject({ status: 'refused', reason: 'owner_changed' });
            expect(await d.matches(id, req)).toBe(true);
            const ticket = ref(req, id, (found as any).cell.sessionEpoch);
            expect(
                await d.pin(
                    ticket,
                    new Date(Date.now() + 600_000).toISOString(),
                ),
            ).toBe(true);
            await d.release({ ...ticket, ticketOwnerToken: randomUUID() });
            expect(await d.matches(id, req)).toBe(true);
            await d.release(ticket);
            expect(await d.matches(id, req)).toBe(false);
            expect(
                await d.pin(
                    ticket,
                    new Date(Date.now() + 600_000).toISOString(),
                ),
            ).toBe(false);
        });
        it('serializes paired and legacy organization cap reservations', async () => {
            const req = request();
            await cell(req.organizationId, 8, 'kodus');
            const d = directory(2);
            const legacy = new PgCellDirectory(pool, {
                inTransaction: pgTransaction(pool),
                sharedClaimCap: 2,
            });
            const results = await Promise.all([
                d.reserve(req),
                legacy.reserveCell(req.organizationId, {
                    claimId: `legacy-${randomUUID()}`,
                }),
            ]);
            const rows = await pool.query(
                'SELECT count(*) AS n FROM runtime.runtime_cell_reservations WHERE org_id=$1',
                [req.organizationId],
            );
            expect(Number(rows.rows[0].n)).toBeLessThanOrEqual(2);
            expect(
                results.some(
                    (r) =>
                        r &&
                        ('status' in r
                            ? r.status === 'refused'
                            : 'refused' in r),
                ),
            ).toBe(true);
        });
        it('keeps a setup idle org debit after release and transfers only the owned live reservation', async () => {
            const req = request('setup');
            const id = await cell(req.organizationId, 4, 'kodus');
            const d = directory(1);
            const found = await d.reserve(req);
            expect(found.status).toBe('located');
            const actualCell = (found as any).cell.cellId;
            const ticket = ref(req, actualCell, (found as any).cell.sessionEpoch);
            const claimId = ticket.members[0].claimId;
            await store.insertClaim({
                claimId,
                cellId: actualCell,
                orgId: req.organizationId,
                environmentId: 'env',
                side: 'setup',
                state: 'pending',
                leaseExpiresAt: req.deadlineAt,
                hardExpiresAt: req.deadlineAt,
            });
            await store.transitionClaim(claimId, ['pending'], 'released', {
                reason: 'released',
            });
            const legacy = new PgCellDirectory(pool, {
                inTransaction: pgTransaction(pool),
                sharedClaimCap: 1,
            });
            expect(
                await legacy.reserveCell(req.organizationId, {
                    claimId: `other-${randomUUID()}`,
                }),
            ).toMatchObject({ refused: 'org_capacity', open: 1 });
            expect(
                await d.retarget(
                    { ...ticket, ticketOwnerToken: randomUUID() },
                    `setup:${req.key}:learn-1`,
                    req.deadlineAt,
                ),
            ).toBe(false);
            expect(
                await d.retarget(
                    ticket,
                    `setup:${req.key}:learn-1`,
                    req.deadlineAt,
                ),
            ).toBe(true);
            const rows = await pool.query(
                'SELECT claim_id,owner_token FROM runtime.runtime_cell_reservations WHERE org_id=$1',
                [req.organizationId],
            );
            expect(rows.rows).toEqual([
                {
                    claim_id: claimIdFor(
                        req.organizationId,
                        `setup:${req.key}:learn-1`,
                    ),
                    owner_token: req.ticketOwnerToken,
                },
            ]);
        });
    },
);
