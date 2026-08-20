import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { CacheService } from '@libs/core/cache/cache.service';
import { OrganizationMemberListService } from '@libs/platform/application/services/organization-member-list.service';
import { GetCodeManagementMemberListUseCase } from '@libs/platform/application/use-cases/codeManagement/get-code-management-members-list.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('GetCodeManagementMemberListUseCase', () => {
    let useCase: GetCodeManagementMemberListUseCase;
    let mockMemberListService: { fetch: jest.Mock };
    let mockCacheService: {
        getFromCache: jest.Mock;
        addToCache: jest.Mock;
        removeFromCache: jest.Mock;
    };

    const mockMembers = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
        { id: 3, name: 'Charlie' },
    ];

    beforeEach(async () => {
        mockMemberListService = {
            fetch: jest
                .fn()
                .mockResolvedValue({ status: 'ok', members: mockMembers }),
        };

        mockCacheService = {
            getFromCache: jest.fn().mockResolvedValue(null),
            addToCache: jest.fn().mockResolvedValue(undefined),
            removeFromCache: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GetCodeManagementMemberListUseCase,
                {
                    provide: OrganizationMemberListService,
                    useValue: mockMemberListService,
                },
                {
                    provide: CacheService,
                    useValue: mockCacheService,
                },
                {
                    provide: REQUEST,
                    useValue: {
                        user: { organization: { uuid: 'org-uuid-123' } },
                    },
                },
            ],
        }).compile();

        useCase = module.get<GetCodeManagementMemberListUseCase>(
            GetCodeManagementMemberListUseCase,
        );
    });

    describe('caching', () => {
        it('should return cached members on cache hit', async () => {
            mockCacheService.getFromCache.mockResolvedValue(mockMembers);

            const result = await useCase.execute();

            expect(result).toEqual({ status: 'ok', members: mockMembers });
            expect(mockCacheService.getFromCache).toHaveBeenCalledWith(
                'org_members_org-uuid-123',
            );
            expect(mockMemberListService.fetch).not.toHaveBeenCalled();
        });

        it('should not treat cached empty array as a hit', async () => {
            mockCacheService.getFromCache.mockResolvedValue([]);

            const result = await useCase.execute();

            expect(result).toEqual({ status: 'ok', members: mockMembers });
            expect(mockMemberListService.fetch).toHaveBeenCalled();
        });

        it('should fetch from code integration on cache miss', async () => {
            mockCacheService.getFromCache.mockResolvedValue(null);

            const result = await useCase.execute();

            expect(result).toEqual({ status: 'ok', members: mockMembers });
            expect(mockMemberListService.fetch).toHaveBeenCalledWith(
                {
                    organizationId: 'org-uuid-123',
                    teamId: undefined,
                },
                {},
            );
        });

        // "Refresh members" must reach past both caches — the summary cached
        // here and the pull request author list cached inside the service.
        it('tells the service to bypass its own cache when refreshing', async () => {
            mockCacheService.getFromCache.mockResolvedValue(null);

            await useCase.refreshMembers();

            expect(mockMemberListService.fetch).toHaveBeenCalledWith(
                expect.anything(),
                { skipCache: true },
            );
        });

        it('should populate cache after fetching from code integration', async () => {
            mockCacheService.getFromCache.mockResolvedValue(null);

            await useCase.execute();

            expect(mockCacheService.addToCache).toHaveBeenCalledWith(
                'org_members_org-uuid-123',
                mockMembers,
                30 * 60 * 1000,
            );
        });

        it('should proceed with fetch when cache throws', async () => {
            mockCacheService.getFromCache.mockRejectedValue(
                new Error('Redis down'),
            );

            const result = await useCase.execute();

            expect(result).toEqual({ status: 'ok', members: mockMembers });
        });

        it('should not fail when addToCache throws', async () => {
            mockCacheService.getFromCache.mockResolvedValue(null);
            mockCacheService.addToCache.mockRejectedValue(
                new Error('Redis down'),
            );

            const result = await useCase.execute();

            expect(result).toEqual({ status: 'ok', members: mockMembers });
        });

        it('should not cache unavailable results to avoid caching transient errors', async () => {
            mockCacheService.getFromCache.mockResolvedValue(null);
            mockMemberListService.fetch.mockResolvedValue({
                status: 'unavailable',
                members: [],
            });

            await useCase.execute();

            expect(mockCacheService.addToCache).not.toHaveBeenCalled();
        });

        it('should key the cache per team when a teamId is given', async () => {
            await useCase.execute('team-1');

            expect(mockCacheService.getFromCache).toHaveBeenCalledWith(
                'org_members_org-uuid-123_team-1',
            );
        });
    });

    describe('propagating an unavailable member list', () => {
        it('should surface the unavailable status instead of an empty list', async () => {
            mockMemberListService.fetch.mockResolvedValue({
                status: 'unavailable',
                members: [],
            });

            const result = await useCase.execute();

            expect(result).toEqual({ status: 'unavailable', members: [] });
        });
    });

    describe('refreshMembers', () => {
        it('should drop the cached entry before refetching', async () => {
            await useCase.refreshMembers('team-1');

            expect(mockCacheService.removeFromCache).toHaveBeenCalledWith(
                'org_members_org-uuid-123_team-1',
            );
            expect(mockMemberListService.fetch).toHaveBeenCalled();
        });
    });
});
