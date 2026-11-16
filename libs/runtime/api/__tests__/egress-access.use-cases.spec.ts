import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { RECOMMENDED_EGRESS_VERSION } from '@libs/runtime/protocol/egress-catalog';

import { RuntimeEgressAccess } from '../application/egress-access.service';
import { ApproveEgressUseCase } from '../application/use-cases/approve-egress.use-case';
import { OrgEgressUseCases, RevokeEgressUseCase } from '../application/use-cases/egress-access.use-cases';
import type { EgressSettingsRow, RuntimeEgressReader, RuntimeEnvironmentRef } from '../domain/ports';
import { clock, config, FakeOutbox, ORG, OTHER_REPO, realAuthorization, REPO, TEAM, user } from './fixtures';

// docs/runtime/egress-allowlist.md §9: one click approves reads only, full access is asked for, the org list and the
// settings are the owner's, and who may add a host to an environment is the org's choice (D3).

const owner = user(Role.OWNER);
const repoAdmin = user(Role.REPO_ADMIN);
const contributor = user(Role.CONTRIBUTOR);
const env: RuntimeEnvironmentRef = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO };
const otherRepoEnv: RuntimeEnvironmentRef = { environmentId: 'env-2', organizationId: ORG, teamId: TEAM, repositoryId: OTHER_REPO };

function rig(settings: EgressSettingsRow = { recommendedEnabled: true, whoMayAdd: 'owners' }) {
    const outbox = new FakeOutbox();
    const authorization = realAuthorization();
    const reader: RuntimeEgressReader = {
        blockedForRuns: async () => [],
        approvals: async (_org, scope) => (scope === '*' ? [{ host: 'cdn.vendor.example', mode: 'inspected', pathPrefixes: ['/dist/'] }] : []),
        settings: async () => settings,
        audit: async () => [{ action: 'approve', host: 'cdn.vendor.example', actor: 'user-owner', source: 'settings', at: '2026-11-13T10:00:00.000Z' }],
    };
    const access = new RuntimeEgressAccess(authorization, reader);
    const environments = { get: async (org: string, id: string) => [env, otherRepoEnv].find((e) => e.organizationId === org && e.environmentId === id) ?? null };
    const approve = new ApproveEgressUseCase({ get: async () => null }, environments, authorization, outbox as any, config(), clock, undefined, access);
    const revoke = new RevokeEgressUseCase({ get: async () => null }, environments, access, outbox as any, clock);
    const org = new OrgEgressUseCases(authorization, access, outbox as any, clock, reader);
    return { outbox, approve, revoke, org, reader };
}

const payload = (o: FakeOutbox, i = 0) => o.rows[i].payload.payload;

describe('egress approval tiers', () => {
    it('approves inspected under every path by default, and full access only when asked', async () => {
        const r = rig();
        await expect(r.approve.execute({ user: owner, environmentId: 'env-1', host: 'cdn.vendor.example' })).resolves.toMatchObject({ mode: 'inspected', pathPrefixes: ['/'] });
        expect(payload(r.outbox)).toMatchObject({ mode: 'inspected', pathPrefixes: ['/'], source: 'blocker' });
        await r.approve.execute({ user: owner, environmentId: 'env-1', host: 'api.vendor.example', mode: 'passthrough', source: 'settings', reason: 'webhooks' });
        expect(payload(r.outbox, 1)).toMatchObject({ mode: 'passthrough', source: 'settings', reason: 'webhooks' });
        expect(payload(r.outbox, 1)).not.toHaveProperty('pathPrefixes');
    });

    it('takes path prefixes that start with / and refuses dot segments', async () => {
        const r = rig();
        await r.approve.execute({ user: owner, environmentId: 'env-1', host: 'cdn.sheetjs.com', pathPrefixes: ['/xlsx-'] });
        expect(payload(r.outbox)).toMatchObject({ pathPrefixes: ['/xlsx-'] });
        await expect(r.approve.execute({ user: owner, environmentId: 'env-1', host: 'cdn.sheetjs.com', pathPrefixes: ['xlsx-'] })).rejects.toBeInstanceOf(BadRequestException);
        await expect(r.approve.execute({ user: owner, environmentId: 'env-1', host: 'cdn.sheetjs.com', pathPrefixes: ['/a/../b'] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('the org list is the owner\'s alone', async () => {
        const r = rig({ recommendedEnabled: true, whoMayAdd: 'owners_and_repo_admins' });
        await expect(r.approve.execute({ user: owner, environmentId: '*', host: 'cdn.vendor.example' })).resolves.toMatchObject({ environmentId: '*' });
        await expect(r.approve.execute({ user: repoAdmin, environmentId: '*', host: 'cdn.vendor.example' })).rejects.toBeInstanceOf(ForbiddenException);
    });
});

describe('D3 who may add a host to an environment', () => {
    it('owners only: a repo admin is refused', async () => {
        const r = rig();
        await expect(r.approve.execute({ user: repoAdmin, environmentId: 'env-1', host: 'a.vendor.example' })).rejects.toBeInstanceOf(ForbiddenException);
        expect(r.outbox.rows).toHaveLength(0);
    });

    it("owners and repo admins: the repo admin of the environment's repository may, of another one may not, a contributor never", async () => {
        const r = rig({ recommendedEnabled: true, whoMayAdd: 'owners_and_repo_admins' });
        await expect(r.approve.execute({ user: repoAdmin, environmentId: 'env-1', host: 'a.vendor.example' })).resolves.toMatchObject({ host: 'a.vendor.example' });
        await expect(r.approve.execute({ user: repoAdmin, environmentId: 'env-2', host: 'a.vendor.example' })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(r.approve.execute({ user: contributor, environmentId: 'env-1', host: 'a.vendor.example' })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(r.revoke.execute({ user: repoAdmin, environmentId: 'env-1', host: 'a.vendor.example' })).resolves.toMatchObject({ host: 'a.vendor.example' });
    });

    it('nobody: even an owner adds hosts in the org list only', async () => {
        const r = rig({ recommendedEnabled: true, whoMayAdd: 'nobody' });
        await expect(r.approve.execute({ user: owner, environmentId: 'env-1', host: 'a.vendor.example' })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(r.approve.execute({ user: owner, environmentId: '*', host: 'a.vendor.example' })).resolves.toMatchObject({ environmentId: '*' });
    });
});

describe('revocation (G3)', () => {
    it('sends the revocation through the outbox with who and when', async () => {
        const r = rig();
        await expect(r.revoke.execute({ user: owner, environmentId: 'env-1', host: 'Cdn.Vendor.Example', reason: 'not needed' })).resolves.toMatchObject({ host: 'cdn.vendor.example' });
        expect(r.outbox.events).toEqual(['runtime.environment.egress_revoked']);
        expect(payload(r.outbox)).toMatchObject({ environmentId: 'env-1', host: 'cdn.vendor.example', revokedBy: { userId: owner.uuid }, reason: 'not needed' });
    });
});

describe('org outbound access (D2, D3)', () => {
    it('shows the recommended list with its version, the org list and the audit', async () => {
        const r = rig();
        const view = await r.org.get(contributor);
        expect(view.recommended.version).toBe(RECOMMENDED_EGRESS_VERSION);
        expect(view.recommended.entries.find((e) => e.host === 'cdn.sheetjs.com')).toMatchObject({ tier: 'inspected', paths: ['/xlsx-'] });
        expect(view.orgList).toEqual([{ host: 'cdn.vendor.example', mode: 'inspected', pathPrefixes: ['/dist/'] }]);
        expect(view.settings).toEqual({ recommendedEnabled: true, whoMayAdd: 'owners' });
        expect(view.audit).toHaveLength(1);
    });

    it('fails when the org list or the audit cannot be read, instead of showing them empty', async () => {
        for (const broken of ['approvals', 'audit'] as const) {
            const r = rig();
            jest.spyOn(r.reader, broken).mockRejectedValue(new Error('runtime db down'));
            await expect(r.org.get(contributor)).rejects.toThrow('runtime db down');
        }
    });

    it('lets an owner turn the recommended list off and change who may add hosts; nobody else', async () => {
        const r = rig();
        await expect(r.org.update(owner, { recommendedEnabled: false })).resolves.toMatchObject({ recommendedEnabled: false, whoMayAdd: 'owners' });
        expect(r.outbox.events).toEqual(['runtime.org.egress_settings_changed']);
        await expect(r.org.update(repoAdmin, { recommendedEnabled: true })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(r.org.update(owner, { whoMayAdd: 'everyone' })).rejects.toBeInstanceOf(BadRequestException);
    });
});
