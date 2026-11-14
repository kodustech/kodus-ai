import { createHash, randomBytes, timingSafeEqual } from 'crypto';

// Registration token of a customer cell (ADR-054): created by the org admin,
// single use, valid for 15 minutes, bound to the org and the topology. Only the
// SHA-256 of the token is ever stored or sent; the plain token is shown once.
// The product issues it; the Runtime (hub) redeems it against runtime_cell_tokens,
// which only the Runtime writes (ADR-025). Both sides share the rules below.

export const CELL_TOPOLOGIES = ['hybrid', 'self_hosted'] as const;
export type CellTopology = (typeof CELL_TOPOLOGIES)[number];

export const CELL_TOKEN_TTL_MS = 15 * 60 * 1000;
const PREFIX = 'kcr_';

export function generateCellRegistrationToken(): { token: string; tokenHash: string } {
    const token = `${PREFIX}${randomBytes(32).toString('base64url')}`;
    return { token, tokenHash: hashCellRegistrationToken(token) };
}

export function hashCellRegistrationToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface CellTokenRecord {
    tokenHash: string;
    organizationId: string;
    topology: CellTopology;
    expiresAt: string;
    issuedBy: string;
    usedAt?: string;
}

export interface CellTokenStore {
    insert(record: CellTokenRecord): Promise<void>;
    /**
     * Marks the token used and returns it, in one atomic step
     * (`UPDATE ... SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL RETURNING *`).
     * Returns null when the hash is unknown or was already used.
     */
    consume(tokenHash: string, now: Date): Promise<CellTokenRecord | null>;
}

export type RedeemResult =
    | { ok: true; organizationId: string; topology: CellTopology }
    | { ok: false; reason: 'unknown_or_used' | 'expired' | 'topology_mismatch' | 'malformed' };

export class CellTokenLedger {
    constructor(
        private readonly store: CellTokenStore,
        private readonly now: () => Date = () => new Date(),
    ) {}

    /** Records an issued token (hash only). */
    async record(record: CellTokenRecord): Promise<void> {
        await this.store.insert(record);
    }

    /** One redemption per token, ever: an expired or mismatched attempt still burns it. */
    async redeem(token: string, topology: string): Promise<RedeemResult> {
        if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 128) {
            return { ok: false, reason: 'malformed' };
        }
        const now = this.now();
        const record = await this.store.consume(hashCellRegistrationToken(token), now);
        if (!record) return { ok: false, reason: 'unknown_or_used' };
        if (Date.parse(record.expiresAt) <= now.getTime()) return { ok: false, reason: 'expired' };
        if (record.topology !== topology) return { ok: false, reason: 'topology_mismatch' };
        return { ok: true, organizationId: record.organizationId, topology: record.topology };
    }
}

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
                if (record.usedAt) return null;
                record.usedAt = now.toISOString();
                return { ...record };
            }
        }
        return null;
    }
}
