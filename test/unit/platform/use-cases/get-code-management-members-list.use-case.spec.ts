import { Test, TestingModule } from '@nestjs/testing';
import { REQUEST } from '@nestjs/core';
import { GetCodeManagementMemberListUseCase } from '@libs/platform/application/use-cases/codeManagement/get-code-management-members-list.use-case';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { CacheService } from '@libs/core/cache/cache.service';

jest.mock('@kodus/flow', () => ({
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
    let mockCodeManagementService: any;
    let mockPullRequestHandlerService: any;
    let mockCacheService: any;
    let mockRequest: any;

    const mockMembers = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
        { id: 3, name: 'Charlie' },
    ];

    beforeEach(async () => {
        mockCodeManagementService = {
            getListMembers: jest.fn(),
        };

        mockPullRequestHandlerService = {
            getPullRequestAuthorsWithCache: jest.fn(),
        };

        mockCacheService = {
            getFromCache: jest.fn().mockResolvedValue(null),
            addToCache: jest.fn().mockResolvedValue(undefined),
        };

        mockRequest = {
            user: {
                organization: {
                    uuid: 'org-uuid-123',
                },
            },
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GetCodeManagementMemberListUseCase,
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
                {
                    provide: PULL_REQUEST_MANAGER_SERVICE_TOKEN,
                    useValue: mockPullRequestHandlerService,
                },
                {
                    provide: CacheService,
                    useValue: mockCacheService,
                },
                {
                    provide: REQUEST,
                    useValue: mockRequest,
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

            expect(result).toEqual(mockMembers);
            expect(mockCacheService.getFromCache).toHaveBeenCalledWith(
                'org_members_org-uuid-123',
            );
            expect(
                mockCodeManagementService.getListMembers,
            ).not.toHaveBeenCalled();
        });

        it('should not treat cached empty array as a hit', async () => {
            mockCacheService.getFromCache.mockResolvedValue([]);
            mockCodeManagementService.getListMembers.mockResolvedValue(
                mockMembers,
            );

            const result = await useCase.execute();

            expect(result).toEqual(mockMembers);
            expect(mockCodeManagementService.getListMembers).toHaveBeenCalled();
        });

        it('should fetch from code integration on cache miss', async () => {
            mockCacheService.getFromCache.mockResolvedValue(null);
            mockCodeManagementService.getListMembers.mockResolvedValue(
                mockMembers,
            );

            const result = await useCase.execute();

            expect(result).toEqual(mockMembers);
            expect(mockCodeManagementService.getListMembers).toHaveBeenCalled();
        });

        it('should populate cache after fetching from code integration', async () => {
            mockCacheService.getFromCache.mockResolvedValue(null);
            mockCodeManagementService.getListMembers.mockResolvedValue(
                mockMembers,
            );

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
            mockCodeManagementService.getListMembers.mockResolvedValue(
                mockMembers,
            );

            const result = await useCase.execute();

            expect(result).toEqual(mockMembers);
        });

        it('should not fail when addToCache throws', async () => {
            mockCacheService.getFromCache.mockResolvedValue(null);
            mockCodeManagementService.getListMembers.mockResolvedValue(
                mockMembers,
            );
            mockCacheService.addToCache.mockRejectedValue(
                new Error('Redis down'),
            );

            const result = await useCase.execute();

            expect(result).toEqual(mockMembers);
        });

        it('should not cache empty results to avoid caching transient errors', async () => {
            mockCacheService.getFromCache.mockResolvedValue(null);
            mockCodeManagementService.getListMembers.mockResolvedValue([]);
            mockPullRequestHandlerService.getPullRequestAuthorsWithCache.mockResolvedValue(
                [],
            );

            await useCase.execute();

            expect(mockCacheService.addToCache).not.toHaveBeenCalled();
        });
    });

    describe('fallback to pull request authors', () => {
        it('should fall back to PR authors when code integration returns empty', async () => {
            const prAuthors = [
                { id: 10, name: 'PR Author 1' },
                { id: 11, name: 'PR Author 2' },
            ];

            mockCodeManagementService.getListMembers.mockResolvedValue([]);
            mockPullRequestHandlerService.getPullRequestAuthorsWithCache.mockResolvedValue(
                prAuthors,
            );

            const result = await useCase.execute();

            expect(result).toEqual(prAuthors);
            expect(
                mockPullRequestHandlerService.getPullRequestAuthorsWithCache,
            ).toHaveBeenCalled();
        });

        it('should fall back to PR authors when code integration throws', async () => {
            const prAuthors = [{ id: 10, name: 'PR Author 1' }];

            mockCodeManagementService.getListMembers.mockRejectedValue(
                new Error('GitLab API error'),
            );
            mockPullRequestHandlerService.getPullRequestAuthorsWithCache.mockResolvedValue(
                prAuthors,
            );

            const result = await useCase.execute();

            expect(result).toEqual(prAuthors);
        });

        it('should cache PR author results', async () => {
            const prAuthors = [{ id: 10, name: 'PR Author 1' }];

            mockCodeManagementService.getListMembers.mockResolvedValue([]);
            mockPullRequestHandlerService.getPullRequestAuthorsWithCache.mockResolvedValue(
                prAuthors,
            );

            await useCase.execute();

            expect(mockCacheService.addToCache).toHaveBeenCalledWith(
                'org_members_org-uuid-123',
                prAuthors,
                30 * 60 * 1000,
            );
        });
    });

    describe('deduplication', () => {
        it('should deduplicate members by id', async () => {
            const duplicateMembers = [
                { id: 1, name: 'Alice' },
                { id: 1, name: 'Alice Duplicate' },
                { id: 2, name: 'Bob' },
            ];

            mockCodeManagementService.getListMembers.mockResolvedValue(
                duplicateMembers,
            );

            const result = await useCase.execute();

            expect(result).toHaveLength(2);
            expect(result.find((m) => m.id === 1)?.name).toBe('Alice');
        });
    });
});
