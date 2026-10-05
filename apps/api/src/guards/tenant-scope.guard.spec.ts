import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { TenantScopeGuard } from './tenant-scope.guard';

const teamOrganizations: Record<string, string> = {
    'team-own': 'org-own',
    'team-other': 'org-other',
};

describe('TenantScopeGuard', () => {
    const findOneOrganizationIdByTeamId = jest.fn(
        async (teamId: string) => teamOrganizations[teamId],
    );
    const guard = new TenantScopeGuard({
        findOneOrganizationIdByTeamId,
    } as any);

    const run = (request: Record<string, unknown>) =>
        guard.canActivate({
            switchToHttp: () => ({
                getRequest: () => ({
                    user: { organization: { uuid: 'org-own' } },
                    params: {},
                    query: {},
                    body: {},
                    ...request,
                }),
            }),
        } as any);

    beforeEach(() => jest.clearAllMocks());

    it.each([
        ['query.teamId', { query: { teamId: 'team-other' } }],
        ['body.teamId', { body: { teamId: 'team-other' } }],
        ['params.teamId', { params: { teamId: 'team-other' } }],
        [
            'body.organizationAndTeamData.teamId',
            {
                body: {
                    organizationAndTeamData: {
                        organizationId: 'org-own',
                        teamId: 'team-other',
                    },
                },
            },
        ],
        ['an unknown team', { query: { teamId: 'team-missing' } }],
        ['a repeated query param', { query: { teamId: ['team-own', 'team-other'] } }],
    ])('rejects a foreign team in %s', async (_label, request) => {
        await expect(run(request)).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
        ['query.organizationId', { query: { organizationId: 'org-other' } }],
        ['body.organizationId', { body: { organizationId: 'org-other' } }],
        [
            'body.organizationAndTeamData.organizationId',
            { body: { organizationAndTeamData: { organizationId: 'org-other' } } },
        ],
    ])('rejects a foreign organization in %s', async (_label, request) => {
        await expect(run(request)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accepts the caller organization and its teams', async () => {
        await expect(
            run({
                query: { teamId: 'team-own', organizationId: 'org-own' },
                body: {
                    organizationAndTeamData: {
                        organizationId: 'org-own',
                        teamId: 'team-own',
                    },
                },
            }),
        ).resolves.toBe(true);
    });

    it('accepts requests that name no team or organization', async () => {
        await expect(run({ body: { name: 'x' } })).resolves.toBe(true);
        expect(findOneOrganizationIdByTeamId).not.toHaveBeenCalled();
    });

    it('leaves unauthenticated (@Public) requests to their own guards', async () => {
        await expect(
            run({ user: undefined, query: { teamId: 'team-other' } }),
        ).resolves.toBe(true);
    });
});
