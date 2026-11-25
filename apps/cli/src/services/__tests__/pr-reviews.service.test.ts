import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/pull-requests.api.js', () => ({
    pullRequestsApi: { getExecutions: vi.fn() },
}));

vi.mock('../git.service.js', () => ({
    gitService: {
        isGitRepository: vi.fn(),
        extractOrgRepo: vi.fn(),
    },
}));

vi.mock('../user-context.service.js', () => ({
    userContextService: { resolve: vi.fn() },
}));

import { CommandError } from '../../utils/command-errors.js';
import { pullRequestsApi } from '../api/pull-requests.api.js';
import { gitService } from '../git.service.js';
import { pullRequestReviewsService } from '../pr-reviews.service.js';
import { userContextService } from '../user-context.service.js';

const mockApi = vi.mocked(pullRequestsApi);
const mockGit = vi.mocked(gitService);
const mockUserContext = vi.mocked(userContextService);

function run(prNumber: number, createdAt: string, status = 'success') {
    return {
        prNumber,
        title: 'Add cache',
        status: 'open',
        merged: false,
        url: 'https://github.com/acme/api/pull/42',
        repositoryName: 'api',
        repositoryId: 'repo-1',
        automationExecution: {
            uuid: `exec-${createdAt}`,
            status,
            createdAt,
            updatedAt: createdAt,
            origin: 'webhook',
        },
    };
}

function page(data: unknown[], nextCursor?: string) {
    return {
        data,
        pagination: {
            currentPage: 1,
            totalPages: 1,
            totalItems: data.length,
            hasNextPage: !!nextCursor,
            nextCursor,
        },
    } as any;
}

const azureLocation =
    'https://dev.azure.com/acme/project/_git/api/pullrequest/42';
const azureIdentity = {
    location: azureLocation,
    provider: 'AZURE_REPOS',
    repositoryId: 'repo-1',
};

describe('pullRequestReviewsService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockUserContext.resolve.mockResolvedValue({
            accessToken: 'eyJ.user.token',
            organizationId: 'org-1',
            teamId: 'team-1',
            teamName: 'Platform',
        });
        mockGit.isGitRepository.mockResolvedValue(true);
        mockGit.extractOrgRepo.mockResolvedValue({ org: 'acme', repo: 'api' });
    });

    it('queries the executions of the PR in this checkout, newest first', async () => {
        mockApi.getExecutions.mockResolvedValue(
            page([
                run(42, '2026-10-01T10:00:00Z'),
                run(42, '2026-10-03T10:00:00Z', 'error'),
                run(420, '2026-10-04T10:00:00Z'),
            ]),
        );

        const result = await pullRequestReviewsService.list({ prNumber: 42 });

        expect(mockApi.getExecutions).toHaveBeenCalledWith('eyJ.user.token', {
            teamId: 'team-1',
            repositoryId: undefined,
            repositoryName: 'acme/api',
            pullRequestNumber: 42,
            limit: 20,
            cursor: undefined,
        });
        expect(result.runs.map((r) => r.automationExecution?.status)).toEqual([
            'error',
            'success',
        ]);
        expect(result).toEqual(
            expect.objectContaining({
                prNumber: 42,
                repository: 'acme/api',
                team: 'Platform',
                truncated: false,
            }),
        );
    });

    it('follows nextCursor until the limit is filled', async () => {
        mockApi.getExecutions
            .mockResolvedValueOnce(
                page([run(42, '2026-10-03T10:00:00Z')], 'cursor-1'),
            )
            .mockResolvedValueOnce(
                page(
                    [
                        run(42, '2026-10-02T10:00:00Z'),
                        run(42, '2026-10-01T10:00:00Z'),
                    ],
                    'cursor-2',
                ),
            );

        const result = await pullRequestReviewsService.list({
            prNumber: 42,
            repositoryId: 'repo-1',
            limit: 2,
        });

        expect(mockApi.getExecutions).toHaveBeenCalledTimes(2);
        expect(mockApi.getExecutions).toHaveBeenLastCalledWith(
            'eyJ.user.token',
            expect.objectContaining({
                repositoryId: 'repo-1',
                repositoryName: undefined,
                cursor: 'cursor-1',
            }),
        );
        expect(result.runs).toHaveLength(2);
        expect(result.truncated).toBe(true);
    });

    it.each(['AZUREDEVOPS', undefined])(
        'keeps the verified head for canonical matches with stored provider %s',
        async (provider) => {
            mockApi.getExecutions
                .mockResolvedValueOnce({
                    ...page(
                        [
                            {
                                ...run(42, '2026-10-03T10:00:00Z'),
                                provider: 'AZURE_REPOS',
                                url: azureLocation,
                            },
                        ],
                        'cursor-1',
                    ),
                    currentHeadSha: 'verified-head',
                    reviewIdentity: azureIdentity,
                })
                .mockResolvedValueOnce({
                    ...page([
                        {
                            ...run(42, '2026-10-01T10:00:00Z'),
                            provider,
                            url: `${azureLocation}/?tab=files`,
                        },
                    ]),
                    reviewIdentity: {
                        ...azureIdentity,
                        provider: provider ? 'AZURE_REPOS' : undefined,
                    },
                });

            const result = await pullRequestReviewsService.list({
                prNumber: 42,
                repositoryId: 'repo-1',
                explain: true,
            });

            expect(result.currentHeadSha).toBe('verified-head');
        },
    );

    it.each([
        {
            name: 'an unverified location',
            url: undefined,
            identity: undefined,
        },
        {
            name: 'a different host',
            url: 'https://azure.example/acme/project/_git/api/pullrequest/42',
            identity: {
                ...azureIdentity,
                location:
                    'https://azure.example/acme/project/_git/api/pullrequest/42',
            },
        },
        {
            name: 'a different provider',
            url: azureLocation,
            identity: { ...azureIdentity, provider: 'GITLAB' },
        },
    ])(
        'omits the live head for $name on another page',
        async ({ url, identity }) => {
            mockApi.getExecutions
                .mockResolvedValueOnce({
                    ...page(
                        [
                            {
                                ...run(42, '2026-10-03T10:00:00Z'),
                                url: azureLocation,
                            },
                        ],
                        'cursor-1',
                    ),
                    currentHeadSha: 'verified-head',
                    reviewIdentity: azureIdentity,
                })
                .mockResolvedValueOnce({
                    ...page([
                        {
                            ...run(42, '2026-10-01T10:00:00Z'),
                            url,
                        },
                    ]),
                    reviewIdentity: identity,
                });

            const result = await pullRequestReviewsService.list({
                prNumber: 42,
                repositoryId: 'repo-1',
                explain: true,
            });

            expect(result.runs).toHaveLength(2);
            expect(result.currentHeadSha).toBeUndefined();
        },
    );

    it('uses --repo over the git remote', async () => {
        mockApi.getExecutions.mockResolvedValue(page([]));

        await pullRequestReviewsService.list({
            prNumber: 7,
            repository: 'acme/web',
        });

        expect(mockGit.extractOrgRepo).not.toHaveBeenCalled();
        expect(mockApi.getExecutions).toHaveBeenCalledWith(
            'eyJ.user.token',
            expect.objectContaining({ repositoryName: 'acme/web' }),
        );
    });

    it('asks for the repository outside a git checkout', async () => {
        mockGit.isGitRepository.mockResolvedValue(false);

        await expect(
            pullRequestReviewsService.list({ prNumber: 7 }),
        ).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'INVALID_INPUT',
            }),
        );
        expect(mockApi.getExecutions).not.toHaveBeenCalled();
    });

    it('surfaces the login requirement for a team key', async () => {
        mockUserContext.resolve.mockRejectedValue(
            new CommandError('AUTH_REQUIRED', 'requires a logged-in user'),
        );

        await expect(
            pullRequestReviewsService.list({ prNumber: 7 }),
        ).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'AUTH_REQUIRED',
            }),
        );
    });

    it('rejects a non-positive limit', async () => {
        await expect(
            pullRequestReviewsService.list({ prNumber: 7, limit: 0 }),
        ).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'INVALID_INPUT',
            }),
        );
    });
});
