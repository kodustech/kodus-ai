import { BadRequestException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { ApproveEgressUseCase } from '../application/use-cases/approve-egress.use-case';
import {
    CreateCellRegistrationTokenUseCase,
    ListRuntimeCellsUseCase,
    RevokeRuntimeCellUseCase,
} from '../application/use-cases/cells.use-cases';
import { SetTeamKeyRepositoriesUseCase } from '../application/use-cases/set-team-key-repositories.use-case';
import { StopRuntimeUseCase } from '../application/use-cases/stop-runtime.use-case';
import { CELL_TOKEN_TTL_MS, CellTokenLedger, InMemoryCellTokenStore } from '../domain/cell-token';
import type { RuntimeCell, RuntimeCellReader, RuntimeEnvironmentRef } from '../domain/ports';
import { clock, config, FakeOutbox, NOW, ORG, OTHER_ORG, OTHER_REPO, realAuthorization, REPO, TEAM, user } from './fixtures';

const owner = user(Role.OWNER);
const outsider = user(Role.OWNER, { org: OTHER_ORG, uuid: 'outsider' });
const oncall = user(Role.OWNER, { uuid: 'oncall-1' });

describe('Egress approval', () => {
    const env: RuntimeEnvironmentRef = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO };
    const setup = (cfg = config()) => {
        const outbox = new FakeOutbox();
        const uc = new ApproveEgressUseCase(
            // No product row: the environment is one only Runs know (the reader's fallback).
            { get: async () => null },
            { get: async (org, id) => (org === env.organizationId && id === env.environmentId ? env : null) },
            realAuthorization(),
            outbox as any,
            cfg,
            clock,
        );
        return { outbox, uc };
    };

    it('approves one normalized domain for the environment, through the outbox', async () => {
        const { outbox, uc } = setup();
        await expect(uc.execute({ user: owner, environmentId: 'env-1', host: 'Registry.Example.COM' })).resolves.toMatchObject({
            host: 'registry.example.com',
        });
        expect(outbox.events).toEqual(['runtime.environment.egress_approved']);
        expect(outbox.rows[0].payload.payload).toMatchObject({ environmentId: 'env-1', key: 'env-1:registry.example.com' });
    });

    it('refuses a denylisted host (default and configured) with 422 and writes nothing', async () => {
        const { outbox, uc } = setup(config({ egressDenylist: ['*.evil.example'] }));
        await expect(uc.execute({ user: owner, environmentId: 'env-1', host: 'api.anthropic.com' })).rejects.toBeInstanceOf(UnprocessableEntityException);
        await expect(uc.execute({ user: owner, environmentId: 'env-1', host: 'x.pastebin.com' })).rejects.toBeInstanceOf(UnprocessableEntityException);
        await expect(uc.execute({ user: owner, environmentId: 'env-1', host: 'a.evil.example' })).rejects.toBeInstanceOf(UnprocessableEntityException);
        await expect(uc.execute({ user: owner, environmentId: 'env-1', host: '169.254.169.254' })).rejects.toBeInstanceOf(BadRequestException);
        expect(outbox.rows).toHaveLength(0);
    });

    it('approves egress for an environment the product knows before any Run used it', async () => {
        const outbox = new FakeOutbox();
        const product = { environmentId: 'env-new', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', state: 'setup_requested' as const, createdAt: '', updatedAt: '' };
        const uc = new ApproveEgressUseCase(
            { get: async (org, id) => (org === ORG && id === 'env-new' ? product : null) },
            { get: async () => null },
            realAuthorization(),
            outbox as any,
            config(),
            clock,
        );
        await expect(uc.execute({ user: owner, environmentId: 'env-new', host: 'registry.example.com' })).resolves.toMatchObject({ environmentId: 'env-new' });
        await expect(uc.execute({ user: outsider, environmentId: 'env-new', host: 'registry.example.com' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404 for an environment of another org or an unknown one', async () => {
        const { uc } = setup();
        await expect(uc.execute({ user: outsider, environmentId: 'env-1', host: 'registry.example.com' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(uc.execute({ user: owner, environmentId: 'env-x', host: 'registry.example.com' })).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('Stop button', () => {
    it('org scope for the org admin; global only for the Kodus on-call', async () => {
        const outbox = new FakeOutbox();
        const uc = new StopRuntimeUseCase(outbox as any, config(), clock);
        await expect(uc.execute({ user: owner, scope: 'org' })).resolves.toMatchObject({ scope: 'org' });
        expect(outbox.rows[0].payload.payload).toMatchObject({ scope: 'org', organizationId: ORG });
        await expect(uc.execute({ user: owner, scope: 'global' })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(uc.execute({ user: oncall, scope: 'global' })).resolves.toMatchObject({ scope: 'global' });
        expect(outbox.rows[1].payload.payload).not.toHaveProperty('organizationId');
        await expect(uc.execute({ user: owner, scope: 'everything' })).rejects.toBeInstanceOf(BadRequestException);
        expect(outbox.events).toEqual(['runtime.stop.requested', 'runtime.stop.requested']);
    });
});

describe('Cells', () => {
    const cells: RuntimeCell[] = [
        { cellId: 'cell-a', organizationId: ORG, owner: 'customer', topology: 'hybrid', status: 'connected' },
        { cellId: 'cell-b', organizationId: OTHER_ORG, owner: 'customer', topology: 'hybrid', status: 'connected' },
        { cellId: 'cell-m', organizationId: null, owner: 'kodus', topology: 'managed', status: 'connected' },
        { cellId: 'cell-r', organizationId: ORG, owner: 'customer', topology: 'self_hosted', status: 'revoked' },
    ];
    const reader: RuntimeCellReader = {
        listByOrganization: async (org) => cells.filter((c) => c.organizationId === org),
        listManaged: async () => cells.filter((c) => c.owner === 'kodus' && c.status !== 'revoked'),
        get: async (id) => cells.find((c) => c.cellId === id) ?? null,
    };

    it('issues a token that only the hash leaves, redeemable once within 15 minutes for that topology', async () => {
        const outbox = new FakeOutbox();
        const uc = new CreateCellRegistrationTokenUseCase(outbox as any, clock);
        const res = await uc.execute({ user: owner, topology: 'hybrid' });
        expect(res.token).toMatch(/^kcr_/);
        expect(Date.parse(res.expiresAt) - NOW.getTime()).toBe(CELL_TOKEN_TTL_MS);
        const issued = outbox.rows[0].payload.payload;
        expect(JSON.stringify(outbox.rows)).not.toContain(res.token);
        expect(issued).toMatchObject({ organizationId: ORG, topology: 'hybrid' });

        // The Runtime side applies the message and redeems with the shared ledger.
        const store = new InMemoryCellTokenStore();
        let now = NOW;
        const ledger = new CellTokenLedger(store, () => now);
        await ledger.record({ tokenHash: issued.tokenHash, organizationId: ORG, topology: 'hybrid', expiresAt: issued.expiresAt, issuedBy: owner.uuid });
        now = new Date(NOW.getTime() + CELL_TOKEN_TTL_MS - 1);
        expect(await ledger.redeem(res.token, 'hybrid')).toEqual({ ok: true, organizationId: ORG, topology: 'hybrid' });
        expect(await ledger.redeem(res.token, 'hybrid')).toEqual({ ok: false, reason: 'unknown_or_used' });

        await expect(uc.execute({ user: owner, topology: 'mars' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lists the org cells and the managed fleet as one "Kodus cloud" entry, nothing of another org', async () => {
        const uc = new ListRuntimeCellsUseCase(reader);
        const listed = await uc.execute({ user: owner });
        expect(listed.map((c) => c.cellId)).toEqual(['kodus-cloud', 'cell-a', 'cell-r']);
        expect(listed[0]).toEqual({ cellId: 'kodus-cloud', name: 'Kodus cloud', organizationId: null, owner: 'kodus', topology: 'managed', status: 'connected' });
        // No managed cell id, serial or heartbeat leaves; the other org's cell never shows.
        expect(JSON.stringify(listed)).not.toContain('cell-m');
        expect(JSON.stringify(listed)).not.toContain('cell-b');
        expect((await uc.execute({ user: user(Role.OWNER, { org: OTHER_ORG, uuid: 'o2' }) })).map((c) => c.cellId)).toEqual(['kodus-cloud', 'cell-b']);
    });

    it('a managed cell row that claims an org never shows as that org\'s own cell; no live managed cell = no Kodus cloud entry', async () => {
        const odd: RuntimeCell[] = [{ cellId: 'cell-m2', organizationId: ORG, owner: 'kodus', topology: 'managed', status: 'disconnected' }];
        const uc = new ListRuntimeCellsUseCase({ listByOrganization: async () => odd, listManaged: async () => odd, get: async () => null });
        expect(await uc.execute({ user: owner })).toEqual([
            { cellId: 'kodus-cloud', name: 'Kodus cloud', organizationId: null, owner: 'kodus', topology: 'managed', status: 'disconnected' },
        ]);
        const none = new ListRuntimeCellsUseCase({ listByOrganization: async () => [], listManaged: async () => [], get: async () => null });
        expect(await none.execute({ user: owner })).toEqual([]);
    });

    it('revokes an org cell; another org cell is 404; a managed cell only for on-call', async () => {
        const outbox = new FakeOutbox();
        const uc = new RevokeRuntimeCellUseCase(reader, outbox as any, config(), clock);
        await expect(uc.execute({ user: owner, cellId: 'cell-a' })).resolves.toMatchObject({ status: 'revoke_requested' });
        await expect(uc.execute({ user: owner, cellId: 'cell-b' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(uc.execute({ user: owner, cellId: 'cell-m' })).rejects.toBeInstanceOf(NotFoundException);
        // A managed cell is the ops route's: refused on the org route even for on-call.
        await expect(uc.execute({ user: oncall, cellId: 'cell-m' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(uc.execute({ user: owner, cellId: 'cell-m', scope: 'ops' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(uc.execute({ user: oncall, cellId: 'cell-m', scope: 'ops' })).resolves.toMatchObject({ status: 'revoke_requested' });
        await expect(uc.execute({ user: oncall, cellId: 'cell-a', scope: 'ops' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(uc.execute({ user: owner, cellId: 'cell-r' })).resolves.toEqual({ cellId: 'cell-r', status: 'revoked' });
        expect(outbox.events).toEqual(['runtime.cell.revoke_requested', 'runtime.cell.revoke_requested']);
        expect(outbox.rows[1].payload.payload).not.toHaveProperty('organizationId');
    });
});

describe('Team key repositories', () => {
    const setup = () => {
        const updates: any[] = [];
        const keys = {
            findById: async (id: string) =>
                ({
                    'key-a': { uuid: 'key-a', team: { uuid: TEAM }, config: { capabilities: ['runs:read'] } },
                    'key-b': { uuid: 'key-b', team: { uuid: 'team-b' }, config: {} },
                })[id] as any,
            update: async (filter: any, data: any) => {
                updates.push({ filter, data });
                return { uuid: filter.uuid, config: data.config } as any;
            },
        };
        const teams = { findOneOrganizationIdByTeamId: async (t: string) => (t === TEAM ? ORG : OTHER_ORG) };
        const repos = { listRepositoryIds: async () => [REPO, OTHER_REPO] };
        return { updates, uc: new SetTeamKeyRepositoriesUseCase(keys, teams, repos) };
    };

    it('replaces the repo list, deduplicated, keeping the capabilities', async () => {
        const { updates, uc } = setup();
        await expect(uc.execute({ user: owner, keyId: 'key-a', repositoryIds: [REPO, REPO, OTHER_REPO] })).resolves.toEqual({
            uuid: 'key-a',
            repositoryIds: [REPO, OTHER_REPO],
        });
        expect(updates[0].data.config).toEqual({ capabilities: ['runs:read'], repositoryIds: [REPO, OTHER_REPO] });
    });

    it('404 for a key of another org; 400 for repos the team does not have or a bad body', async () => {
        const { updates, uc } = setup();
        await expect(uc.execute({ user: owner, keyId: 'key-b', repositoryIds: [REPO] })).rejects.toBeInstanceOf(NotFoundException);
        await expect(uc.execute({ user: owner, keyId: 'missing', repositoryIds: [REPO] })).rejects.toBeInstanceOf(NotFoundException);
        await expect(uc.execute({ user: owner, keyId: 'key-a', repositoryIds: ['repo-9'] })).rejects.toThrow('repo-9');
        await expect(uc.execute({ user: owner, keyId: 'key-a', repositoryIds: 'repo-1' })).rejects.toBeInstanceOf(BadRequestException);
        expect(updates).toHaveLength(0);
    });
});
