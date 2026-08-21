import { Gitlab } from '@gitbeaker/rest';
import { ConfigService } from '@nestjs/config';

import { isRateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { GitlabService } from '../gitlab.service';

jest.mock('axios');
jest.mock('@gitbeaker/rest', () => ({
    Gitlab: jest.fn(),
}));
jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

/**
 * Mirrors what gitbeaker throws once it has exhausted its own internal
 * retries against 429/502.
 */
function gitbeakerRetryError() {
    const error = new Error(
        'Could not successfully complete this request after 10 retries, last status code: 429.',
    );
    error.name = 'GitbeakerRetryError';
    return error;
}

describe('GitlabService – countReactions', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const pr = {
        pull_number: 42,
        repository: { id: 'repo-1', name: 'group/repo' },
    };

    let service: GitlabService;
    const mockedGitlab = Gitlab as unknown as jest.Mock;

    const buildComment = (id: number) => ({
        id,
        notes: [
            {
                id,
                project_id: 'repo-1',
                noteable_iid: 42,
                body: `comment ${id}`,
            },
        ],
    });

    beforeEach(() => {
        jest.clearAllMocks();

        service = new GitlabService(
            { findOne: jest.fn() } as any,
            {} as any,
            {} as any,
            { get: jest.fn() } as unknown as ConfigService,
            {} as any,
        );

        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            accessToken: 'oauth-token',
            authMode: AuthMode.OAUTH,
            host: 'https://gitlab.example.com',
        });
    });

    const mockAwards = (all: jest.Mock) =>
        mockedGitlab.mockReturnValue({
            MergeRequestNoteAwardEmojis: { all },
        });

    it('counts thumbs up and down per comment', async () => {
        mockAwards(
            jest
                .fn()
                .mockResolvedValue([
                    { name: 'thumbsup' },
                    { name: 'thumbsup' },
                    { name: 'thumbsdown' },
                ]),
        );

        const result = await service.countReactions({
            organizationAndTeamData,
            comments: [buildComment(1)],
            pr,
        });

        expect(result).toHaveLength(1);
        expect(result[0].reactions).toEqual({ thumbsUp: 2, thumbsDown: 1 });
    });

    it('never has more than the award concurrency cap in flight', async () => {
        let inFlight = 0;
        let peakInFlight = 0;

        mockAwards(
            jest.fn().mockImplementation(async () => {
                inFlight += 1;
                peakInFlight = Math.max(peakInFlight, inFlight);
                await new Promise((resolve) => setImmediate(resolve));
                inFlight -= 1;
                return [{ name: 'thumbsup' }];
            }),
        );

        const comments = Array.from({ length: 30 }, (_, i) =>
            buildComment(i + 1),
        );

        const result = await service.countReactions({
            organizationAndTeamData,
            comments,
            pr,
        });

        expect(result).toHaveLength(30);
        expect(peakInFlight).toBeLessThanOrEqual(5);
    });

    it('keeps ordinary per-comment failures isolated', async () => {
        const all = jest
            .fn()
            .mockRejectedValueOnce(new Error('note was deleted'))
            .mockResolvedValue([{ name: 'thumbsup' }]);
        mockAwards(all);

        const result = await service.countReactions({
            organizationAndTeamData,
            comments: [buildComment(1), buildComment(2)],
            pr,
        });

        // The failed comment drops out, the other one still counts
        expect(result).toHaveLength(1);
        expect(result[0].comment.id).toBe(2);
    });

    it('surfaces a rate limit as RateLimitError instead of swallowing it', async () => {
        mockAwards(jest.fn().mockRejectedValue(gitbeakerRetryError()));

        const error = await service
            .countReactions({
                organizationAndTeamData,
                comments: [buildComment(1)],
                pr,
            })
            .catch((e) => e);

        expect(isRateLimitError(error)).toBe(true);
        expect(error.context).toEqual({
            organizationId: 'org-1',
            teamId: 'team-1',
        });
    });

    it('stops issuing award requests for comments still queued when a rate limit lands', async () => {
        const all = jest.fn().mockRejectedValue(gitbeakerRetryError());
        mockAwards(all);

        const comments = Array.from({ length: 40 }, (_, i) =>
            buildComment(i + 1),
        );

        const error = await service
            .countReactions({ organizationAndTeamData, comments, pr })
            .catch((e) => e);

        expect(isRateLimitError(error)).toBe(true);

        // Let the throttled queue drain before counting — it must drain
        // without touching the provider again.
        await new Promise((resolve) => setImmediate(resolve));

        expect(all.mock.calls.length).toBeLessThanOrEqual(5);
    });
});
