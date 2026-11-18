import type { Pool } from 'pg';

import { lockKey, lockStatement } from '@libs/runtime/run/adapters/advisory-lock';

import { LIVE_CLAIM_STATES } from '@libs/runtime/contracts/enums';

import type {
    PhysicalAdmissionRequest,
    PhysicalAdmissionResult,
    PhysicalAdmissionTicket,
} from './admission-contract';
import { claimIdFor } from '../claim-id';
import {
    DEFAULT_ORG_SHARED_CLAIM_CAP,
    type CellLocation,
    type InTransaction,
    recordPoolDemand,
} from '../persistence/cell-directory';
import type { HostPoolReader } from '../persistence/host-pools';
import { candidatePools } from '@libs/runtime/placement/candidate-pools';
import { isolationsSatisfying } from '@libs/runtime/contracts/isolation';

export interface PhysicalAdmissionDirectory {
    reserve(
        request: PhysicalAdmissionRequest,
        excludeCells?: string[],
    ): Promise<
        | { status: 'located'; cell: CellLocation & { sessionEpoch: string } }
        | (Extract<PhysicalAdmissionResult, { status: 'refused' }> & { allCellsTried?: boolean })
    >;
    matches(
        cellId: string,
        request: PhysicalAdmissionRequest,
    ): Promise<boolean>;
    pin(ticket: PhysicalAdmissionTicket, until: string): Promise<boolean>;
    release(ticket: PhysicalAdmissionTicket): Promise<void>;
    retarget(
        ticket: PhysicalAdmissionTicket,
        idempotencyKey: string,
        until: string,
    ): Promise<boolean>;
}

/** PostgreSQL holds slots/org debits; the owning hub's memory book grants RAM. */
export class PgPhysicalAdmissionDirectory implements PhysicalAdmissionDirectory {
    constructor(
        private readonly pool: Pick<Pool, 'query'>,
        private readonly opts: {
            inTransaction: InTransaction;
            sharedClaimCap?: number;
            /** The pools placement chooses among (as PgCellDirectory); absent: no placement. */
            pools?: HostPoolReader;
        },
    ) {}

    async reserve(
        req: PhysicalAdmissionRequest,
        excludeCells: string[] = [],
    ): Promise<Awaited<ReturnType<PhysicalAdmissionDirectory['reserve']>>> {
        const ids = req.members.map((m) =>
            claimIdFor(req.organizationId, m.idempotencyKey),
        );
        // The same placement as the legacy path (docs/runtime/host-providers.md §4.4): a Run's pair on its
        // first pool; on a perRun pool only the Run's bound cell, with the demand that makes the fleet start it.
        const placement = this.opts.pools
            ? candidatePools(await this.opts.pools.list(), {
                  organizationId: req.organizationId,
                  consumer: req.kind === 'run' ? 'runtime' : 'setup',
                  runId: req.kind === 'run' ? req.key : undefined,
                  ...(req.isolation ? { isolation: req.isolation } : {}),
              })
            : null;
        // A claim that asks an isolation minimum goes only to a cell whose hello isolation satisfies it (never lower).
        const isolations = req.isolation && req.isolation !== 'any' ? [...isolationsSatisfying(req.isolation)] : null;
        const first = placement?.pools[0];
        const perRun = !!first && !!placement?.boundKey && placement.perRun.includes(first);
        const pools = placement ? (perRun ? [first!] : placement.pools.filter((p) => !placement.perRun.includes(p))) : null;
        const key = perRun ? placement!.boundKey! : null;
        return this.opts.inTransaction(async (db) => {
            await db.query("SET LOCAL lock_timeout = '5s'");
            await db.query("SET LOCAL statement_timeout = '5s'");
            const lock = lockStatement('pg_advisory_xact_lock', lockKey('cell_reservation', req.organizationId));
            await db.query(lock.text, lock.values);
            await db.query(
                'DELETE FROM runtime.runtime_cell_reservations WHERE org_id=$1 AND expires_at <= now()',
                [req.organizationId],
            );
            const held = await db.query(
                `SELECT r.*, s.replica_url, s.owner, s.org_id AS cell_org_id, s.session_epoch FROM runtime.runtime_cell_reservations r JOIN runtime.runtime_cell_sessions s USING(cell_id)
                WHERE r.claim_id=ANY($1::text[]) AND r.expires_at>now() AND s.disconnected_at IS NULL AND s.last_heartbeat_at>now()-interval '30 seconds' FOR UPDATE OF r`,
                [ids],
            );
            if (held.rows.length) {
                const row = held.rows[0];
                if (
                    held.rows.length !== ids.length ||
                    held.rows.some(
                        (r) =>
                            r.org_id !== req.organizationId ||
                            r.owner_token !== req.ticketOwnerToken ||
                            r.cell_id !== row.cell_id,
                    ) ||
                    excludeCells.includes(row.cell_id)
                )
                    return {
                        status: 'refused',
                        reason: 'owner_changed',
                        retryable: true,
                    };
                return {
                    status: 'located',
                    cell: {
                        cellId: row.cell_id,
                        replicaUrl: row.replica_url,
                        owner: row.owner,
                        orgId: row.cell_org_id,
                        sessionEpoch: row.session_epoch,
                    },
                };
            }
            const open = Number(
                (
                    await db.query(
                        `SELECT count(*) AS n FROM (
                SELECT c.cell_id FROM runtime.runtime_claims c WHERE c.org_id=$1 AND c.state=ANY($3::text[]) AND c.released_at IS NULL AND c.hard_expires_at>now() AND NOT(c.claim_id=ANY($2::text[]))
                UNION ALL SELECT r.cell_id FROM runtime.runtime_cell_reservations r WHERE r.org_id=$1 AND r.expires_at>now() AND NOT(r.claim_id=ANY($2::text[])) AND NOT EXISTS(SELECT 1 FROM runtime.runtime_claims c WHERE c.claim_id=r.claim_id AND (r.owner_token IS NULL OR (c.released_at IS NULL AND c.state=ANY($3::text[]) AND c.hard_expires_at>now())))
                ) m JOIN runtime.runtime_cell_sessions s USING(cell_id) WHERE s.owner='kodus'`,
                        [req.organizationId, ids, [...LIVE_CLAIM_STATES]],
                    )
                ).rows[0]?.n ?? 0,
            );
            const cap =
                this.opts.sharedClaimCap ?? DEFAULT_ORG_SHARED_CLAIM_CAP;
            if (perRun) {
                const demand = await recordPoolDemand(db, { poolId: first!, boundKey: key!, organizationId: req.organizationId, runId: req.key, sizeMb: req.size?.memoryMb });
                if (demand.failure) return { status: 'refused', reason: 'unavailable', retryable: false };
            }
            const candidates = await db.query(
                `WITH eligible AS (
                  SELECT cell_id, row_number() OVER (ORDER BY cell_id)-1 AS ordinal, count(*) OVER () AS total
                  FROM runtime.runtime_cell_sessions WHERE disconnected_at IS NULL AND last_heartbeat_at>now()-interval '30 seconds'
                  AND (owner='kodus' OR org_id=$1) AND session_epoch IS NOT NULL AND NOT(cell_id=ANY($2::text[]))
                  AND cordoned_at IS NULL AND (bound_key IS NULL OR bound_key=$9::text) AND ($10::text[] IS NULL OR pool_id=ANY($10::text[]))
                  AND free_slots >= $3 AND (owner<>'kodus' OR $4::int+$3 <= $5::int)
                  AND ($6::int IS NULL OR (max_claim_memory_mb >= $6 AND max_claim_cpus >= $7))
                  AND ($11::text[] IS NULL OR isolation = ANY($11::text[])))
                SELECT s.* FROM runtime.runtime_cell_sessions s JOIN eligible e USING(cell_id)
                WHERE s.free_slots >= $3 AND s.disconnected_at IS NULL
                ORDER BY array_position($10::text[], s.pool_id) ASC NULLS LAST, (e.ordinal-($8::bigint % e.total)+e.total) % e.total, s.cell_id
                LIMIT 1 FOR UPDATE OF s SKIP LOCKED`,
                [
                    req.organizationId,
                    excludeCells,
                    ids.length,
                    open,
                    cap,
                    req.size?.memoryMb ?? null,
                    req.size?.cpus ?? null,
                    req.generation,
                    key,
                    pools,
                    isolations,
                ],
            );
            const row = candidates.rows[0];
            if (!row) {
                // n: the cells that may serve the org; isolated: those of them that satisfy the isolation asked; the rest counts among those.
                const eligible = await db.query(
                    `SELECT count(*) AS n, count(*) FILTER (WHERE $7::text[] IS NULL OR isolation = ANY($7::text[])) AS isolated,
                            count(*) FILTER (WHERE ($7::text[] IS NULL OR isolation = ANY($7::text[])) AND ($2::int IS NULL OR (max_claim_memory_mb >= $2 AND max_claim_cpus >= $3))) AS granting,
                            count(*) FILTER (WHERE ($7::text[] IS NULL OR isolation = ANY($7::text[])) AND NOT(cell_id=ANY($4::text[]))) AS untried
                       FROM runtime.runtime_cell_sessions WHERE disconnected_at IS NULL AND last_heartbeat_at>now()-interval '30 seconds' AND (owner='kodus' OR org_id=$1) AND session_epoch IS NOT NULL
                       AND cordoned_at IS NULL AND (bound_key IS NULL OR bound_key=$5::text) AND ($6::text[] IS NULL OR pool_id=ANY($6::text[]))`,
                    [req.organizationId, req.size?.memoryMb ?? null, req.size?.cpus ?? null, excludeCells, key, pools, isolations],
                );
                // The Run's host is on its way (the demand above): a wait, like a full cell.
                if (perRun && Number(eligible.rows[0]?.n) === 0) return { status: 'refused', reason: 'no_capacity', retryable: true };
                // Cells are there, and none runs claims under the isolation asked or above: never a lower one.
                if (Number(eligible.rows[0]?.n) > 0 && Number(eligible.rows[0]?.isolated) === 0) return { status: 'refused', reason: 'isolation_unavailable', retryable: false, allCellsTried: false };
                const sizeUnavailable = !!req.size && Number(eligible.rows[0]?.granting) === 0;
                return {
                    status: 'refused',
                    reason:
                        Number(eligible.rows[0]?.n) === 0
                            ? 'no_cell'
                            : sizeUnavailable
                              ? 'size_unavailable'
                            : open + ids.length > cap
                              ? 'org_capacity'
                              : 'no_capacity',
                    retryable: !sizeUnavailable,
                    allCellsTried: excludeCells.length > 0 && Number(eligible.rows[0]?.untried) === 0,
                };
            }
            await db.query(
                'UPDATE runtime.runtime_cell_sessions SET free_slots=free_slots-$2 WHERE cell_id=$1',
                [row.cell_id, ids.length],
            );
            for (const id of ids)
                await db.query(
                    `INSERT INTO runtime.runtime_cell_reservations(claim_id,org_id,cell_id,expires_at,owner_token) VALUES($1,$2,$3,LEAST($4::timestamptz,now()+interval '120 seconds'),$5)`,
                    [
                        id,
                        req.organizationId,
                        row.cell_id,
                        req.deadlineAt,
                        req.ticketOwnerToken,
                    ],
                );
            return {
                status: 'located',
                cell: {
                    cellId: row.cell_id,
                    replicaUrl: row.replica_url,
                    owner: row.owner,
                    orgId: row.org_id,
                    sessionEpoch: row.session_epoch,
                },
            };
        });
    }

    async matches(
        cellId: string,
        req: PhysicalAdmissionRequest,
    ): Promise<boolean> {
        const ids = req.members.map((m) =>
            claimIdFor(req.organizationId, m.idempotencyKey),
        );
        const r = await this.pool.query(
            `SELECT count(*) AS n FROM runtime.runtime_cell_reservations WHERE org_id=$1 AND cell_id=$2 AND owner_token=$3 AND claim_id=ANY($4::text[]) AND expires_at>now()`,
            [req.organizationId, cellId, req.ticketOwnerToken, ids],
        );
        return Number(r.rows[0]?.n) === ids.length;
    }

    async pin(
        ticket: PhysicalAdmissionTicket,
        until: string,
    ): Promise<boolean> {
        const result = await this.pool.query(
            `UPDATE runtime.runtime_cell_reservations SET expires_at=$4 WHERE org_id=$1 AND cell_id=$2 AND owner_token=$3 AND expires_at>now()`,
            [
                ticket.organizationId,
                ticket.cellId,
                ticket.ticketOwnerToken,
                until,
            ],
        );
        return result.rowCount === ticket.members.length;
    }

    async release(ticket: PhysicalAdmissionTicket): Promise<void> {
        // Never increment free_slots: a newer heartbeat may already have replaced its value.
        await this.pool.query(
            `DELETE FROM runtime.runtime_cell_reservations WHERE org_id=$1 AND cell_id=$2 AND owner_token=$3`,
            [ticket.organizationId, ticket.cellId, ticket.ticketOwnerToken],
        );
    }

    async retarget(
        ticket: PhysicalAdmissionTicket,
        idempotencyKey: string,
        until: string,
    ): Promise<boolean> {
        return this.opts.inTransaction(async (db) => {
            await db.query("SET LOCAL lock_timeout = '5s'");
            await db.query("SET LOCAL statement_timeout = '5s'");
            const lock = lockStatement('pg_advisory_xact_lock', lockKey('cell_reservation', ticket.organizationId));
            await db.query(lock.text, lock.values);
            const current = await db.query(
                'SELECT claim_id FROM runtime.runtime_cell_reservations WHERE org_id=$1 AND cell_id=$2 AND owner_token=$3 AND expires_at>now() FOR UPDATE',
                [ticket.organizationId, ticket.cellId, ticket.ticketOwnerToken],
            );
            if (current.rows.length !== 1) return false;
            await db.query(
                'DELETE FROM runtime.runtime_cell_reservations WHERE org_id=$1 AND cell_id=$2 AND owner_token=$3',
                [ticket.organizationId, ticket.cellId, ticket.ticketOwnerToken],
            );
            await db.query(
                `INSERT INTO runtime.runtime_cell_reservations(claim_id,org_id,cell_id,expires_at,owner_token) VALUES($1,$2,$3,$4,$5)`,
                [
                    claimIdFor(ticket.organizationId, idempotencyKey),
                    ticket.organizationId,
                    ticket.cellId,
                    until,
                    ticket.ticketOwnerToken,
                ],
            );
            return true;
        });
    }
}
