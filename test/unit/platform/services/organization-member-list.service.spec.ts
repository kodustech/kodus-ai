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
    let mockCodeManagementService: { getListMembers: jest.Mock };

    const organizationAndTeamData = {
        organizationId: 'org-uuid-123',
        teamId: 'team-uuid-456',
    };

    beforeEach(async () => {
        mockCodeManagementService = { getListMembers: jest.fn() };

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
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
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
                { id: 'aad.abc', name: 'Azure Person' },
                { id: 'bb-1', name: 'bitbucket-person' },
            ]);
        });
    });

    describe('when the member list cannot be trusted', () => {
        it('reports unavailable when the provider throws', async () => {
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
