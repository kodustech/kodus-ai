import { timingSafeEqual } from 'crypto';

import type { CellTokenRecord, CellTokenStore } from './cell-token';

// Test doubles of the contracts' ports: for specs and the dev hub, never a
// production store.

/** runtime_cell_tokens in memory: one consume per token hash, compared in constant time. */
export class InMemoryCellTokenStore implements CellTokenStore {
    readonly records = new Map<string, CellTokenRecord>();

    async insert(record: CellTokenRecord) {
        if (this.records.has(record.tokenHash)) throw new Error('duplicate token hash');
        this.records.set(record.tokenHash, { ...record });
    }

    async consume(tokenHash: string, now: Date) {
        for (const [hash, record] of this.records) {
            const a = Buffer.from(hash);
            const b = Buffer.from(tokenHash);
            if (a.length === b.length && timingSafeEqual(a, b)) {
                if (record.usedAt || record.revokedAt) return null;
                record.usedAt = now.toISOString();
                return { ...record };
            }
        }
        return null;
    }

    async revoke(tokenHash: string, organizationId: string, at: Date) {
        const record = this.records.get(tokenHash);
        if (!record || record.organizationId !== organizationId || record.usedAt || record.revokedAt) return false;
        record.revokedAt = at.toISOString();
        return true;
    }
}
