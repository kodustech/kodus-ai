// Test doubles of the API's ports (libs/runtime/AGENTS.md): specs and test fixtures import them, production code never does.
import { ENV_QUOTA_KINDS, type EnvAuditKind, type EnvAuditRecord, type RuntimeEnvAuditStore } from './domain/env-tools';
import { RECONCILE_MAX_ATTEMPTS, RECONCILE_STALE_CLAIM_MS, type ReconciledHeadKey, type ReconciledHeadStore } from './domain/webhook-reconciler';

type HeadRow = { state: 'claimed' | 'decided' | 'failed'; attempts: number; claimedAt: number; outcome?: string };

const keyOf = (k: ReconciledHeadKey) => `${k.organizationId}\u0000${k.repositoryId}\u0000${k.prNumber}\u0000${k.headSha}`;

/** The store's rules in memory. Claims are atomic within one process. */
export class InMemoryReconciledHeadStore implements ReconciledHeadStore {
    readonly rows = new Map<string, HeadRow>();

    constructor(private readonly now: () => number = Date.now) {}

    async claim(key: ReconciledHeadKey): Promise<number | null> {
        const id = keyOf(key);
        const row = this.rows.get(id);
        const at = this.now();
        if (!row) {
            this.rows.set(id, { state: 'claimed', attempts: 1, claimedAt: at });
            return 1;
        }
        const retake = row.state === 'failed' || (row.state === 'claimed' && row.claimedAt < at - RECONCILE_STALE_CLAIM_MS);
        if (!retake || row.attempts >= RECONCILE_MAX_ATTEMPTS) return null;
        this.rows.set(id, { state: 'claimed', attempts: row.attempts + 1, claimedAt: at });
        return row.attempts + 1;
    }

    async settle(key: ReconciledHeadKey, attempt: number, outcome: string) {
        const row = this.rows.get(keyOf(key));
        if (row?.state === 'claimed' && row.attempts === attempt) this.rows.set(keyOf(key), { ...row, state: 'decided', outcome });
    }

    async fail(key: ReconciledHeadKey, attempt: number, reason: string) {
        const row = this.rows.get(keyOf(key));
        if (row?.state === 'claimed' && row.attempts === attempt) this.rows.set(keyOf(key), { ...row, state: 'failed', outcome: reason });
    }
}

/** For tests. */
export class InMemoryRuntimeEnvAuditStore implements RuntimeEnvAuditStore {
    readonly rows: EnvAuditRecord[] = [];
    async record(r: EnvAuditRecord) {
        this.rows.push({ ...r });
    }
    async setOutcome(organizationId: string, auditId: string, outcome: EnvAuditRecord['outcome'], reason?: string) {
        const r = this.rows.find((x) => x.auditId === auditId && x.organizationId === organizationId);
        if (r) Object.assign(r, { outcome, ...(reason ? { reason } : {}) });
    }
    async countAccepted(q: { organizationId: string; keyId?: string; since: string }) {
        return this.rows.filter(
            (r) =>
                r.organizationId === q.organizationId &&
                (ENV_QUOTA_KINDS as readonly string[]).includes(r.kind) &&
                r.outcome === 'accepted' &&
                r.at >= q.since &&
                (!q.keyId || r.keyId === q.keyId),
        ).length;
    }
    async list(q: { organizationId: string; kind: EnvAuditKind; limit: number; before?: string }) {
        return this.rows
            .filter((r) => r.organizationId === q.organizationId && r.kind === q.kind && (!q.before || r.at < q.before))
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, q.limit);
    }
}
