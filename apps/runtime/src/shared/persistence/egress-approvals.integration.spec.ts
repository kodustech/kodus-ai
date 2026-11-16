import { Pool } from 'pg';

import { PgHubStore } from '../../hub/hub-store';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgCommandStore } from './pg-command-store';
import { ensureRuntimeSchema } from './runtime-schema';

// Opt-in: RUNTIME_IT_DATABASE_URL (locally postgres://runtime:runtime@localhost:5442/kodus_runtime_it).
// docs/runtime/egress-allowlist.md §9 on real Postgres: migration 32 over approvals made before it, the
// worker's writes and the hub's reads.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'egress_approvals');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('egress approvals, tiers and audit (real Postgres)', () => {
    let pool: Pool;
    let commands: PgCommandStore;
    let hub: PgHubStore;
    const org = 'org-egress-it';

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
        await ensureRuntimeSchema(pool);
        commands = new PgCommandStore(pool);
        hub = new PgHubStore(pool);
    });

    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    it('reads an approval written before migration 32 as passthrough', async () => {
        await pool.query(`INSERT INTO runtime.runtime_egress_approvals (environment_id, host, organization_id, approved_by, approved_at) VALUES ('env-old', 'api.old.example', $1, 'u', now())`, [org]);
        expect(await hub.approvedEgress(org, 'env-old')).toEqual({ allow: ['api.old.example'], inspect: [] });
    });

    it('gives an environment its own approvals and the org list, inspected with their paths, and never a revoked one', async () => {
        const at = (m: number) => new Date(Date.UTC(2026, 10, 13, 10, m)).toISOString();
        await commands.recordEgressApproval({ environmentId: 'env-1', host: 'cdn.vendor.example', organizationId: org, approvedBy: 'u', approvedAt: at(0), mode: 'inspected', pathPrefixes: ['/dist/'], source: 'blocker' });
        await commands.recordEgressApproval({ environmentId: '*', host: 'api.vendor.example', organizationId: org, approvedBy: 'u', approvedAt: at(1), mode: 'passthrough', source: 'settings' });
        await commands.recordEgressApproval({ environmentId: 'env-1', host: 'gone.example', organizationId: org, approvedBy: 'u', approvedAt: at(2) });
        expect(await commands.revokeEgressApproval({ environmentId: 'env-1', host: 'gone.example', organizationId: org, revokedBy: 'u', revokedAt: at(3) })).toBe(true);
        expect(await commands.revokeEgressApproval({ environmentId: 'env-1', host: 'gone.example', organizationId: org, revokedBy: 'u', revokedAt: at(4) })).toBe(false);
        // A replay of the old approval after the revoke changes nothing.
        await commands.recordEgressApproval({ environmentId: 'env-1', host: 'gone.example', organizationId: org, approvedBy: 'u', approvedAt: at(2) });
        expect(await hub.approvedEgress(org, 'env-1')).toEqual({ allow: ['api.vendor.example', 'cdn.vendor.example'], inspect: [{ host: 'cdn.vendor.example', paths: ['/dist/'] }] });
        expect(await commands.approvedHosts(org, 'env-1')).toEqual(['api.vendor.example', 'cdn.vendor.example']);
        expect(await hub.approvedEgress(org, 'sandbox')).toEqual({ allow: [], inspect: [] });
        expect(await hub.approvedEgress('org-other', 'env-1')).toEqual({ allow: [], inspect: [] });
        await hub.markEgressSent(org, 'env-1', ['cdn.vendor.example', 'api.vendor.example'], new Date(at(5)));
        const sent = await pool.query(`SELECT host, last_sent_at FROM runtime.runtime_egress_approvals WHERE organization_id = $1 AND last_sent_at IS NOT NULL ORDER BY host`, [org]);
        expect(sent.rows.map((r) => r.host)).toEqual(['api.vendor.example', 'cdn.vendor.example']);
    });

    it('audits each command once and keeps the newest org settings', async () => {
        const row = { key: 'k1', organizationId: org, environmentId: 'env-1', host: 'cdn.vendor.example', action: 'approve' as const, mode: 'inspected', pathPrefixes: ['/dist/'], actor: 'u', source: 'blocker', recommendedVersion: 1, at: new Date().toISOString() };
        await commands.recordEgressAudit(row);
        await commands.recordEgressAudit(row);
        const audit = await pool.query(`SELECT action, mode, path_prefixes, recommended_version FROM runtime.runtime_egress_audit WHERE organization_id = $1`, [org]);
        expect(audit.rows).toEqual([{ action: 'approve', mode: 'inspected', path_prefixes: ['/dist/'], recommended_version: 1 }]);
        expect(await hub.egressRecommendedEnabled(org)).toBe(true);
        await commands.recordEgressSettings({ organizationId: org, recommendedEnabled: false, whoMayAdd: 'nobody', updatedBy: 'u', updatedAt: '2026-11-13T10:00:00.000Z' });
        await commands.recordEgressSettings({ organizationId: org, recommendedEnabled: true, whoMayAdd: 'owners', updatedBy: 'u', updatedAt: '2026-11-13T09:00:00.000Z' });
        expect(await hub.egressRecommendedEnabled(org)).toBe(false);
    });
});
