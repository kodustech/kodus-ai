import { generateCellRegistrationToken } from './cell-token';
import { FLEET_TOKEN_MAX_TTL_MS, FleetTokenLedger, generateFleetToken, hashFleetToken, isFleetToken } from './fleet-token';
import { InMemoryFleetTokenStore } from './testing';

describe('fleet registration tokens (kcf_)', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    const setup = () => {
        const store = new InMemoryFleetTokenStore();
        return { store, ledger: new FleetTokenLedger(store, () => now) };
    };
    const issue = async (ledger: FleetTokenLedger, over: { hostId?: string; ttlMs?: number } = {}) => {
        const { token, tokenHash } = generateFleetToken();
        const r = await ledger.issue({ tokenHash, poolId: 'boat-eu-perrun', hostId: over.hostId ?? 'host-1', boundKey: 'run:org-a/r-1', ttlMs: over.ttlMs ?? 600_000, issuedBy: 'runtime-fleet' });
        return { token, tokenHash, r };
    };

    it('registers one cell, bound to the pool, host and Run the fleet minted it for; a second use is refused', async () => {
        const { ledger } = setup();
        const { token } = await issue(ledger);
        expect(await ledger.redeem(token)).toEqual({ ok: true, poolId: 'boat-eu-perrun', hostId: 'host-1', boundKey: 'run:org-a/r-1' });
        expect(await ledger.redeem(token)).toEqual({ ok: false, reason: 'unknown_or_used' });
    });

    it('an expired token is refused and burned', async () => {
        const { store, ledger } = setup();
        const { token, tokenHash } = await issue(ledger);
        store.records.get(tokenHash)!.expiresAt = new Date(now.getTime() - 1).toISOString();
        expect(await ledger.redeem(token)).toEqual({ ok: false, reason: 'expired' });
        expect(await ledger.redeem(token)).toEqual({ ok: false, reason: 'unknown_or_used' });
    });

    it("an org's kcr_ token is not a fleet token, and a fleet token is not an org's", () => {
        const { ledger } = setup();
        expect(isFleetToken(generateFleetToken().token)).toBe(true);
        expect(isFleetToken(generateCellRegistrationToken().token)).toBe(false);
        return expect(ledger.redeem(generateCellRegistrationToken().token)).resolves.toEqual({ ok: false, reason: 'malformed' });
    });

    it('minting again for the same host replaces its unused token; once the host registered, no new token', async () => {
        const { ledger } = setup();
        const first = await issue(ledger);
        const second = await issue(ledger);
        expect(second.r).toBe('issued');
        expect(await ledger.redeem(first.token)).toEqual({ ok: false, reason: 'unknown_or_used' });
        expect((await ledger.redeem(second.token)).ok).toBe(true);
        expect((await issue(ledger)).r).toBe('already_registered');
    });

    it('lives at most an hour, and only its hash is stored', async () => {
        const { store, ledger } = setup();
        const { token, tokenHash } = await issue(ledger, { ttlMs: 10 * FLEET_TOKEN_MAX_TTL_MS });
        expect(Date.parse(store.records.get(tokenHash)!.expiresAt) - now.getTime()).toBe(FLEET_TOKEN_MAX_TTL_MS);
        expect(tokenHash).toBe(hashFleetToken(token));
        expect(JSON.stringify([...store.records.values()])).not.toContain(token);
    });
});
