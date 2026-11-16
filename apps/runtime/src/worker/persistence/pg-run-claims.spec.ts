import { InMemoryRunClaims } from '../run/testing';
import { PgRunClaims } from './pg-run-claims';

/** A pool that records each query and answers no rows; the real rows are in hub/pg-hub-store.integration.spec.ts. */
function recordingPool() {
    const calls: { sql: string; params: unknown[] }[] = [];
    const pool = {
        query: async (sql: string, params: unknown[]) => {
            calls.push({ sql, params });
            return { rows: [] };
        },
    };
    return { calls, claims: new PgRunClaims(pool as never) };
}

describe('PgRunClaims tenant scope', () => {
    it.each<[string, (c: PgRunClaims) => Promise<unknown>]>([
        ['forRun', (c) => c.forRun('org-a', 'run-1')],
        ['egressBlocked', (c) => c.egressBlocked('org-a', ['claim-1'])],
        ['securityViolations', (c) => c.securityViolations('org-a', ['claim-1'])],
    ])('%s filters the rows by the org in the query', async (_name, read) => {
        const { calls, claims } = recordingPool();
        await read(claims);
        expect(calls).toHaveLength(1);
        const position = calls[0].params.indexOf('org-a') + 1;
        expect(position).toBeGreaterThan(0);
        expect(calls[0].sql).toMatch(new RegExp(`\\borg_id = \\$${position}(?!\\d)`));
    });
});

describe('InMemoryRunClaims tenant scope', () => {
    it("returns none of another org's claims, egress events or violations", async () => {
        const claims = new InMemoryRunClaims();
        await claims.record({ claimId: 'claim-1', cellId: 'cell-1', runId: 'run-1', organizationId: 'org-a', side: 'pr', hardExpiresAt: '2026-01-01T00:00:00.000Z' });
        claims.egress.push({ claimId: 'claim-1', host: 'telemetry.example.test', port: 443, phase: 'test' });
        claims.violations.push({ claimId: 'claim-1', side: 'pr', signature: 'bait_exfiltration' });

        expect(await claims.forRun('org-a', 'run-1')).toHaveLength(1);
        expect(await claims.egressBlocked('org-a', ['claim-1'])).toHaveLength(1);
        expect(await claims.securityViolations('org-a', ['claim-1'])).toHaveLength(1);

        expect(await claims.forRun('org-b', 'run-1')).toEqual([]);
        expect(await claims.egressBlocked('org-b', ['claim-1'])).toEqual([]);
        expect(await claims.securityViolations('org-b', ['claim-1'])).toEqual([]);
    });
});
