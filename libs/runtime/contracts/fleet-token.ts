import { createHash, randomBytes } from 'crypto';

// Fleet registration tokens (docs/runtime/host-providers.md §8.1, F-02, F-03):
// minted by the hub only for runtime-fleet's client CN, one per host, single
// use, short-lived, bound to the pool, the host and (for a perRun host) the
// Run. A cell that redeems one is a Kodus cell of that pool; it can never
// make an org's cell, and an org's kcr_ token can never make a fleet cell.
// Only the SHA-256 is stored. The in-memory store is in contracts/testing.ts.

const PREFIX = 'kcf_';

/** A fleet token lives at most this long, whatever the pool's registration timeout asks. */
export const FLEET_TOKEN_MAX_TTL_MS = 60 * 60 * 1000;

export function generateFleetToken(): { token: string; tokenHash: string } {
    const token = `${PREFIX}${randomBytes(32).toString('base64url')}`;
    return { token, tokenHash: hashFleetToken(token) };
}

export const hashFleetToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export const isFleetToken = (token: unknown): token is string => typeof token === 'string' && token.startsWith(PREFIX) && token.length <= 128;

export interface FleetTokenRecord {
    tokenHash: string;
    poolId: string;
    hostId: string;
    /** A perRun host's Run (`run:<org>/<runId>`, or `suite:<org>/<suiteRunId>/<shard>` for one shard of a suite run); null for a host any claim of its pool may use. */
    boundKey: string | null;
    expiresAt: string;
    issuedBy: string;
    usedAt?: string;
}

export interface FleetTokenStore {
    /**
     * Stores the host's token, replacing an unused one of the same host (a mint retried before the host was
     * created). 'already_registered': the host's token was used, so the host has its cell and gets no other.
     */
    issue(record: FleetTokenRecord): Promise<'issued' | 'already_registered'>;
    /** Marks the token used and returns it, atomically; null when unknown or used. */
    consume(tokenHash: string, now: Date): Promise<FleetTokenRecord | null>;
}

export type FleetRedeemResult =
    | { ok: true; poolId: string; hostId: string; boundKey: string | null }
    | { ok: false; reason: 'unknown_or_used' | 'expired' | 'malformed' };

export class FleetTokenLedger {
    constructor(
        private readonly store: FleetTokenStore,
        private readonly now: () => Date = () => new Date(),
    ) {}

    issue(r: { tokenHash: string; poolId: string; hostId: string; boundKey: string | null; ttlMs: number; issuedBy: string }) {
        const ttl = Math.min(Math.max(r.ttlMs, 60_000), FLEET_TOKEN_MAX_TTL_MS);
        return this.store.issue({ tokenHash: r.tokenHash, poolId: r.poolId, hostId: r.hostId, boundKey: r.boundKey, expiresAt: new Date(this.now().getTime() + ttl).toISOString(), issuedBy: r.issuedBy });
    }

    /** One redemption per token, ever: an expired attempt still burns it. */
    async redeem(token: string): Promise<FleetRedeemResult> {
        if (!isFleetToken(token)) return { ok: false, reason: 'malformed' };
        const now = this.now();
        const record = await this.store.consume(hashFleetToken(token), now);
        if (!record) return { ok: false, reason: 'unknown_or_used' };
        if (Date.parse(record.expiresAt) <= now.getTime()) return { ok: false, reason: 'expired' };
        return { ok: true, poolId: record.poolId, hostId: record.hostId, boundKey: record.boundKey };
    }
}
