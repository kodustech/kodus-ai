import type { Collection, Db } from 'mongodb';

import type { EnvAuditKind, EnvAuditRecord, RuntimeEnvAuditStore } from '../domain/env-tools';

/** Every env_exec and env_fix of a team key (S-27), in the product Mongo, kept 90 days. */
export const RUNTIME_ENV_AUDIT_COLLECTION = 'runtime_env_audit';
const RETENTION_SECONDS = 90 * 24 * 3_600;

type AuditDoc = Omit<EnvAuditRecord, 'at'> & { _id: string; at: Date };

const fromDoc = ({ _id, at, ...rest }: AuditDoc): EnvAuditRecord => ({ ...rest, at: at.toISOString() });

export class MongoRuntimeEnvAuditStore implements RuntimeEnvAuditStore {
    private ready?: Promise<Collection<AuditDoc>>;

    constructor(private readonly db: () => Promise<Db>) {}

    private coll(): Promise<Collection<AuditDoc>> {
        this.ready ??= (async () => {
            const coll = (await this.db()).collection<AuditDoc>(RUNTIME_ENV_AUDIT_COLLECTION);
            await Promise.all([
                coll.createIndex({ organizationId: 1, kind: 1, at: -1 }),
                coll.createIndex({ organizationId: 1, keyId: 1, kind: 1, outcome: 1, at: -1 }),
                coll.createIndex({ at: 1 }, { expireAfterSeconds: RETENTION_SECONDS }),
            ]);
            return coll;
        })().catch((e) => {
            this.ready = undefined;
            throw e;
        });
        return this.ready;
    }

    async record(r: EnvAuditRecord) {
        const { auditId, at, ...rest } = r;
        await (await this.coll()).insertOne({ _id: auditId, auditId, ...rest, at: new Date(at) });
    }

    async setOutcome(organizationId: string, auditId: string, outcome: EnvAuditRecord['outcome'], reason?: string) {
        await (await this.coll()).updateOne({ _id: auditId, organizationId }, { $set: { outcome, ...(reason ? { reason } : {}) } });
    }

    async countAccepted(q: { organizationId: string; keyId?: string; since: string }) {
        return (await this.coll()).countDocuments({
            organizationId: q.organizationId,
            kind: 'env_exec',
            outcome: 'accepted',
            at: { $gte: new Date(q.since) },
            ...(q.keyId ? { keyId: q.keyId } : {}),
        });
    }

    async list(q: { organizationId: string; kind: EnvAuditKind; limit: number; before?: string }) {
        const docs = await (
            await this.coll()
        )
            .find({ organizationId: q.organizationId, kind: q.kind, ...(q.before ? { at: { $lt: new Date(q.before) } } : {}) })
            .sort({ at: -1 })
            .limit(q.limit)
            .toArray();
        return docs.map(fromDoc);
    }
}

/** For tests and a deployment without Mongo. */
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
                r.kind === 'env_exec' &&
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
