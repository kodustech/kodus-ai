import { timingSafeEqual } from 'crypto';

import type { CellTokenRecord, CellTokenStore } from './cell-token';
import type { FleetTokenRecord, FleetTokenStore } from './fleet-token';

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

/** runtime_fleet_tokens in memory: one token per host, replaced while unused, one consume per token. */
export class InMemoryFleetTokenStore implements FleetTokenStore {
    readonly records = new Map<string, FleetTokenRecord>();

    async issue(record: FleetTokenRecord) {
        for (const [hash, r] of this.records) {
            if (r.hostId !== record.hostId) continue;
            if (r.usedAt) return 'already_registered' as const;
            this.records.delete(hash);
        }
        this.records.set(record.tokenHash, { ...record });
        return 'issued' as const;
    }

    async consume(tokenHash: string, now: Date) {
        const record = this.records.get(tokenHash);
        if (!record || record.usedAt) return null;
        record.usedAt = now.toISOString();
        return { ...record };
    }
}
