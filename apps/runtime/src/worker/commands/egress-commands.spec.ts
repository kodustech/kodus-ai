import { RuntimeCommandName } from '@libs/runtime/contracts/runtime-commands';
import { RECOMMENDED_EGRESS_VERSION } from '@libs/runtime/protocol/egress-catalog';

import { EgressApprovedHandler, EgressRevokedHandler, EgressSettingsChangedHandler } from './command-handlers';
import { InMemoryCommandStore } from '../../shared/persistence/testing';

// docs/runtime/egress-allowlist.md §9: approvals carry their tier, revocation (G3) takes a host out of every live
// claim of its scope, and each change is one audit row (G4).

const actor = { userId: 'owner-1' };
const approve = (over: Record<string, unknown> = {}) => ({
    environmentId: 'env-1', organizationId: 'org-a', host: 'cdn.vendor.example', approvedBy: actor, approvedAt: '2026-11-13T10:00:00.000Z',
    mode: 'inspected', pathPrefixes: ['/dist/'], source: 'blocker', sourceRef: 'egress:cdn.vendor.example@setup-1', key: 'env-1:cdn.vendor.example', ...over,
});
const revoke = (over: Record<string, unknown> = {}) => ({
    environmentId: 'env-1', organizationId: 'org-a', host: 'cdn.vendor.example', revokedBy: actor, revokedAt: '2026-11-13T11:00:00.000Z', key: 'env-1:cdn.vendor.example', ...over,
});

function rig() {
    const commands = new InMemoryCommandStore();
    const pushed: Array<{ env: string; allow: string[] }> = [];
    const egress = { push: async (_org: string, env: string, allow: string[]) => void pushed.push({ env, allow }) };
    return {
        commands, pushed,
        approved: new EgressApprovedHandler(commands, egress),
        revoked: new EgressRevokedHandler(commands, egress),
        settings: new EgressSettingsChangedHandler(commands),
    };
}

describe('egress commands', () => {
    it('records an inspected approval with its paths, audits it with the recommended version, and pushes the list', async () => {
        const r = rig();
        expect(await r.approved.handle(approve())).toBeUndefined();
        expect(r.commands.egress).toEqual([expect.objectContaining({ host: 'cdn.vendor.example', mode: 'inspected', pathPrefixes: ['/dist/'], source: 'blocker' })]);
        expect(r.commands.egressAudit).toEqual([
            expect.objectContaining({ action: 'approve', mode: 'inspected', actor: 'owner-1', sourceRef: 'egress:cdn.vendor.example@setup-1', recommendedVersion: RECOMMENDED_EGRESS_VERSION }),
        ]);
        expect(r.pushed).toEqual([{ env: 'env-1', allow: ['cdn.vendor.example'] }]);
    });

    it('takes an approval from a worker-era API (no mode) as passthrough', async () => {
        const r = rig();
        const { mode: _m, pathPrefixes: _p, source: _s, sourceRef: _r, ...old } = approve();
        expect(await r.approved.handle(old)).toBeUndefined();
        expect(r.commands.egress[0]).toMatchObject({ mode: 'passthrough' });
    });

    it('refuses an inspected approval without paths', async () => {
        const r = rig();
        expect(await r.approved.handle(approve({ pathPrefixes: undefined }))).toMatchObject({ invalid: 'invalid egress approval' });
    });

    // S-55 (the product's side): a revoked host leaves the list every live claim of the scope gets.
    it('S-55 revokes: the host leaves the pushed list, and the audit says who and when', async () => {
        const r = rig();
        await r.approved.handle(approve());
        await r.approved.handle(approve({ host: 'api.vendor.example', mode: 'passthrough', pathPrefixes: undefined, key: 'env-1:api.vendor.example' }));
        expect(await r.revoked.handle(revoke())).toBeUndefined();
        expect(r.pushed.at(-1)).toEqual({ env: 'env-1', allow: ['api.vendor.example'] });
        expect(r.commands.egressAudit.at(-1)).toMatchObject({ action: 'revoke', actor: 'owner-1', host: 'cdn.vendor.example', at: '2026-11-13T11:00:00.000Z', detail: { revoked: true } });
    });

    it('a replayed approval older than the revocation does not bring the host back; a new one does', async () => {
        const r = rig();
        await r.approved.handle(approve());
        await r.revoked.handle(revoke());
        await r.approved.handle(approve()); // the outbox delivers the old approval again
        expect(await r.commands.approvedHosts('org-a', 'env-1')).toEqual([]);
        await r.approved.handle(approve({ approvedAt: '2026-11-13T12:00:00.000Z' }));
        expect(await r.commands.approvedHosts('org-a', 'env-1')).toEqual(['cdn.vendor.example']);
    });

    it('the org list reaches every environment but never a sandbox (G5)', async () => {
        const r = rig();
        await r.approved.handle(approve({ environmentId: '*', key: '*:cdn.vendor.example' }));
        expect(r.pushed.at(-1)).toEqual({ env: '*', allow: ['cdn.vendor.example'] });
        expect(await r.commands.approvedHosts('org-a', 'env-2')).toEqual(['cdn.vendor.example']);
        expect(await r.commands.approvedHosts('org-a', 'sandbox')).toEqual([]);
        expect(await r.commands.approvedHosts('org-b', 'env-2')).toEqual([]);
    });

    it('records the org settings (D2, D3) once per change and keeps the newest', async () => {
        const r = rig();
        const change = { organizationId: 'org-a', recommendedEnabled: false, whoMayAdd: 'owners_and_repo_admins', changedBy: actor, changedAt: '2026-11-13T10:00:00.000Z', key: 'settings:1' };
        expect(await r.settings.handle(change)).toBeUndefined();
        await r.settings.handle(change);
        await r.settings.handle({ ...change, recommendedEnabled: true, changedAt: '2026-11-13T09:00:00.000Z', key: 'settings:0' });
        expect(r.commands.egressSettings.get('org-a')).toMatchObject({ recommendedEnabled: false, whoMayAdd: 'owners_and_repo_admins' });
        expect(r.commands.egressAudit.filter((a) => a.action === 'settings')).toHaveLength(2);
        expect(RuntimeCommandName.EgressSettingsChanged).toBe('runtime.org.egress_settings_changed');
    });
});
