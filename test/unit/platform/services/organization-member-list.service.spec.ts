import { Test, TestingModule } from '@nestjs/testing';

import { OrganizationMemberListService } from '@libs/platform/application/services/organization-member-list.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('OrganizationMemberListService', () => {
    let service: OrganizationMemberListService;
    let mockCodeManagementService: {
        getListMembers: jest.Mock;
        getPullRequestAuthors: jest.Mock;
    };

    const organizationAndTeamData = {
        organizationId: 'org-uuid-123',
        teamId: 'team-uuid-456',
    };

    beforeEach(async () => {
        mockCodeManagementService = {
            getListMembers: jest.fn(),
            getPullRequestAuthors: jest.fn().mockResolvedValue([]),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                OrganizationMemberListService,
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
            ],
        }).compile();

        service = module.get(OrganizationMemberListService);
    });

    describe('when the provider answers', () => {
        it('returns the normalized members with an ok status', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 2, name: 'Bob' },
                { id: 1, name: 'Alice' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({
                status: 'ok',
                members: [
                    { id: 1, name: 'Alice', type: 'user' },
                    { id: 2, name: 'Bob', type: 'user' },
                ],
            });
        });

        it('deduplicates members by id, keeping the first occurrence', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
                { id: 1, name: 'Alice Duplicate' },
                { id: 2, name: 'Bob' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result.members).toHaveLength(2);
            expect(result.members.find((m) => m.id === 1)?.name).toBe('Alice');
        });

        it('falls back through the provider-specific identity fields', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { descriptor: 'aad.abc', displayName: 'Azure Person' },
                { uuid: 'bb-1', login: 'bitbucket-person' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result.members).toEqual([
                { id: 'aad.abc', name: 'Azure Person', type: 'user' },
                { id: 'bb-1', name: 'bitbucket-person', type: 'user' },
            ]);
        });
    });

    // Every provider models membership differently and each of them misses
    // somebody who can still open a pull request — the owner of a personal
    // account with no organization, an outside collaborator, an app that
    // authors PRs. Unioning recent PR authors gives all providers the same
    // floor, so a seat can always be assigned to whoever triggers a review.
    describe('pull request author union', () => {
        it('includes an app author the member list never reports, so it can be granted a seat', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue([
                { id: '99', name: 'ci-agent', type: 'bot' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({
                status: 'ok',
                members: [
                    { id: 1, name: 'Alice', type: 'user' },
                    { id: '99', name: 'ci-agent', type: 'bot' },
                ],
            });
            expect(
                mockCodeManagementService.getPullRequestAuthors,
            ).toHaveBeenCalledWith({
                organizationAndTeamData,
                determineBots: true,
            });
        });

        // GitLab only resolves whether a member is a bot when asked; without
        // the flag every GitLab bot comes back typed as a user, so it would
        // never get a badge nor be shielded from seat pruning.
        it('asks the provider to identify bots in the member list too', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);

            await service.fetch(organizationAndTeamData);

            expect(
                mockCodeManagementService.getListMembers,
            ).toHaveBeenCalledWith({
                organizationAndTeamData,
                determineBots: true,
            });
        });

        it('carries the list when only the authors resolve — a personal account with no organization', async () => {
            mockCodeManagementService.getListMembers.mockRejectedValue(
                new Error('account belongs to no organization'),
            );
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue([
                { id: '4242', name: 'personal-owner' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({
                status: 'ok',
                members: [{ id: '4242', name: 'personal-owner', type: 'user' }],
            });
        });

        it('stays ok when the author lookup fails but the members resolve', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCodeManagementService.getPullRequestAuthors.mockRejectedValue(
                new Error('rate limited'),
            );

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({
                status: 'ok',
                members: [{ id: 1, name: 'Alice', type: 'user' }],
            });
        });

        it('keeps the member-list entry when both sources report the same person', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice Doe' },
            ]);
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue([
                { id: '1', name: 'alice' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result.members).toEqual([
                { id: 1, name: 'Alice Doe', type: 'user' },
            ]);
        });
    });

    describe('when the member list cannot be trusted', () => {
        it('reports unavailable when every source throws', async () => {
            mockCodeManagementService.getListMembers.mockRejectedValue(
                new Error('token expired'),
            );
            mockCodeManagementService.getPullRequestAuthors.mockRejectedValue(
                new Error('token expired'),
            );

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({ status: 'unavailable', members: [] });
        });

        it('reports unavailable when the members throw and no author is left to fall back on', async () => {
            mockCodeManagementService.getListMembers.mockRejectedValue(
                new Error('token expired'),
            );

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({ status: 'unavailable', members: [] });
        });

        it('reports unavailable when the provider returns an empty list', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({ status: 'unavailable', members: [] });
        });

        it('reports unavailable when the provider returns a non-array', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue(null);

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({ status: 'unavailable', members: [] });
        });

        it('reports unavailable when every entry is missing an id or a name', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { name: 'No id at all' },
                { id: 7 },
                null,
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({ status: 'unavailable', members: [] });
        });
    });
});
