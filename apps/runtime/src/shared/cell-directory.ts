import { randomUUID } from 'crypto';

import type { Pool, PoolClient } from 'pg';

import type { MachineSize } from '@libs/runtime/contracts/machine-size';

// Where the worker finds cells (§1b "Do worker ao hub"): which replica holds a
// cell, and which cell a claim lives on. Read from the hub's tables in the
// Runtime database; the only write is the slot reservation, which the next
// heartbeat overwrites with what the cell reports.
//
// Scheduling on shared cells (the kodus-owned ones every org may use): an org
// holds at most `sharedClaimCap` live claims on them at once (its own cells
// are not capped), its claims spread over the cells where it holds fewer, the
// environment's pool cell still goes first while it has a slot, and when no
// eligible cell has a free slot the answer is "no capacity", never a full cell.
//
// The cap is exact: the hub records a claim only once the worker's acquire
// reaches it, after the slot was reserved, so counting claims alone let a
// burst of acquires all read "under the cap" and all reserve. A capped
// reservation therefore runs in one transaction under the org's advisory lock
// and records itself (runtime_cell_reservations, keyed by the claim) until the
// hub's claim row replaces it or RESERVATION_TTL_SECONDS ends it.
//
// A claim that asks a machine size goes only to a cell whose hello granted
// it (max_claim_*, which the hub sets only for a cell that decodes size):
// when cells are connected but none grants it, the answer is "size
// unavailable", never a cell that would refuse it or run it smaller.

export interface CellLocation {
    cellId: string;
    replicaUrl: string;
    owner: 'kodus' | 'customer';
    orgId?: string | null;
}

/** Why no slot was reserved although a cell is connected for the org. */
export type CellRefusal =
    /** The org already holds `cap` live claims on shared cells, and none of its own cells has a free slot. */
    | { refused: 'org_capacity'; cap: number; open: number }
    /** Every eligible cell is connected and full. */
    | { refused: 'no_capacity' }
    /** Cells are connected for the org, but none grants the size asked; `largest` is the most one of them grants (null: none grants any). */
    | { refused: 'size_unavailable'; size: MachineSize; largest: MachineSize | null };

/** What the claim being placed asks of its cell. */
export interface CellWant {
    /** The cell that holds the environment's warm pool: first when it is eligible and has a slot. */
    prefer?: string;
    /** The claim being acquired: never counts against its own org (a new round of the same claim). */
    claimId?: string;
    /** The machine size the claim will ask: only a cell that grants it is eligible. */
    size?: MachineSize;
}

export const isCellRefusal = (r: CellLocation | CellRefusal | null): r is CellRefusal => !!r && 'refused' in r;

export interface CellDirectory {
    /**
     * A connected cell that may serve the org and grants what the claim
     * asks, one slot taken (CellWant). null: no cell is connected for the
     * org. A refusal: cells are connected but none may take the claim now.
     */
    reserveCell(orgId: string, want?: CellWant): Promise<CellLocation | CellRefusal | null>;
    /** The replica that holds the cell of this claim, or null when no replica holds it. */
    replicaForClaim(claimId: string): Promise<string | null>;
    /** The replica that holds this cell, or null when no replica holds it. */
    replicaForCell?(cellId: string): Promise<string | null>;
}

/** Live claims (hub-store.ts LIVE_CLAIM_STATES, which shared/ may not import): the ones that hold, or are about to hold, machines. */
export const SCHEDULED_CLAIM_STATES = ['pending', 'bound', 'held'] as const;

/** Default cap of an org's live claims on shared cells (RUNTIME_ORG_SHARED_CLAIM_CAP). */
export const DEFAULT_ORG_SHARED_CLAIM_CAP = 8;

const ELIGIBLE = `disconnected_at IS NULL AND last_heartbeat_at > now() - interval '30 seconds' AND (owner = 'kodus' OR org_id = $1)`;

/** The cell grants the size in the two placeholders (memory MB, CPUs), or none was asked (both null). */
const grants = (memoryMb: string, cpus: string) =>
    `(${memoryMb}::int IS NULL OR (max_claim_memory_mb >= ${memoryMb}::int AND max_claim_cpus >= ${cpus}::int))`;

/**
 * How long a reservation counts for its org before the hub records the
 * claim. The worker posts the acquire right after reserving and the hub
 * records the claim first thing, so this only covers a worker that died in
 * between or an acquire the hub refused before recording it.
 */
export const RESERVATION_TTL_SECONDS = 120;

// The org's live claims but the one being acquired ($3, or null), on runtime_claims_org_live_idx,
// plus its reservations the hub has not recorded a claim for yet (once it has, the claim's state counts).
const MINE = `SELECT cell_id FROM runtime.runtime_claims
   WHERE org_id = $1 AND released_at IS NULL AND state = ANY($2::text[]) AND hard_expires_at > now() AND claim_id IS DISTINCT FROM $3::text
  UNION ALL
  SELECT r.cell_id FROM runtime.runtime_cell_reservations r
   WHERE r.org_id = $1 AND r.expires_at > now() AND r.claim_id IS DISTINCT FROM $3::text
     AND NOT EXISTS (SELECT 1 FROM runtime.runtime_claims c WHERE c.claim_id = r.claim_id
       AND (r.owner_token IS NULL OR (c.released_at IS NULL AND c.state = ANY($2::text[]) AND c.hard_expires_at > now())))`;
const SHARED_OPEN = `(SELECT count(*) FROM mine m JOIN runtime.runtime_cell_sessions k ON k.cell_id = m.cell_id AND k.owner = 'kodus')`;

// $4: the preferred cell (or null, which ranks every cell the same); only ever among the eligible ones.
// Then the org's own cells, then the cells where the org holds fewer live claims (spread), then the most free slots.
const ORDER = `COALESCE(s.cell_id = $4, false) DESC, (s.org_id = $1) DESC NULLS LAST,
       (SELECT count(*) FROM mine m WHERE m.cell_id = s.cell_id) ASC, s.free_slots DESC, s.last_heartbeat_at DESC`;

/**
 * One slot taken from the best eligible cell with a free slot. $5: the cap of
 * the org's live claims on shared cells (null: no cap); a shared cell is a
 * candidate only while the org is under it. $6, $7: the size asked (memory
 * MB, CPUs; null: none). No row: nothing was reserved.
 */
export const RESERVE_CELL_SQL = `WITH mine AS (${MINE})
UPDATE runtime.runtime_cell_sessions SET free_slots = free_slots - 1
  WHERE cell_id = (
    SELECT s.cell_id FROM runtime.runtime_cell_sessions s
     WHERE ${ELIGIBLE} AND ${grants('$6', '$7')} AND s.free_slots > 0 AND (s.owner <> 'kodus' OR $5::int IS NULL OR ${SHARED_OPEN} < $5::int)
     ORDER BY ${ORDER}
     LIMIT 1 FOR UPDATE OF s SKIP LOCKED)
  RETURNING *`;

/**
 * Why RESERVE_CELL_SQL reserved nothing: eligible cells, those that grant the
 * size ($4, $5), those of them with a free slot (all, the org's own), and the
 * org's live claims on shared cells.
 */
export const CELL_CAPACITY_SQL = `WITH mine AS (${MINE})
SELECT count(*) FILTER (WHERE ${ELIGIBLE})::int AS eligible,
       count(*) FILTER (WHERE ${ELIGIBLE} AND ${grants('$4', '$5')})::int AS granting,
       count(*) FILTER (WHERE ${ELIGIBLE} AND ${grants('$4', '$5')} AND free_slots > 0)::int AS free,
       count(*) FILTER (WHERE ${ELIGIBLE} AND ${grants('$4', '$5')} AND free_slots > 0 AND owner <> 'kodus')::int AS free_own,
       ${SHARED_OPEN}::int AS shared_open
  FROM runtime.runtime_cell_sessions`;

/** The most an eligible cell grants one claim (most memory, then most CPUs), for a size_unavailable refusal. */
export const LARGEST_GRANT_SQL = `SELECT max_claim_memory_mb, max_claim_cpus FROM runtime.runtime_cell_sessions
  WHERE ${ELIGIBLE} AND max_claim_memory_mb IS NOT NULL AND max_claim_cpus IS NOT NULL
  ORDER BY max_claim_memory_mb DESC, max_claim_cpus DESC LIMIT 1`;

/** The best eligible cell, full or not, reserving nothing: the hub store's fallback (reserveCellRow). */
export const BEST_CELL_SQL = `SELECT * FROM runtime.runtime_cell_sessions WHERE ${ELIGIBLE}
  ORDER BY COALESCE(cell_id = $2, false) DESC, (org_id = $1) DESC NULLS LAST, free_slots DESC, last_heartbeat_at DESC LIMIT 1`;

/** Serializes the org's capped reservations: held until the transaction ends. The prefix keeps the key apart from other hashtext locks. */
const ORG_RESERVATION_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('runtime.cell_reservation:' || $1))`;
const PRUNE_RESERVATIONS_SQL = `DELETE FROM runtime.runtime_cell_reservations WHERE org_id = $1 AND expires_at <= now()`;
/** A new round of the same claim moves its reservation to the cell it reserved now. */
const RECORD_RESERVATION_SQL = `INSERT INTO runtime.runtime_cell_reservations (claim_id, org_id, cell_id, expires_at)
  VALUES ($1, $2, $3, now() + make_interval(secs => $4))
  ON CONFLICT (claim_id) DO UPDATE SET org_id = EXCLUDED.org_id, cell_id = EXCLUDED.cell_id, expires_at = EXCLUDED.expires_at`;

type Queryable = Pick<Pool, 'query'>;

/** Runs `fn` in one database transaction, committed when it resolves. */
export type InTransaction = <T>(fn: (db: Queryable) => Promise<T>) => Promise<T>;

/** InTransaction on a connection of the pool, held for the transaction. */
export function pgTransaction(pool: Pick<Pool, 'connect'>): InTransaction {
    return async (fn) => {
        const client: PoolClient = await pool.connect();
        try {
            await client.query('BEGIN');
            const out = await fn(client);
            await client.query('COMMIT');
            return out;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
        } finally {
            client.release();
        }
    };
}

export type CellReservation = { row: any } | CellRefusal | { refused: 'no_cell' };

/** Reservation rounds when a free slot was held locked by a concurrent reservation. */
const RESERVE_ATTEMPTS = 3;

/**
 * A slot on the cell the org's claim should go to, or why there is none. A
 * free slot another reservation held locked at that moment is tried again
 * (bounded), so a burst of acquires never reads as "no capacity" by itself.
 * A size no eligible cell grants is refused before the cap: waiting would
 * not change it.
 */
export async function reserveCellFor(
    pool: Pick<Pool, 'query'>,
    orgId: string,
    opts: CellWant & { sharedClaimCap?: number | null } = {},
): Promise<CellReservation> {
    const mine = [orgId, [...SCHEDULED_CLAIM_STATES], opts.claimId ?? null];
    const size = [opts.size?.memoryMb ?? null, opts.size?.cpus ?? null];
    const cap = opts.sharedClaimCap ?? null;
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
        const reserved = await pool.query(RESERVE_CELL_SQL, [...mine, opts.prefer ?? null, cap, ...size]);
        if (reserved.rows[0]) return { row: reserved.rows[0] };
        const c = (await pool.query(CELL_CAPACITY_SQL, [...mine, ...size])).rows[0] ?? { eligible: 0, granting: 0, free: 0, free_own: 0, shared_open: 0 };
        if (!c.eligible) return { refused: 'no_cell' };
        if (opts.size && !c.granting) return { refused: 'size_unavailable', size: opts.size, largest: await largestGrant(pool, orgId) };
        if (cap !== null && c.shared_open >= cap && !c.free_own) return { refused: 'org_capacity', cap, open: c.shared_open };
        if (!c.free) return { refused: 'no_capacity' };
    }
    return { refused: 'no_capacity' };
}

async function largestGrant(pool: Pick<Pool, 'query'>, orgId: string): Promise<MachineSize | null> {
    const r = (await pool.query(LARGEST_GRANT_SQL, [orgId])).rows[0];
    return r ? { memoryMb: r.max_claim_memory_mb, cpus: r.max_claim_cpus } : null;
}

/**
 * The hub store's reservation (CellSessionRepository.reserveCell), uncapped:
 * a slot on the best eligible cell, else the best eligible cell with none
 * (the cell then refuses). The worker reserves through PgCellDirectory.
 */
export async function reserveCellRow(pool: Pick<Pool, 'query'>, orgId: string, prefer?: string): Promise<any | null> {
    const r = await reserveCellFor(pool, orgId, { prefer, sharedClaimCap: null });
    if ('row' in r) return r.row;
    if (r.refused === 'no_cell') return null;
    // No size was asked, so no refusal is size_unavailable: the fallback is the best cell, full.
    return (await pool.query(BEST_CELL_SQL, [orgId, prefer ?? null])).rows[0] ?? null;
}

/**
 * A capped reservation that counts until the hub records its claim: under
 * the org's lock, so the next reservation of the org sees this one. A
 * reservation with no claim id (none today) still counts, under an id of
 * its own, for its TTL.
 */
export function reserveCellCapped(
    inTransaction: InTransaction,
    orgId: string,
    opts: CellWant & { sharedClaimCap: number },
): Promise<CellReservation> {
    return inTransaction(async (db) => {
        await db.query(ORG_RESERVATION_LOCK_SQL, [orgId]);
        await db.query(PRUNE_RESERVATIONS_SQL, [orgId]);
        const r = await reserveCellFor(db, orgId, opts);
        if ('row' in r) await db.query(RECORD_RESERVATION_SQL, [opts.claimId ?? `reservation-${randomUUID()}`, orgId, r.row.cell_id, RESERVATION_TTL_SECONDS]);
        return r;
    });
}

export interface PgCellDirectoryOptions {
    sharedClaimCap?: number;
    /** The transaction a capped reservation runs in (pgTransaction on the worker's pool). */
    inTransaction: InTransaction;
}

export class PgCellDirectory implements CellDirectory {
    constructor(
        private readonly pool: Queryable,
        private readonly opts: PgCellDirectoryOptions,
    ) {}

    async reserveCell(orgId: string, want: CellWant = {}): Promise<CellLocation | CellRefusal | null> {
        const r = await reserveCellCapped(this.opts.inTransaction, orgId, { ...want, sharedClaimCap: this.opts.sharedClaimCap ?? DEFAULT_ORG_SHARED_CLAIM_CAP });
        if ('row' in r) return { cellId: r.row.cell_id, replicaUrl: r.row.replica_url, owner: r.row.owner, orgId: r.row.org_id };
        return r.refused === 'no_cell' ? null : r;
    }

    async replicaForClaim(claimId: string): Promise<string | null> {
        const r = await this.pool.query(
            `SELECT s.replica_url FROM runtime.runtime_claims c
               JOIN runtime.runtime_cell_sessions s ON s.cell_id = c.cell_id AND s.disconnected_at IS NULL
              WHERE c.claim_id = $1`,
            [claimId],
        );
        return (r.rows[0]?.replica_url as string | undefined) ?? null;
    }

    async replicaForCell(cellId: string): Promise<string | null> {
        const r = await this.pool.query(`SELECT replica_url FROM runtime.runtime_cell_sessions WHERE cell_id = $1 AND disconnected_at IS NULL`, [cellId]);
        return (r.rows[0]?.replica_url as string | undefined) ?? null;
    }
}
