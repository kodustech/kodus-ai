import { LockScopedPg } from '../persistence/lock-scoped-pg';
import { createHash } from 'crypto';

import type { Pool } from 'pg';

import type {
    AdmissionDue,
    AdmissionIdentity,
    AdmissionRef,
} from './admission-contract';
import {
    AdmissionStoreBase,
    type AdmissionStats,
    type AdmissionTransaction,
    type StoredAdmission,
} from './admission-store';

const digest = createHash('sha256')
    .update('kody-runtime/admission-quota')
    .digest();
const LOCK = [digest.readInt32BE(0), digest.readInt32BE(4)];
const COLUMNS = [
    'org_id',
    'kind',
    'request_key',
    'generation',
    'ticket_owner_token',
    'payload',
    'payload_bytes',
    'payload_hash',
    'execution_id',
    'state',
    'deadline_at',
    'approval_deadline_at',
    'next_at',
    'max_attempts',
    'lease_token',
    'owner_epoch',
    'owner_until',
    'permit_held',
    'ticket',
    'last_reason',
    'created_at',
    'updated_at',
];
const identity = (ref: AdmissionRef) => [ref.organizationId, ref.kind, ref.key];
const iso = (value: unknown): string | null =>
    value == null ? null : new Date(value as string | Date).toISOString();
function fromRow(row: any): StoredAdmission {
    return {
        organizationId: row.org_id,
        kind: row.kind,
        key: row.request_key,
        generation: Number(row.generation),
        ticketOwnerToken: row.ticket_owner_token,
        payload: row.payload,
        payloadBytes: Number(row.payload_bytes),
        payloadHash: row.payload_hash,
        lastScannedAt: iso(row.last_scanned_at),
        executionId: row.execution_id,
        state: row.state,
        deadlineAt: iso(row.deadline_at),
        approvalDeadlineAt: iso(row.approval_deadline_at),
        nextAt: iso(row.next_at),
        maxAttempts: Number(row.max_attempts),
        leaseToken: row.lease_token,
        ownerEpoch: Number(row.owner_epoch),
        ownerUntil: iso(row.owner_until),
        permitHeld: row.permit_held,
        ticket: row.ticket,
        lastReason: row.last_reason,
        createdAt: iso(row.created_at)!,
        updatedAt: iso(row.updated_at)!,
    };
}
const values = (row: StoredAdmission) => [
    row.organizationId,
    row.kind,
    row.key,
    row.generation,
    row.ticketOwnerToken,
    row.payload ? JSON.stringify(row.payload) : null,
    row.payloadBytes,
    row.payloadHash,
    row.executionId,
    row.state,
    row.deadlineAt,
    row.approvalDeadlineAt,
    row.nextAt,
    row.maxAttempts,
    row.leaseToken,
    row.ownerEpoch,
    row.ownerUntil,
    row.permitHeld,
    row.ticket ? JSON.stringify(row.ticket) : null,
    row.lastReason,
    row.createdAt,
    row.updatedAt,
];
const metadata = (row: StoredAdmission) => ({
    generation: row.generation,
    ticket_owner_token: row.ticketOwnerToken,
    execution_id: row.executionId,
    state: row.state,
    deadline_at: row.deadlineAt,
    approval_deadline_at: row.approvalDeadlineAt,
    next_at: row.nextAt,
    max_attempts: row.maxAttempts,
    lease_token: row.leaseToken,
    owner_epoch: row.ownerEpoch,
    owner_until: row.ownerUntil,
    permit_held: row.permitHeld,
    ticket: row.ticket ? JSON.stringify(row.ticket) : null,
    last_reason: row.lastReason,
    updated_at: row.updatedAt,
});

/** Counts and byte sums serialize across replicas; this transaction never reaches a hub, broker or DBOS. */
export class PgAdmissionStore extends AdmissionStoreBase {
    constructor(pool: Pool, private readonly sql = new LockScopedPg(pool)) {
        super();
    }

    protected async read(ref: AdmissionRef): Promise<StoredAdmission | null> {
        const result = await this.sql.query(
            'SELECT * FROM runtime.runtime_admission_requests WHERE org_id=$1 AND kind=$2 AND request_key=$3',
            identity(ref),
        );
        return result.rows[0] ? fromRow(result.rows[0]) : null;
    }

    override async owns(ref: AdmissionIdentity): Promise<boolean> {
        if (
            !Number.isSafeInteger(ref.generation) ||
            ref.generation < 0 ||
            typeof ref.ticketOwnerToken !== 'string' ||
            ref.ticketOwnerToken.length !== 36 ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                ref.ticketOwnerToken,
            )
        )
            return false;
        const result = await this.sql.query(
            `SELECT 1 FROM runtime.runtime_admission_requests
            WHERE org_id=$1 AND kind=$2 AND request_key=$3 AND generation=$4 AND ticket_owner_token=$5
              AND permit_held AND state IN ('reserved','dispatched','running')
              AND (state='running' OR deadline_at > now())`,
            [...identity(ref), ref.generation, ref.ticketOwnerToken],
        );
        return result.rows.length > 0;
    }

    protected async atomic<T>(
        fn: (tx: AdmissionTransaction) => Promise<T>,
    ): Promise<T> {
        return this.sql.transaction(async client => {
            await client.query("SET LOCAL lock_timeout='2s'");
            await client.query("SET LOCAL statement_timeout='5s'");
            await client.query(
                'SELECT pg_advisory_xact_lock($1::int, $2::int)',
                LOCK,
            );
            const at = (await client.query('SELECT clock_timestamp() AS at'))
                .rows[0].at as Date;
            const tx: AdmissionTransaction = {
                now: at,
                get: async (ref) => {
                    const found = await client.query(
                        'SELECT * FROM runtime.runtime_admission_requests WHERE org_id=$1 AND kind=$2 AND request_key=$3 FOR UPDATE',
                        identity(ref),
                    );
                    return found.rows[0] ? fromRow(found.rows[0]) : null;
                },
                put: async (row, opts) => {
                    if (opts?.payloadChanged) {
                        await client.query(
                            `INSERT INTO runtime.runtime_admission_requests (${COLUMNS.join(',')}) VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(',')})
                            ON CONFLICT (org_id,kind,request_key) DO UPDATE SET ${COLUMNS.slice(
                                3,
                            )
                                .filter(
                                    (name) =>
                                        name !== 'payload_hash' &&
                                        name !== 'created_at',
                                )
                                .map((name) => `${name}=EXCLUDED.${name}`)
                                .join(',')}`,
                            values(row),
                        );
                    } else {
                        const entries = Object.entries(metadata(row));
                        await client.query(
                            `UPDATE runtime.runtime_admission_requests SET ${entries.map(([name], i) => `${name}=$${i + 4}`).join(',')}
                            WHERE org_id=$1 AND kind=$2 AND request_key=$3`,
                            [
                                ...identity(row),
                                ...entries.map(([, value]) => value),
                            ],
                        );
                    }
                },
                collision: async (ref, execution) =>
                    (
                        await client.query(
                            `SELECT 1 FROM runtime.runtime_admission_requests WHERE payload IS NOT NULL
                    AND (execution_id=$4 OR (kind=$2 AND request_key=$3)) AND NOT (org_id=$1 AND kind=$2 AND request_key=$3) LIMIT 1`,
                            [...identity(ref), execution],
                        )
                    ).rows.length > 0,
                stats: async (org): Promise<AdmissionStats> => {
                    const result = await client.query(
                        `SELECT
                        count(*) FILTER (WHERE NOT permit_held AND (state IN ('awaiting_approval','waiting','owned') OR ticket IS NOT NULL)) AS waiting,
                        count(*) FILTER (WHERE NOT permit_held AND (state IN ('awaiting_approval','waiting','owned') OR ticket IS NOT NULL) AND org_id=$1) AS org_waiting,
                        COALESCE(sum(payload_bytes) FILTER (WHERE NOT permit_held AND (state IN ('awaiting_approval','waiting','owned') OR ticket IS NOT NULL)),0) AS bytes,
                        COALESCE(sum(payload_bytes) FILTER (WHERE NOT permit_held AND (state IN ('awaiting_approval','waiting','owned') OR ticket IS NOT NULL) AND org_id=$1),0) AS org_bytes,
                        count(*) FILTER (WHERE permit_held) AS executing,
                        count(*) FILTER (WHERE permit_held AND org_id=$1) AS org_executing,
                        count(*) FILTER (WHERE permit_held AND org_id=$1 AND kind='setup') AS org_setups
                        FROM runtime.runtime_admission_requests WHERE permit_held OR state IN ('awaiting_approval','waiting','owned') OR ticket IS NOT NULL`,
                        [org],
                    );
                    const row = result.rows[0];
                    return {
                        waiting: Number(row.waiting),
                        orgWaiting: Number(row.org_waiting),
                        bytes: Number(row.bytes),
                        orgBytes: Number(row.org_bytes),
                        executing: Number(row.executing),
                        orgExecuting: Number(row.org_executing),
                        orgSetups: Number(row.org_setups),
                    };
                },
                hasLiveClaims: async (row) => {
                    if (!row.payload) return false;
                    const result =
                        row.payload.kind === 'run'
                            ? await client.query(
                                  'SELECT 1 FROM runtime.runtime_claims WHERE org_id=$1 AND run_id=$2 AND released_at IS NULL LIMIT 1',
                                  [
                                      row.organizationId,
                                      row.payload.request.runId,
                                  ],
                              )
                            : await client.query(
                                  "SELECT 1 FROM runtime.runtime_claims WHERE org_id=$1 AND environment_id=$2 AND (consumer='setup' OR (consumer IS NULL AND side='setup')) AND released_at IS NULL LIMIT 1",
                                  [
                                      row.organizationId,
                                      row.payload.request.environmentId,
                                  ],
                              );
                    return result.rows.length > 0;
                },
            };
            const result = await fn(tx);
            return result;
        });
    }

    protected async scanDue(limit: number): Promise<AdmissionDue[]> {
        const rows = await this.sql.query(
            `WITH picked AS MATERIALIZED (
            SELECT org_id,kind,request_key FROM runtime.runtime_admission_requests
            WHERE next_at <= now() AND (owner_until IS NULL OR owner_until <= now())
            ORDER BY last_scanned_at NULLS FIRST,next_at,created_at,org_id,kind,request_key
            LIMIT $1 FOR UPDATE SKIP LOCKED
        ), advanced AS (
            UPDATE runtime.runtime_admission_requests AS admission SET last_scanned_at=clock_timestamp()
            FROM picked WHERE admission.org_id=picked.org_id AND admission.kind=picked.kind AND admission.request_key=picked.request_key
            RETURNING admission.org_id,admission.kind,admission.request_key,admission.generation,admission.state,
                (admission.ticket IS NOT NULL) AS has_ticket,admission.last_scanned_at,admission.next_at,admission.created_at
        ) SELECT org_id,kind,request_key,generation,
            CASE WHEN state='awaiting_approval' THEN 'approval' WHEN state IN ('running','completed','cancelled','expired','rejected') THEN 'finalize'
                 WHEN has_ticket THEN 'dispatch' ELSE 'attempt' END AS action
            FROM advanced ORDER BY last_scanned_at,next_at,created_at,org_id,kind,request_key`,
            [limit],
        );
        return rows.rows.map((row) => ({
            organizationId: row.org_id,
            kind: row.kind,
            key: row.request_key,
            generation: Number(row.generation),
            action: row.action,
        }));
    }
}
