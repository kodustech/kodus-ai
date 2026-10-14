import {
    ForbiddenException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';

import { McpPrincipal, toMcpAuthInfo } from './mcp-principal';
import { McpToolAuthorizer } from './mcp-tool-authorizer.service';

const teamOrganizations: Record<string, string> = {
    'team-1': 'org-1',
    'team-2': 'org-1',
    'foreign-team': 'victim-org',
};

const extraFor = (principal: McpPrincipal) => ({
    authInfo: toMcpAuthInfo('token', principal),
});
const service = extraFor({ kind: 'service', organizationId: 'org-1' });
const teamKey = (capabilities: string[] = []) =>
    extraFor({
        kind: 'team-key',
        organizationId: 'org-1',
        teamId: 'team-1',
        config: { capabilities: capabilities as any },
    });

describe('McpToolAuthorizer', () => {
    const authorizer = new McpToolAuthorizer({
        findOneOrganizationIdByTeamId: jest.fn(
            async (teamId: string) => teamOrganizations[teamId],
        ),
    } as any);

    it('rejects a call without an authenticated principal', async () => {
        await expect(
            authorizer.authorize('KODUS_GET_KODY_RULES', {}, {}),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('fills the organization from the credential when absent', async () => {
        await expect(
            authorizer.authorize(
                'KODUS_DELETE_KODY_ISSUE',
                { issueId: 'i-1' },
                service,
            ),
        ).resolves.toEqual({ issueId: 'i-1', organizationId: 'org-1' });
    });

    it('rejects an organization different from the credential', async () => {
        await expect(
            authorizer.authorize(
                'KODUS_GET_KODY_RULES',
                { organizationId: 'victim-org' },
                service,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
        ['top-level teamId', { teamId: 'foreign-team' }],
        ['kodyRule.teamId', { kodyRule: { teamId: 'foreign-team' } }],
        ['an unknown team', { teamId: 'missing' }],
    ])(
        'rejects a service call naming %s outside the organization',
        async (_l, args) => {
            await expect(
                authorizer.authorize('KODUS_LIST_REPOSITORIES', args, service),
            ).rejects.toBeInstanceOf(NotFoundException);
        },
    );

    it('lets a service call name any team of its organization', async () => {
        await expect(
            authorizer.authorize(
                'KODUS_LIST_REPOSITORIES',
                { teamId: 'team-2' },
                service,
            ),
        ).resolves.toEqual({ teamId: 'team-2', organizationId: 'org-1' });
    });

    it('keeps a team key on its own team, even inside the same organization', async () => {
        await expect(
            authorizer.authorize(
                'KODUS_LIST_REPOSITORIES',
                { teamId: 'team-2' },
                teamKey(),
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            authorizer.authorize(
                'KODUS_LIST_REPOSITORIES',
                { teamId: 'team-1' },
                teamKey(),
            ),
        ).resolves.toEqual({ teamId: 'team-1', organizationId: 'org-1' });
    });

    it.each([
        'KODUS_CREATE_KODY_RULE',
        'KODUS_UPDATE_KODY_RULE',
        'KODUS_DELETE_KODY_RULE',
        'KODUS_CREATE_MEMORY',
    ])('requires kodyRules:manage on a team key for %s', async (tool) => {
        await expect(
            authorizer.authorize(tool, { ruleId: 'r-1' }, teamKey()),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            authorizer.authorize(
                tool,
                { ruleId: 'r-1' },
                teamKey(['kodyRules:manage']),
            ),
        ).resolves.toEqual({ ruleId: 'r-1', organizationId: 'org-1' });
        await expect(
            authorizer.authorize(tool, { ruleId: 'r-1' }, service),
        ).resolves.toEqual({ ruleId: 'r-1', organizationId: 'org-1' });
    });
});
