import { randomUUID } from 'crypto';

import { lockKey, lockStatement, withTransaction } from '@libs/runtime/run/adapters/advisory-lock';
import type { Pool } from 'pg';

import { LIVE_CLAIM_STATES } from '@libs/runtime/contracts/enums';
import type { MachineSize } from '@libs/runtime/contracts/machine-size';
import { type IsolationMinimum, isolationsSatisfying } from '@libs/runtime/contracts/isolation';
import { candidatePools, templateSetupKey, type Placement } from '@libs/runtime/placement/candidate-pools';

import type { HostPoolReader } from './host-pools';

// Where the worker finds cells: which replica holds a
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
//
// A claim that asks an isolation minimum (kernel, vm) goes only to a cell
// whose hello isolation satisfies it (contracts/isolation.ts): when cells
// are connected but none does, the answer is "isolation unavailable", never a
// cell of a lower isolation.
//
// Pools (docs/runtime/host-providers.md §4.4, §6): a cordoned cell takes no
// new claim; a cell bound to a Run (a perRun host) takes only that Run's
// claims; with a placement, only cells of its pools are eligible, best pool
// first, and a Run whose first pool is perRun waits for its own host: the
// reservation records demand (runtime_pool_demand) and runtime-fleet makes the
// host. With no placement (only static pools), eligibility is what it was.

export interface CellLocation {
    cellId: string;
    replicaUrl: string;
    owner: 'kodus' | 'customer';
    orgId?: string | null;
}

/** Why no slot was reserved although a cell is connected for the org. */
export type CellRefusal =
    /**
     * The org already holds `cap` live claims on shared cells, and none of its own cells has a free slot.
     * `nextFreeAt`: the earliest hard expiry of those claims, the latest one of them is given back.
     */
    | { refused: 'org_capacity'; cap: number; open: number; nextFreeAt?: string }
    /**
     * Every eligible cell is connected and full. `hosts`: the cells that would take the claim but for a
     * slot; `nextFreeAt`: the earliest hard expiry of a live claim on them, the latest a slot frees.
     */
    | { refused: 'no_capacity'; hosts?: number; nextFreeAt?: string; pool?: string; hostStarting?: true }
    /** The Run's perRun host could not be made (the fleet marked its demand failed): `reason` from a closed set. */
    | { refused: 'host_unavailable'; pool: string; reason: string }
    /** Cells are connected for the org, but none grants the size asked; `largest` is the most one of them grants (null: none grants any). */
    | { refused: 'size_unavailable'; size: MachineSize; largest: MachineSize | null }
    /** Cells are connected for the org, but none runs claims under the isolation asked or above. */
    | { refused: 'isolation_unavailable'; isolation: IsolationMinimum }
    /** The claim's other side runs on a backend (driver, isolation) no connected cell of the org runs any more. */
    | { refused: 'backend_unavailable'; driver: string; isolation: string | null; pool?: string };

/** What the claim being placed asks of its cell. */
export interface CellWant {
    /** The cell that holds the environment's warm pool: first when it is eligible and has a slot. */
    prefer?: string;
    /** The claim being acquired: never counts against its own org (a new round of the same claim). */
    claimId?: string;
    /** The machine size the claim will ask: only a cell that grants it is eligible. */
    size?: MachineSize;
    /** The least isolation the claim runs under: only a cell that satisfies it is eligible. Absent: any. */
    isolation?: IsolationMinimum;
    /**
     * The claims of the same Run's other side: when one of them is live or reserved, only a cell of
     * its backend (driver and isolation) is eligible, so both sides boot on one kernel and build path.
     */
    sameBackendAs?: string[];
    /** Who places the claim ('runtime' for a Run's side), its Run and environment: what placement and demand need. */
    consumer?: string;
    runId?: string;
    /** A suite shard's claim (consumer 'suite'): the suite run and the shard, which name the host bound to it. */
    suiteRunId?: string;
    shard?: number;
    environmentId?: string;
    /** The pools the claim may use, in order (libs/runtime/placement); absent: computed by the directory, or none. */
    placement?: Placement;
    /**
     * A template's setup (`template:<org>/<env>`, consumer 'setup'): only the cell bound to this key is eligible,
     * in whatever pool, and no other claim reaches that cell. A key that is not this org's template key is ignored.
     */
    boundKey?: string;
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


/** Default cap of an org's live claims on shared cells (RUNTIME_ORG_SHARED_CLAIM_CAP). */
export const DEFAULT_ORG_SHARED_CLAIM_CAP = 8;

/**
 * A connected cell that may serve the org ($1), not cordoned, bound to the key (the key placeholder) or, unless the
 * key is a template's, to nothing, in one of the pools (the pools placeholder, text[]; null: any pool). A cell bound
 * to a template key therefore takes only that template's setup: no unbound claim and no Run's key matches it.
 */
const eligible = (pools: string, key: string) =>
    `disconnected_at IS NULL AND last_heartbeat_at > now() - interval '30 seconds' AND (owner = 'kodus' OR org_id = $1) AND cordoned_at IS NULL
     AND (bound_key = ${key}::text OR (bound_key IS NULL AND COALESCE(${key}::text NOT LIKE 'template:%', true))) AND (${pools}::text[] IS NULL OR pool_id = ANY(${pools}::text[]))`;

/** The cell runs claims under one of the isolations in the placeholder (text[]), or none was asked (null). */
const isolated = (isolations: string) => `(${isolations}::text[] IS NULL OR isolation = ANY(${isolations}::text[]))`;

/** The cell runs the backend in the two placeholders (driver, isolation), or none was asked (driver null). */
const sameBackend = (driver: string, isolation: string) => `(${driver}::text IS NULL OR (driver = ${driver}::text AND isolation IS NOT DISTINCT FROM ${isolation}::text))`;

/**
 * The backend (driver, isolation) of the cell one of these claims ($1, of org $2) ran or runs on, or
 * holds a reservation on. A released claim still counts: the Run's sides compare across its lifetime.
 */
const SIBLING_BACKEND_SQL = `SELECT s.driver, s.isolation, s.pool_id FROM runtime.runtime_cell_sessions s
  WHERE s.cell_id IN (
    SELECT cell_id FROM runtime.runtime_claims WHERE claim_id = ANY($1::text[]) AND org_id = $2
    UNION SELECT cell_id FROM runtime.runtime_cell_reservations WHERE claim_id = ANY($1::text[]) AND org_id = $2 AND expires_at > now())
  LIMIT 1`;

/** Connected cells of the backend ($2, $3) that may serve the org ($1). */
const BACKEND_CELLS_SQL = `SELECT count(*)::int AS n FROM runtime.runtime_cell_sessions WHERE ${eligible('$4', '$5')} AND driver = $2 AND isolation IS NOT DISTINCT FROM $3`;

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

// $11: the pools in placement order (null: none ranks first); $4: the preferred cell (or null, which ranks every cell the same); only ever among the eligible ones.
// Then the org's own cells, then the cells where the org holds fewer live claims (spread), then the most free slots.
const ORDER = `array_position($11::text[], s.pool_id) ASC NULLS LAST, COALESCE(s.cell_id = $4, false) DESC, (s.org_id = $1) DESC NULLS LAST,
       (SELECT count(*) FROM mine m WHERE m.cell_id = s.cell_id) ASC, s.free_slots DESC, s.last_heartbeat_at DESC`;

/**
 * One slot taken from the best eligible cell with a free slot. $5: the cap of
 * the org's live claims on shared cells (null: no cap); a shared cell is a
 * candidate only while the org is under it. $6, $7: the size asked (memory
 * MB, CPUs; null: none). $8: the isolations that satisfy the claim's minimum
 * (null: any). $9, $10: the other side's backend. $11, $12: the pools and the
 * bound key (eligible). No row: nothing was reserved.
 */
export const RESERVE_CELL_SQL = `WITH mine AS (${MINE})
UPDATE runtime.runtime_cell_sessions SET free_slots = free_slots - 1
  WHERE cell_id = (
    SELECT s.cell_id FROM runtime.runtime_cell_sessions s
     WHERE ${eligible('$11', '$12')} AND ${isolated('$8')} AND ${grants('$6', '$7')} AND ${sameBackend('$9', '$10')} AND s.free_slots > 0 AND (s.owner <> 'kodus' OR $5::int IS NULL OR ${SHARED_OPEN} < $5::int)
     ORDER BY ${ORDER}
     LIMIT 1 FOR UPDATE OF s SKIP LOCKED)
  RETURNING *`;

/**
 * Why RESERVE_CELL_SQL reserved nothing: eligible cells, those that satisfy
 * the isolation ($6), those of them that grant the size ($4, $5), those with a
 * free slot (all, the org's own), and the org's live claims on shared cells.
 */
export const CELL_CAPACITY_SQL = `WITH mine AS (${MINE})
SELECT count(*) FILTER (WHERE ${eligible('$7', '$8')})::int AS eligible,
       count(*) FILTER (WHERE ${eligible('$7', '$8')} AND ${isolated('$6')})::int AS isolating,
       count(*) FILTER (WHERE ${eligible('$7', '$8')} AND ${isolated('$6')} AND ${grants('$4', '$5')})::int AS granting,
       count(*) FILTER (WHERE ${eligible('$7', '$8')} AND ${isolated('$6')} AND ${grants('$4', '$5')} AND free_slots > 0)::int AS free,
       count(*) FILTER (WHERE ${eligible('$7', '$8')} AND ${isolated('$6')} AND ${grants('$4', '$5')} AND free_slots > 0 AND owner <> 'kodus')::int AS free_own,
       ${SHARED_OPEN}::int AS shared_open
  FROM runtime.runtime_cell_sessions`;

/**
 * When the first live claim on the cells that would take this one but for a
 * slot is given back at the latest: the earliest hard expiry (a claim's
 * machines are destroyed then, whatever its renewals). $1 org, $2 live
 * states, $3 isolations, $4 and $5 the size. Another org's claims count, as
 * one timestamp only.
 */
export const NEXT_FREE_SQL = `SELECT min(c.hard_expires_at) AS at FROM runtime.runtime_claims c
  WHERE c.released_at IS NULL AND c.state = ANY($2::text[]) AND c.hard_expires_at > now()
    AND c.cell_id IN (SELECT cell_id FROM runtime.runtime_cell_sessions WHERE ${eligible('$6', '$7')} AND ${isolated('$3')} AND ${grants('$4', '$5')})`;

/** When the org's first live claim on shared cells (but the one being acquired, $3) is given back at the latest. */
export const ORG_NEXT_FREE_SQL = `SELECT min(c.hard_expires_at) AS at FROM runtime.runtime_claims c
  JOIN runtime.runtime_cell_sessions k ON k.cell_id = c.cell_id AND k.owner = 'kodus'
  WHERE c.org_id = $1 AND c.released_at IS NULL AND c.state = ANY($2::text[]) AND c.hard_expires_at > now() AND c.claim_id IS DISTINCT FROM $3::text`;

const isoOf = (at: unknown): string | undefined => (at instanceof Date ? at.toISOString() : typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : undefined);

/** The most an eligible cell of the isolation ($2) grants one claim (most memory, then most CPUs), for a size_unavailable refusal. */
export const LARGEST_GRANT_SQL = `SELECT max_claim_memory_mb, max_claim_cpus FROM runtime.runtime_cell_sessions
  WHERE ${eligible('$3', '$4')} AND ${isolated('$2')} AND max_claim_memory_mb IS NOT NULL AND max_claim_cpus IS NOT NULL
  ORDER BY max_claim_memory_mb DESC, max_claim_cpus DESC LIMIT 1`;

/** The best eligible cell, full or not, reserving nothing: the hub store's fallback (reserveCellRow). */
export const BEST_CELL_SQL = `SELECT * FROM runtime.runtime_cell_sessions WHERE ${eligible('NULL', 'NULL')}
  ORDER BY COALESCE(cell_id = $2, false) DESC, (org_id = $1) DESC NULLS LAST, free_slots DESC, last_heartbeat_at DESC LIMIT 1`;

/** How long a Run's demand for a perRun host lives unless the Run asks again (the fleet reads expired demand as gone). */
export const POOL_DEMAND_TTL_SECONDS = 120;

/** The Run's demand on a perRun pool, made or refreshed; its failure when the fleet could not make the host. */
const RECORD_DEMAND_SQL = `INSERT INTO runtime.runtime_pool_demand AS d (pool_id, bound_key, organization_id, environment_id, run_id, size_mb, expires_at)
  VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
  ON CONFLICT (pool_id, bound_key) DO UPDATE SET expires_at = GREATEST(d.expires_at, EXCLUDED.expires_at),
    size_mb = GREATEST(d.size_mb, EXCLUDED.size_mb), environment_id = COALESCE(d.environment_id, EXCLUDED.environment_id)
  WHERE d.organization_id = EXCLUDED.organization_id
  RETURNING failed_at, failure`;

/** Records the Run's demand on a perRun pool; the failure the fleet recorded on it, if any. */
export async function recordPoolDemand(
    db: Pick<Pool, 'query'>,
    d: { poolId: string; boundKey: string; organizationId: string; environmentId?: string; runId?: string; sizeMb?: number },
): Promise<{ failure?: string }> {
    const r = await db.query(RECORD_DEMAND_SQL, [d.poolId, d.boundKey, d.organizationId, d.environmentId ?? null, d.runId ?? null, d.sizeMb ?? null, POOL_DEMAND_TTL_SECONDS]);
    const row = r.rows[0];
    return row?.failed_at ? { failure: String(row.failure ?? 'failed') } : {};
}

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
    return (fn) => withTransaction(pool, fn);
}

export type CellReservation = { row: any } | CellRefusal | { refused: 'no_cell' };

/** Reservation rounds when a free slot was held locked by a concurrent reservation. */
const RESERVE_ATTEMPTS = 3;

/**
 * A slot on the cell the org's claim should go to, or why there is none. A
 * free slot another reservation held locked at that moment is tried again
 * (bounded), so a burst of acquires never reads as "no capacity" by itself.
 * An isolation no eligible cell satisfies, then a size no such cell grants,
 * are refused before the cap: waiting would not change either.
 */
export async function reserveCellFor(
    pool: Pick<Pool, 'query'>,
    orgId: string,
    opts: CellWant & { sharedClaimCap?: number | null } = {},
): Promise<CellReservation> {
    const mine = [orgId, [...LIVE_CLAIM_STATES], opts.claimId ?? null];
    const size = [opts.size?.memoryMb ?? null, opts.size?.cpus ?? null];
    // 'any' (or none asked) filters nothing; a minimum names the isolations that satisfy it.
    const isolations = opts.isolation && opts.isolation !== 'any' ? [...isolationsSatisfying(opts.isolation)] : null;
    const cap = opts.sharedClaimCap ?? null;
    // The Run's other side, once placed (or reserved), fixes the backend this side may run on.
    const sibling = opts.sameBackendAs?.length ? (await pool.query(SIBLING_BACKEND_SQL, [opts.sameBackendAs, orgId])).rows[0] : undefined;
    const backend = [sibling?.driver ?? null, sibling?.isolation ?? null];
    // A template's setup: its bound cell in any pool, no pool's demand (the fleet made the host already).
    const templateKey = opts.consumer === 'setup' ? templateSetupKey(orgId, opts.boundKey) : null;
    const placement = templateKey ? undefined : opts.placement;
    // Base and PR never span pools: once a side is placed, its pool is the only candidate.
    let pools: string[] | null = placement ? (sibling?.pool_id ? [sibling.pool_id] : placement.pools) : null;
    let key: string | null = templateKey;
    const first = pools?.[0];
    const perRun = !!first && !!placement?.boundKey && placement.perRun.includes(first);
    if (perRun) {
        // The Run's own host: only its bound cell, and the demand that makes the fleet start one.
        pools = [first!];
        key = placement!.boundKey!;
        const demand = await recordPoolDemand(pool, { poolId: first!, boundKey: key, organizationId: orgId, environmentId: opts.environmentId, runId: opts.suiteRunId ?? opts.runId, sizeMb: opts.size?.memoryMb });
        if (demand.failure) return { refused: 'host_unavailable', pool: first!, reason: demand.failure };
    } else if (pools && placement) {
        pools = pools.filter((p) => !placement.perRun.includes(p));
    }
    const scope = [pools, key];
    const named = pools?.length === 1 ? { pool: pools[0] } : first ? { pool: first } : {};
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
        const reserved = await pool.query(RESERVE_CELL_SQL, [...mine, opts.prefer ?? null, cap, ...size, isolations, ...backend, ...scope]);
        if (reserved.rows[0]) return { row: reserved.rows[0] };
        if (sibling && !(await pool.query(BACKEND_CELLS_SQL, [orgId, sibling.driver, sibling.isolation, ...scope])).rows[0]?.n) {
            return { refused: 'backend_unavailable', driver: sibling.driver, isolation: sibling.isolation ?? null, ...(placement && sibling.pool_id ? { pool: sibling.pool_id } : {}) };
        }
        const c = (await pool.query(CELL_CAPACITY_SQL, [...mine, ...size, isolations, ...scope])).rows[0] ?? { eligible: 0, isolating: 0, granting: 0, free: 0, free_own: 0, shared_open: 0 };
        // No host bound to the Run yet: it is on its way (the demand above), a wait like a full cell.
        if (perRun && !c.eligible) return { refused: 'no_capacity', pool: first!, hostStarting: true };
        // The template's host is not registered yet: the setup waits for it, as the admission path does.
        if (templateKey && !c.eligible) return { refused: 'no_capacity', hostStarting: true };
        if (!c.eligible) return { refused: 'no_cell' };
        if (isolations && !c.isolating) return { refused: 'isolation_unavailable', isolation: opts.isolation! };
        if (opts.size && !c.granting) return { refused: 'size_unavailable', size: opts.size, largest: await largestGrant(pool, orgId, isolations, scope) };
        if (cap !== null && c.shared_open >= cap && !c.free_own) {
            const nextFreeAt = isoOf((await pool.query(ORG_NEXT_FREE_SQL, mine)).rows[0]?.at);
            return { refused: 'org_capacity', cap, open: c.shared_open, ...(nextFreeAt ? { nextFreeAt } : {}) };
        }
        if (!c.free) {
            const nextFreeAt = isoOf((await pool.query(NEXT_FREE_SQL, [orgId, mine[1], isolations, ...size, ...scope])).rows[0]?.at);
            return { refused: 'no_capacity', hosts: c.granting, ...(nextFreeAt ? { nextFreeAt } : {}), ...(placement ? named : {}) };
        }
    }
    return { refused: 'no_capacity' };
}

async function largestGrant(pool: Pick<Pool, 'query'>, orgId: string, isolations: string[] | null, scope: Array<string[] | string | null>): Promise<MachineSize | null> {
    const r = (await pool.query(LARGEST_GRANT_SQL, [orgId, isolations, ...scope])).rows[0];
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
        // Serializes the org's capped reservations, held until the transaction ends (the same key as physical admission).
        const lock = lockStatement('pg_advisory_xact_lock', lockKey('cell_reservation', orgId));
        await db.query(lock.text, lock.values);
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
    /** The pools placement chooses among; absent: no placement (every eligible cell, as before pools). */
    pools?: HostPoolReader;
}

export class PgCellDirectory implements CellDirectory {
    constructor(
        private readonly pool: Queryable,
        private readonly opts: PgCellDirectoryOptions,
    ) {}

    async reserveCell(orgId: string, want: CellWant = {}): Promise<CellLocation | CellRefusal | null> {
        const placement =
            want.placement ??
            (this.opts.pools && want.consumer
                ? (candidatePools(await this.opts.pools.list(), { organizationId: orgId, consumer: want.consumer, runId: want.runId, suiteRunId: want.suiteRunId, shard: want.shard, isolation: want.isolation }) ?? undefined)
                : undefined);
        const r = await reserveCellCapped(this.opts.inTransaction, orgId, { ...want, placement, sharedClaimCap: this.opts.sharedClaimCap ?? DEFAULT_ORG_SHARED_CLAIM_CAP });
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
