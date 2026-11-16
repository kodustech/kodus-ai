// Test doubles (libs/runtime/AGENTS.md): specs and dev wiring import them, production code never does.
import type { AdmissionRecord, AdmissionRef } from './admission-contract';
import { admissionDueAction, AdmissionStoreBase, type AdmissionTransaction, admissionWaiting, publicRow, type StoredAdmission } from './admission-store';
import { conflict, decision, type Fence, type PrAdmissionDecision, type PrAdmissionStore, type PrScope, type Registration, same } from './pr-admission-store';

const scopeKey = (s: PrScope) =>
    JSON.stringify([s.organizationId, s.repositoryId, s.prNumber]);
const identityKey = (s: PrScope, id: string) =>
    JSON.stringify([s.organizationId, id]);

/** Explicit test/local adapter; never the production DI default. */
export class InMemoryPrAdmissionStore implements PrAdmissionStore {
    private readonly fences = new Map<string, Fence>();
    private readonly runs = new Map<string, Registration>();
    private readonly cancellations = new Map<
        string,
        PrScope & { ceiling: string; keepHead?: string }
    >();
    async register(
        scope: PrScope,
        runId: string,
        head: string,
        redelivered: boolean,
    ): Promise<PrAdmissionDecision> {
        const key = scopeKey(scope);
        const fence = this.fences.get(key);
        const known = this.runs.get(identityKey(scope, runId));
        if (known) {
            if (!same(scope, known) || known.head !== head) conflict();
            return decision(fence!, known.generation);
        }
        if (redelivered && fence)
            return { accepted: false, reason: 'unknown_redelivery' };
        const next =
            !fence || fence.head !== head
                ? { generation: (fence?.generation ?? 0n) + 1n, head }
                : fence;
        this.fences.set(key, next);
        this.runs.set(identityKey(scope, runId), {
            ...scope,
            generation: next.generation,
            head,
        });
        return { accepted: true };
    }
    async current(scope: PrScope, runId: string): Promise<PrAdmissionDecision> {
        const known = this.runs.get(identityKey(scope, runId));
        if (!known || !same(scope, known)) conflict();
        return decision(this.fences.get(scopeKey(scope))!, known.generation);
    }
    async cancel(
        scope: PrScope,
        commandId: string,
        keepHead?: string,
        redelivered?: boolean,
    ): Promise<string> {
        const id = identityKey(scope, commandId);
        const known = this.cancellations.get(id);
        if (known) {
            if (!same(scope, known) || known.keepHead !== keepHead) conflict();
            return known.ceiling;
        }
        const key = scopeKey(scope),
            fence = this.fences.get(key);
        if (redelivered && fence) conflict();
        const retainsCurrent =
            keepHead !== undefined && fence?.head === keepHead;
        const ceiling = (
            retainsCurrent ? fence!.generation - 1n : (fence?.generation ?? 0n)
        ).toString();
        if (!retainsCurrent)
            this.fences.set(key, {
                generation: (fence?.generation ?? 0n) + 1n,
                head: keepHead ?? null,
            });
        this.cancellations.set(id, { ...scope, ceiling, keepHead });
        return ceiling;
    }
    async canCancel(
        scope: PrScope,
        runId: string,
        ceiling: string,
    ): Promise<boolean> {
        const known = this.runs.get(identityKey(scope, runId));
        return (
            !known ||
            (same(scope, known) && known.generation <= BigInt(ceiling))
        );
    }
}

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
        // Only the queue of operations ignores the failure: the caller gets `operation` and its rejection.
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
