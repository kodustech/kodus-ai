// Test doubles of the API's ports (libs/runtime/AGENTS.md): specs and test fixtures import them, production code never does.
import { ENV_QUOTA_KINDS, type EnvAuditKind, type EnvAuditRecord, type RuntimeEnvAuditStore } from './domain/env-tools';
import type { PushSetupClaim, PushSetupKey, PushSetupLedger } from './domain/push-setup';
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


const pushKey = (k: PushSetupKey) => `${k.organizationId}\u0000${k.environmentId}`;

/** The push setup ledger's rules in memory: one row per environment, the day counted in UTC. */
export class InMemoryPushSetupLedger implements PushSetupLedger {
    readonly rows = new Map<string, { pendingSha: string | null; pendingAt: number; day: string; count: number }>();

    private row(key: PushSetupKey) {
        return this.rows.get(pushKey(key)) ?? { pendingSha: null, pendingAt: 0, day: '', count: 0 };
    }

    async markPending(key: PushSetupKey, sha: string, at: Date) {
        this.rows.set(pushKey(key), { ...this.row(key), pendingSha: sha, pendingAt: at.getTime() });
    }

    async claim(key: PushSetupKey, at: Date, dailyLimit: number): Promise<PushSetupClaim> {
        const row = this.row(key);
        if (!row.pendingSha) return { status: 'none' };
        const day = at.toISOString().slice(0, 10);
        const spent = row.day === day ? row.count : 0;
        const claimed = spent < dailyLimit;
        this.rows.set(pushKey(key), { ...row, pendingSha: null, day, count: claimed ? spent + 1 : spent });
        return claimed ? { status: 'claimed', sha: row.pendingSha, spentToday: spent + 1 } : { status: 'budget_spent', sha: row.pendingSha, spentToday: spent };
    }

    async restorePending(key: PushSetupKey, sha: string, at: Date) {
        const row = this.row(key);
        const day = at.toISOString().slice(0, 10);
        // The setup did not start: give back its place in today's count too.
        this.rows.set(pushKey(key), { ...row, pendingSha: row.pendingSha ?? sha, pendingAt: at.getTime(), count: row.day === day && row.count > 0 ? row.count - 1 : row.count });
    }

    async clearPending(key: PushSetupKey, sha: string) {
        const row = this.row(key);
        if (row.pendingSha === sha) this.rows.set(pushKey(key), { ...row, pendingSha: null });
    }

    async listPending(limit: number) {
        return [...this.rows.entries()]
            .filter(([, r]) => r.pendingSha)
            .sort((a, b) => a[1].pendingAt - b[1].pendingAt)
            .slice(0, limit)
            .map(([k, r]) => {
                const [organizationId, environmentId] = k.split('\u0000');
                return { organizationId, environmentId, sha: r.pendingSha! };
            });
    }
}
