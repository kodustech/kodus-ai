import { createHash, randomUUID } from 'crypto';

import { z } from 'zod';

import { RuntimeEnvironmentSetupRequestedSchema } from '@libs/runtime/contracts/runtime-commands';
import {
    isForkApprovalRequired,
    RuntimeRunRequestedSchema,
} from '@libs/runtime/run/run-messages';

import {
    ADMISSION_APPROVAL_MS,
    ADMISSION_BYTE_LIMITS,
    ADMISSION_WAIT_MS,
    type AdmissionAcceptResult,
    type AdmissionDue,
    type AdmissionIdentity,
    type AdmissionLease,
    type AdmissionLimits,
    type AdmissionPayload,
    type AdmissionReason,
    type AdmissionRecord,
    type AdmissionRef,
    type AdmissionReserveResult,
    type AdmissionStore,
    type AdmissionTakeResult,
    type AdmissionTransition,
    type PhysicalAdmissionTicket,
} from './admission-contract';

const PayloadSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('run'),
        request: RuntimeRunRequestedSchema,
        options: z
            .strictObject({
                forkApproved: z.boolean().optional(),
                queuedAt: z.iso.datetime().optional(),
            })
            .optional(),
    }),
    z.strictObject({
        kind: z.literal('setup'),
        request: RuntimeEnvironmentSetupRequestedSchema,
    }),
]);
const RefSchema = z.strictObject({
    organizationId: z.string().min(1).max(128),
    kind: z.enum(['run', 'setup']),
    key: z.string().min(1).max(256),
});
const WAITING = new Set(['awaiting_approval', 'waiting', 'owned']);
const TERMINAL = new Set(['completed', 'cancelled', 'expired', 'rejected']);
/** Fingerprint of original ingress: approving fresh sealed tokens must not change duplicate identity. */
export interface StoredAdmission extends AdmissionRecord {
    payloadHash: string | null;
    lastScannedAt: string | null;
}
export interface AdmissionStats {
    waiting: number;
    orgWaiting: number;
    bytes: number;
    orgBytes: number;
    executing: number;
    orgExecuting: number;
    orgSetups: number;
}
export interface AdmissionTransaction {
    now: Date;
    get(ref: AdmissionRef): Promise<StoredAdmission | null>;
    put(
        row: StoredAdmission,
        opts?: { payloadChanged?: boolean },
    ): Promise<void>;
    collision(ref: AdmissionRef, executionId: string): Promise<boolean>;
    stats(org: string): Promise<AdmissionStats>;
    hasLiveClaims(row: StoredAdmission): Promise<boolean>;
}

const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value)
            .sort()
            .filter((key) => (value as any)[key] !== undefined)
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${canonical((value as any)[key])}`,
            )
            .join(',')}}`;
    return JSON.stringify(value);
};
const hash = (payload: AdmissionPayload) =>
    createHash('sha256').update(canonical(payload)).digest('hex');
const publicRow = (row: StoredAdmission): AdmissionRecord => {
    const { payloadHash: _hash, lastScannedAt: _scan, ...rest } = row;
    return structuredClone(rest);
};
const checkedRef = (ref: AdmissionRef) => {
    if (
        !RefSchema.safeParse({
            organizationId: ref?.organizationId,
            kind: ref?.kind,
            key: ref?.key,
        }).success
    )
        throw new Error('invalid admission reference');
};
const checkedPayload = (raw: AdmissionPayload): AdmissionPayload => {
    const parsed = PayloadSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid admission input');
    return parsed.data;
};
const checkedLimits = (limits: AdmissionLimits) => {
    const value = { ...ADMISSION_BYTE_LIMITS, ...limits };
    if (
        ![
            'globalWaiting',
            'perOrgWaiting',
            'globalExecuting',
            'perOrgExecuting',
            'maxAttempts',
            'maxPayloadBytes',
            'globalBacklogBytes',
            'orgBacklogBytes',
        ].every(
            (key) =>
                Number.isSafeInteger((value as any)[key]) &&
                (value as any)[key] > 0 &&
                (value as any)[key] <= 2_147_483_647,
        )
    )
        throw new Error('invalid admission limits');
    return value;
};
const payloadRef = (payload: AdmissionPayload): AdmissionRef => ({
    organizationId: payload.request.organizationId,
    kind: payload.kind,
    key: payload.kind === 'run' ? payload.request.runId : payload.request.key,
});
const executionId = (payload: AdmissionPayload) =>
    payload.kind === 'setup'
        ? `setup:${payload.request.key}`
        : isForkApprovalRequired(payload.request)
          ? `${payload.request.runId}:run`
          : payload.request.runId;
const sameIdentity = (row: StoredAdmission, identity: AdmissionIdentity) =>
    row.generation === identity.generation &&
    row.ticketOwnerToken === identity.ticketOwnerToken;
const ownsLease = (row: StoredAdmission, lease: AdmissionLease, now: Date) =>
    sameIdentity(row, lease) &&
    row.leaseToken === lease.leaseToken &&
    row.ownerEpoch === lease.ownerEpoch &&
    !!row.ownerUntil &&
    Date.parse(row.ownerUntil) > now.getTime() &&
    !TERMINAL.has(row.state) &&
    row.state !== 'running';
const transition = (
    row: StoredAdmission | null,
    changed = false,
    releasedTicket?: PhysicalAdmissionTicket,
): AdmissionTransition => ({
    changed,
    record: row ? publicRow(row) : null,
    ...(releasedTicket
        ? { releasedTicket: structuredClone(releasedTicket) }
        : {}),
});
const clearLease = (row: StoredAdmission) => {
    row.leaseToken = null;
    row.ownerUntil = null;
};

/** One transition implementation, with the same transaction semantics in memory and PostgreSQL. */
export abstract class AdmissionStoreBase implements AdmissionStore {
    protected abstract atomic<T>(
        fn: (tx: AdmissionTransaction) => Promise<T>,
    ): Promise<T>;
    protected abstract read(ref: AdmissionRef): Promise<StoredAdmission | null>;
    protected abstract scanDue(limit: number): Promise<AdmissionDue[]>;

    async accept(
        raw: AdmissionPayload,
        limits: AdmissionLimits,
    ): Promise<AdmissionAcceptResult> {
        const payload = checkedPayload(raw);
        const cap = checkedLimits(limits);
        const bytes = Buffer.byteLength(JSON.stringify(payload));
        if (bytes > cap.maxPayloadBytes) return { status: 'payload_too_large' };
        const ref = payloadRef(payload);
        const fingerprint = hash(payload);
        return this.atomic(async (tx) => {
            const old = await tx.get(ref);
            if (old?.state === 'cancelled')
                return { status: 'cancelled', record: publicRow(old) };
            if (old)
                return old.payloadHash === fingerprint
                    ? { status: 'existing', record: publicRow(old) }
                    : { status: 'conflict' };
            const workflow = executionId(payload);
            if (await tx.collision(ref, workflow))
                return { status: 'conflict' };
            const approval =
                payload.kind === 'run' &&
                isForkApprovalRequired(payload.request) &&
                payload.options?.forkApproved !== true;
            const at = tx.now.toISOString();
            const deadline = new Date(
                Date.parse(payload.request.requestedAt) +
                    (approval ? ADMISSION_APPROVAL_MS : ADMISSION_WAIT_MS),
            ).toISOString();
            const expired = Date.parse(deadline) <= tx.now.getTime();
            if (!expired) {
                const stats = await tx.stats(ref.organizationId);
                if (
                    stats.waiting >= cap.globalWaiting ||
                    stats.orgWaiting >= cap.perOrgWaiting ||
                    stats.bytes + bytes > cap.globalBacklogBytes ||
                    stats.orgBytes + bytes > cap.orgBacklogBytes
                )
                    return { status: 'backlog_full' };
            }
            const row: StoredAdmission = {
                ...ref,
                generation: 0,
                ticketOwnerToken: randomUUID(),
                payload,
                payloadBytes: bytes,
                payloadHash: fingerprint,
                lastScannedAt: null,
                executionId: workflow,
                state: expired
                    ? 'expired'
                    : approval
                      ? 'awaiting_approval'
                      : 'waiting',
                deadlineAt: approval ? null : deadline,
                approvalDeadlineAt: approval ? deadline : null,
                nextAt: at,
                maxAttempts: cap.maxAttempts,
                leaseToken: null,
                ownerEpoch: 0,
                ownerUntil: null,
                permitHeld: false,
                ticket: null,
                lastReason: expired ? 'deadline' : null,
                createdAt: at,
                updatedAt: at,
            };
            await tx.put(row, { payloadChanged: true });
            return { status: 'accepted', record: publicRow(row) };
        });
    }

    async get(ref: AdmissionRef): Promise<AdmissionRecord | null> {
        checkedRef(ref);
        const row = await this.read(ref);
        return row ? publicRow(row) : null;
    }

    async approveRun(
        ref: AdmissionRef,
        tokens?: { repoToken: string; prRepoToken?: string; runToken: string },
        limits?: AdmissionLimits,
    ): Promise<AdmissionTransition> {
        checkedRef(ref);
        return this.atomic(async (tx) => {
            const row = await tx.get(ref);
            if (
                !row ||
                row.state !== 'awaiting_approval' ||
                row.payload?.kind !== 'run'
            )
                return transition(row);
            const at = tx.now.toISOString();
            if (
                !row.approvalDeadlineAt ||
                Date.parse(row.approvalDeadlineAt) <= tx.now.getTime()
            ) {
                row.state = 'expired';
                row.lastReason = 'deadline';
                row.nextAt = at;
                row.updatedAt = at;
                await tx.put(row);
                return transition(row, true);
            }
            const payload = checkedPayload({
                kind: 'run',
                request: { ...row.payload.request, ...tokens },
                options: { forkApproved: true, queuedAt: at },
            });
            const bytes = Buffer.byteLength(JSON.stringify(payload));
            const cap = limits ? checkedLimits(limits) : ADMISSION_BYTE_LIMITS;
            const stats = await tx.stats(row.organizationId);
            if (
                bytes > cap.maxPayloadBytes ||
                stats.bytes - row.payloadBytes + bytes >
                    cap.globalBacklogBytes ||
                stats.orgBytes - row.payloadBytes + bytes > cap.orgBacklogBytes
            )
                return transition(row);
            row.payload = payload;
            row.payloadBytes = bytes;
            row.state = 'waiting';
            row.deadlineAt = new Date(
                tx.now.getTime() + ADMISSION_WAIT_MS,
            ).toISOString();
            row.nextAt = at;
            row.updatedAt = at;
            await tx.put(row, { payloadChanged: true });
            return transition(row, true);
        });
    }

    async cancel(
        ref: AdmissionRef,
        reason: AdmissionReason = 'cancelled',
    ): Promise<AdmissionTransition> {
        checkedRef(ref);
        return this.atomic(async (tx) => {
            let row = await tx.get(ref);
            const inserted = !row;
            if (row && (row.state === 'cancelled' || row.state === 'completed'))
                return transition(row);
            const at = tx.now.toISOString();
            row ??= {
                ...ref,
                generation: 0,
                ticketOwnerToken: randomUUID(),
                payload: null,
                payloadBytes: 0,
                payloadHash: null,
                lastScannedAt: null,
                executionId: null,
                state: 'cancelled',
                deadlineAt: null,
                approvalDeadlineAt: null,
                nextAt: null,
                maxAttempts: 1,
                leaseToken: null,
                ownerEpoch: 0,
                ownerUntil: null,
                permitHeld: false,
                ticket: null,
                lastReason: null,
                createdAt: at,
                updatedAt: at,
            };
            row.state = 'cancelled';
            row.lastReason = reason;
            row.nextAt = row.payload ? at : null;
            row.updatedAt = at;
            clearLease(row);
            await tx.put(row, { payloadChanged: inserted });
            return transition(row, true, row.ticket ?? undefined);
        });
    }

    async take(
        ref: AdmissionRef,
        generation: number,
        leaseMs: number,
    ): Promise<AdmissionTakeResult> {
        checkedRef(ref);
        if (
            !Number.isSafeInteger(generation) ||
            generation < 0 ||
            !Number.isSafeInteger(leaseMs) ||
            leaseMs < 1 ||
            leaseMs > 300_000
        )
            throw new Error('invalid admission ownership');
        return this.atomic(async (tx) => {
            const row = await tx.get(ref);
            if (!row) return { status: 'missing' };
            if (row.state === 'cancelled') return { status: 'cancelled' };
            if (row.generation !== generation) return { status: 'stale' };
            if (TERMINAL.has(row.state))
                return {
                    status: row.state === 'expired' ? 'expired' : 'stale',
                };
            if (row.state === 'awaiting_approval' || row.state === 'running')
                return { status: 'busy' };
            if (
                !row.deadlineAt ||
                Date.parse(row.deadlineAt) <= tx.now.getTime()
            ) {
                row.state = 'expired';
                row.lastReason = 'deadline';
                row.nextAt = tx.now.toISOString();
                clearLease(row);
                await tx.put(row);
                return { status: 'expired' };
            }
            if (
                (row.ownerUntil &&
                    Date.parse(row.ownerUntil) > tx.now.getTime()) ||
                (row.nextAt && Date.parse(row.nextAt) > tx.now.getTime())
            )
                return { status: 'busy' };
            row.leaseToken = randomUUID();
            row.ownerEpoch++;
            row.ownerUntil = new Date(
                Math.min(
                    tx.now.getTime() + leaseMs,
                    Date.parse(row.deadlineAt),
                ),
            ).toISOString();
            row.updatedAt = tx.now.toISOString();
            if (row.state === 'waiting') row.state = 'owned';
            await tx.put(row);
            const lease: AdmissionLease = {
                ...ref,
                generation,
                ticketOwnerToken: row.ticketOwnerToken,
                leaseToken: row.leaseToken,
                ownerEpoch: row.ownerEpoch,
                ownerUntil: row.ownerUntil,
            };
            return { status: 'taken', lease, record: publicRow(row) };
        });
    }

    async defer(
        lease: AdmissionLease,
        reason: AdmissionReason,
        nextAt: string,
    ): Promise<AdmissionTransition> {
        checkedRef({
            organizationId: lease.organizationId,
            kind: lease.kind,
            key: lease.key,
        });
        if (!Number.isFinite(Date.parse(nextAt)))
            throw new Error('invalid admission retry');
        return this.atomic(async (tx) => {
            const row = await tx.get(lease);
            if (!row || !ownsLease(row, lease, tx.now) || row.ticket)
                return transition(row);
            row.permitHeld = false;
            row.generation++;
            row.ticketOwnerToken = randomUUID();
            clearLease(row);
            const expired =
                row.generation >= row.maxAttempts ||
                !row.deadlineAt ||
                Date.parse(nextAt) >= Date.parse(row.deadlineAt);
            row.state = expired ? 'expired' : 'waiting';
            row.lastReason = expired
                ? row.generation >= row.maxAttempts
                    ? 'attempt_limit'
                    : 'deadline'
                : reason;
            row.nextAt = expired ? tx.now.toISOString() : nextAt;
            row.updatedAt = tx.now.toISOString();
            await tx.put(row);
            return transition(row, true);
        });
    }

    async reject(
        lease: AdmissionLease,
        reason: AdmissionReason,
    ): Promise<AdmissionTransition> {
        return this.atomic(async (tx) => {
            const row = await tx.get(lease);
            if (!row || !ownsLease(row, lease, tx.now) || row.ticket)
                return transition(row);
            row.state = 'rejected';
            row.lastReason = reason;
            row.nextAt = tx.now.toISOString();
            row.updatedAt = tx.now.toISOString();
            clearLease(row);
            await tx.put(row);
            return transition(row, true);
        });
    }

    async reserveExecution(
        lease: AdmissionLease,
        limits: AdmissionLimits,
    ): Promise<AdmissionReserveResult> {
        const cap = checkedLimits(limits);
        return this.atomic(async (tx) => {
            const row = await tx.get(lease);
            if (!row || !ownsLease(row, lease, tx.now))
                return { status: 'stale' };
            if (
                !row.deadlineAt ||
                Date.parse(row.deadlineAt) <= tx.now.getTime()
            )
                return { status: 'expired' };
            if (row.permitHeld)
                return { status: 'reserved', record: publicRow(row) };
            const stats = await tx.stats(row.organizationId);
            if (row.kind === 'setup' && stats.orgSetups >= 1)
                return { status: 'setup_limit' };
            if (stats.executing >= cap.globalExecuting)
                return { status: 'global_limit' };
            if (stats.orgExecuting >= cap.perOrgExecuting)
                return { status: 'org_limit' };
            row.permitHeld = true;
            row.state = 'reserved';
            row.updatedAt = tx.now.toISOString();
            await tx.put(row);
            return { status: 'reserved', record: publicRow(row) };
        });
    }

    async attachTicket(
        lease: AdmissionLease,
        ticket: PhysicalAdmissionTicket,
    ): Promise<AdmissionTransition> {
        return this.atomic(async (tx) => {
            const row = await tx.get(lease);
            if (
                !row ||
                !ownsLease(row, lease, tx.now) ||
                !row.permitHeld ||
                row.state !== 'reserved' ||
                !sameIdentity(row, ticket) ||
                row.organizationId !== ticket.organizationId ||
                row.kind !== ticket.kind ||
                row.key !== ticket.key ||
                !Number.isFinite(Date.parse(ticket.expiresAt)) ||
                Date.parse(ticket.expiresAt) <= tx.now.getTime()
            )
                return transition(row);
            if (row.ticket) return transition(row);
            row.ticket = structuredClone(ticket);
            row.nextAt = tx.now.toISOString();
            row.updatedAt = tx.now.toISOString();
            await tx.put(row);
            return transition(row, true);
        });
    }

    async markDispatched(lease: AdmissionLease): Promise<AdmissionTransition> {
        return this.atomic(async (tx) => {
            const row = await tx.get(lease);
            if (
                !row ||
                !ownsLease(row, lease, tx.now) ||
                !row.permitHeld ||
                !row.ticket ||
                row.state !== 'reserved'
            )
                return transition(row);
            row.state = 'dispatched';
            row.nextAt = tx.now.toISOString();
            row.updatedAt = tx.now.toISOString();
            await tx.put(row);
            return transition(row, true);
        });
    }

    async startExecution(
        identity: AdmissionIdentity,
        execution: string,
    ): Promise<AdmissionTransition> {
        return this.atomic(async (tx) => {
            const row = await tx.get(identity);
            if (
                !row ||
                !sameIdentity(row, identity) ||
                row.executionId !== execution ||
                !row.permitHeld ||
                !row.ticket ||
                !['reserved', 'dispatched'].includes(row.state) ||
                !row.deadlineAt ||
                Date.parse(row.deadlineAt) <= tx.now.getTime() ||
                Date.parse(row.ticket.expiresAt) <= tx.now.getTime()
            )
                return transition(row);
            row.state = 'running';
            row.nextAt = tx.now.toISOString();
            row.updatedAt = tx.now.toISOString();
            clearLease(row);
            await tx.put(row);
            return transition(row, true);
        });
    }

    async finishExecution(
        identity: AdmissionIdentity,
        execution: string,
    ): Promise<AdmissionTransition> {
        return this.atomic(async (tx) => {
            const row = await tx.get(identity);
            if (
                !row ||
                !sameIdentity(row, identity) ||
                row.executionId !== execution
            )
                return transition(row);
            if (row.state === 'completed' && !row.permitHeld)
                return transition(row, false, row.ticket ?? undefined);
            if (row.permitHeld && (await tx.hasLiveClaims(row)))
                return transition(row);
            if (!TERMINAL.has(row.state)) row.state = 'completed';
            row.permitHeld = false;
            row.nextAt = row.ticket ? tx.now.toISOString() : null;
            row.updatedAt = tx.now.toISOString();
            clearLease(row);
            await tx.put(row);
            return transition(row, true, row.ticket ?? undefined);
        });
    }

    async acknowledgeTicketCleanup(
        identity: AdmissionIdentity,
        ticketId: string,
    ): Promise<AdmissionTransition> {
        checkedRef(identity);
        return this.atomic(async (tx) => {
            const row = await tx.get(identity);
            if (
                !row ||
                !sameIdentity(row, identity) ||
                row.permitHeld ||
                !TERMINAL.has(row.state) ||
                row.ticket?.ticketId !== ticketId
            )
                return transition(row);
            row.ticket = null;
            row.nextAt = null;
            row.updatedAt = tx.now.toISOString();
            await tx.put(row);
            return transition(row, true);
        });
    }

    async owns(identity: AdmissionIdentity): Promise<boolean> {
        return this.atomic(async (tx) => {
            const row = await tx.get(identity);
            return (
                !!row &&
                sameIdentity(row, identity) &&
                row.permitHeld &&
                ['reserved', 'dispatched', 'running'].includes(row.state) &&
                (row.state === 'running' ||
                    (!!row.deadlineAt &&
                        Date.parse(row.deadlineAt) > tx.now.getTime()))
            );
        });
    }

    async due(limit: number): Promise<AdmissionDue[]> {
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error('invalid admission scan limit');
        return this.scanDue(Math.min(limit, 100));
    }
}

export const admissionWaiting = (row: AdmissionRecord) =>
    !row.permitHeld && (WAITING.has(row.state) || row.ticket !== null);
export const admissionDueAction = (
    row: AdmissionRecord,
): AdmissionDue['action'] =>
    row.state === 'awaiting_approval'
        ? 'approval'
        : TERMINAL.has(row.state) || row.state === 'running'
          ? 'finalize'
          : row.ticket
            ? 'dispatch'
            : 'attempt';

export class InMemoryAdmissionStore extends AdmissionStoreBase {
    private readonly rows = new Map<string, StoredAdmission>();
    private pending: Promise<unknown> = Promise.resolve();
    private readonly now: () => Date;
    constructor(
        private readonly opts: {
            now?: () => Date;
            hasLiveClaims?: (row: AdmissionRecord) => Promise<boolean>;
        } = {},
    ) {
        super();
        this.now = opts.now ?? (() => new Date());
    }
    private key(ref: AdmissionRef) {
        return JSON.stringify([ref.organizationId, ref.kind, ref.key]);
    }
    protected async read(ref: AdmissionRef) {
        return structuredClone(this.rows.get(this.key(ref)) ?? null);
    }
    protected async atomic<T>(
        fn: (tx: AdmissionTransaction) => Promise<T>,
    ): Promise<T> {
        const operation = this.pending.then(async () => {
            const edits = new Map<string, StoredAdmission>();
            const all = () => new Map([...this.rows, ...edits]);
            const tx: AdmissionTransaction = {
                now: this.now(),
                get: async (ref) =>
                    structuredClone(
                        edits.get(this.key(ref)) ??
                            this.rows.get(this.key(ref)) ??
                            null,
                    ),
                put: async (row) => {
                    edits.set(this.key(row), structuredClone(row));
                },
                collision: async (ref, execution) =>
                    [...all().values()].some(
                        (row) =>
                            !!row.payload &&
                            (row.executionId === execution ||
                                (row.kind === ref.kind &&
                                    row.key === ref.key)) &&
                            this.key(row) !== this.key(ref),
                    ),
                stats: async (org) => {
                    const rows = [...all().values()];
                    const waiting = rows.filter(admissionWaiting);
                    const active = rows.filter((row) => row.permitHeld);
                    return {
                        waiting: waiting.length,
                        orgWaiting: waiting.filter(
                            (row) => row.organizationId === org,
                        ).length,
                        bytes: waiting.reduce(
                            (n, row) => n + row.payloadBytes,
                            0,
                        ),
                        orgBytes: waiting
                            .filter((row) => row.organizationId === org)
                            .reduce((n, row) => n + row.payloadBytes, 0),
                        executing: active.length,
                        orgExecuting: active.filter(
                            (row) => row.organizationId === org,
                        ).length,
                        orgSetups: active.filter(
                            (row) =>
                                row.organizationId === org &&
                                row.kind === 'setup',
                        ).length,
                    };
                },
                hasLiveClaims: async (row) =>
                    this.opts.hasLiveClaims?.(publicRow(row)) ?? false,
            };
            const result = await fn(tx);
            for (const [key, row] of edits) this.rows.set(key, row);
            return result;
        });
        this.pending = operation.catch(() => undefined);
        return operation;
    }
    protected async scanDue(limit: number) {
        return this.atomic(async (tx) => {
            const now = tx.now.getTime();
            const selected = [...this.rows.values()]
                .filter(
                    (row) =>
                        row.nextAt &&
                        Date.parse(row.nextAt) <= now &&
                        (!row.ownerUntil || Date.parse(row.ownerUntil) <= now),
                )
                .sort(
                    (a, b) =>
                        (a.lastScannedAt ?? '').localeCompare(
                            b.lastScannedAt ?? '',
                        ) ||
                        a.nextAt!.localeCompare(b.nextAt!) ||
                        a.createdAt.localeCompare(b.createdAt),
                )
                .slice(0, limit);
            const scanAt = new Date(
                Math.max(
                    tx.now.getTime(),
                    ...[...this.rows.values()].map((row) =>
                        row.lastScannedAt
                            ? Date.parse(row.lastScannedAt) + 1
                            : 0,
                    ),
                ),
            ).toISOString();
            for (const row of selected)
                await tx.put({ ...row, lastScannedAt: scanAt });
            return selected.map((row) => ({
                organizationId: row.organizationId,
                kind: row.kind,
                key: row.key,
                generation: row.generation,
                action: admissionDueAction(row),
            }));
        });
    }
}
