jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { GitlabService } from '@libs/platform/infrastructure/adapters/services/gitlab.service';

describe('GitlabService.resolveMrAuthorFromWebhookPayload', () => {
    let service: GitlabService;
    let mockCacheService: any;
    let getUserByIdSpy: jest.SpyInstance;

    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };
    const mockAuthor = {
        id: 42,
        username: 'real-author',
        name: 'Real Author',
    };

    beforeEach(() => {
        mockCacheService = {
            getFromCache: jest.fn().mockResolvedValue(null),
            addToCache: jest.fn().mockResolvedValue(undefined),
        };

        service = new GitlabService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            mockCacheService,
        );

        getUserByIdSpy = jest
            .spyOn(service, 'getUserById')
            .mockResolvedValue(mockAuthor);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('resolves the author from object_attributes.author_id (Merge Request Hook)', async () => {
        const payload = {
            object_attributes: { author_id: 42 },
            user: { id: 99, username: 'pusher' },
        };

        const result = await service.resolveMrAuthorFromWebhookPayload({
            organizationAndTeamData: orgTeam,
            payload,
        });

        expect(result).toEqual(mockAuthor);
        expect(getUserByIdSpy).toHaveBeenCalledWith({
            organizationAndTeamData: orgTeam,
            userId: '42',
        });
    });

    it('resolves the author from merge_request.author_id (Note Hook)', async () => {
        const payload = {
            // On Note Hook, object_attributes.author_id is the COMMENTER —
            // not the MR author. The resolver must ignore it when a
            // merge_request block exists.
            object_attributes: { id: 1, note: 'hi', author_id: 999 },
            merge_request: { author_id: 42 },
            user: { id: 999, username: 'commenter' },
        };

        const result = await service.resolveMrAuthorFromWebhookPayload({
            organizationAndTeamData: orgTeam,
            payload,
        });

        expect(result).toEqual(mockAuthor);
        expect(getUserByIdSpy).toHaveBeenCalledWith({
            organizationAndTeamData: orgTeam,
            userId: '42',
        });
    });

    it('returns cached author without calling the API on cache hit', async () => {
        mockCacheService.getFromCache.mockResolvedValueOnce(mockAuthor);

        const result = await service.resolveMrAuthorFromWebhookPayload({
            organizationAndTeamData: orgTeam,
            payload: { object_attributes: { author_id: 42 } },
        });

        expect(result).toEqual(mockAuthor);
        expect(getUserByIdSpy).not.toHaveBeenCalled();
        expect(mockCacheService.addToCache).not.toHaveBeenCalled();
    });

    it('caches the resolved author after a cache miss', async () => {
        await service.resolveMrAuthorFromWebhookPayload({
            organizationAndTeamData: orgTeam,
            payload: { object_attributes: { author_id: 42 } },
        });

        expect(mockCacheService.addToCache).toHaveBeenCalledWith(
            'gitlab-mr-author-org-1-42',
            mockAuthor,
            1800000,
        );
    });

    it('returns null when no author_id can be extracted', async () => {
        const result = await service.resolveMrAuthorFromWebhookPayload({
            organizationAndTeamData: orgTeam,
            payload: { object_attributes: {} },
        });

        expect(result).toBeNull();
        expect(getUserByIdSpy).not.toHaveBeenCalled();
    });

    it('returns null when organizationId is missing', async () => {
        const result = await service.resolveMrAuthorFromWebhookPayload({
            organizationAndTeamData: { teamId: 't' } as any,
            payload: { object_attributes: { author_id: 42 } },
        });

        expect(result).toBeNull();
        expect(getUserByIdSpy).not.toHaveBeenCalled();
    });

    it('does not throw when getUserById returns null and skips caching', async () => {
        getUserByIdSpy.mockResolvedValueOnce(null);

        const result = await service.resolveMrAuthorFromWebhookPayload({
            organizationAndTeamData: orgTeam,
            payload: { object_attributes: { author_id: 42 } },
        });

        expect(result).toBeNull();
        expect(mockCacheService.addToCache).not.toHaveBeenCalled();
    });

    it('survives a cache read error and still resolves via API', async () => {
        mockCacheService.getFromCache.mockRejectedValueOnce(
            new Error('cache down'),
        );

        const result = await service.resolveMrAuthorFromWebhookPayload({
            organizationAndTeamData: orgTeam,
            payload: { object_attributes: { author_id: 42 } },
        });

        expect(result).toEqual(mockAuthor);
        expect(getUserByIdSpy).toHaveBeenCalled();
    });

    it('survives a cache write error', async () => {
        mockCacheService.addToCache.mockRejectedValueOnce(
            new Error('cache write fail'),
        );

        const result = await service.resolveMrAuthorFromWebhookPayload({
            organizationAndTeamData: orgTeam,
            payload: { object_attributes: { author_id: 42 } },
        });

        expect(result).toEqual(mockAuthor);
    });
});
