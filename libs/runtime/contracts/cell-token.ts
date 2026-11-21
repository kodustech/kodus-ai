import { createHash, randomBytes } from 'crypto';

// Registration token of a customer cell: created by the org admin,
// single use, valid for 15 minutes, bound to the org and the topology, and
// revocable while unused (docs/runtime/self-hosted.md). Only the SHA-256 of
// the token is ever stored or sent; the plain token is shown once. The hash is
// the token's public id: redemption hashes the plain token, so knowing the
// hash registers nothing.
// The product issues it; the Runtime (hub) redeems it against runtime_cell_tokens,
// which only the Runtime writes. Both sides share the rules below. The
// in-memory store for tests and the dev hub is in contracts/testing.ts.

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
    revokedAt?: string;
}

export interface CellTokenStore {
    insert(record: CellTokenRecord): Promise<void>;
    /**
     * Marks the token used and returns it, in one atomic step
     * (`UPDATE ... SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL RETURNING *`).
     * Returns null when the hash is unknown or was already used.
     */
    consume(tokenHash: string, now: Date): Promise<CellTokenRecord | null>;
    /**
     * Revokes a token of that org that is neither used nor revoked, in one
     * atomic step; consume then skips it. False when there is no such token.
     */
    revoke(tokenHash: string, organizationId: string, at: Date, by: string): Promise<boolean>;
}

/** What a listing shows of a token: never the token, which is not stored. */
export type CellTokenState = 'pending' | 'used' | 'expired' | 'revoked';

export function cellTokenState(t: Pick<CellTokenRecord, 'expiresAt' | 'usedAt' | 'revokedAt'>, now: Date): CellTokenState {
    if (t.revokedAt) return 'revoked';
    if (t.usedAt) return 'used';
    return Date.parse(t.expiresAt) <= now.getTime() ? 'expired' : 'pending';
}

/** A token id is its SHA-256, hex. */
export const isCellTokenId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

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

    /**
     * One redemption per token, ever: an expired or mismatched attempt still
     * burns it, and a revoked one is unknown. A cell that names no topology
     * takes the token's (the token is bound to it when it is created).
     */
    async redeem(token: string, topology?: string): Promise<RedeemResult> {
        if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 128) {
            return { ok: false, reason: 'malformed' };
        }
        const now = this.now();
        const record = await this.store.consume(hashCellRegistrationToken(token), now);
        if (!record) return { ok: false, reason: 'unknown_or_used' };
        if (Date.parse(record.expiresAt) <= now.getTime()) return { ok: false, reason: 'expired' };
        if (topology && record.topology !== topology) return { ok: false, reason: 'topology_mismatch' };
        return { ok: true, organizationId: record.organizationId, topology: record.topology };
    }

    /** Revokes an unused token of the org; false when it is unknown, another org's, used or already revoked. */
    async revoke(tokenHash: string, organizationId: string, by: string): Promise<boolean> {
        if (!isCellTokenId(tokenHash)) return false;
        return this.store.revoke(tokenHash, organizationId, this.now(), by);
    }
}
