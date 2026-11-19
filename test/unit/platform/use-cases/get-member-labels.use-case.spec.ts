jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { GetMemberLabelsUseCase } from '@libs/platform/application/use-cases/codeManagement/get-member-labels.use-case';

describe('GetMemberLabelsUseCase', () => {
    let pullRequestsService: { findPullRequestAuthorLabelsByIds: jest.Mock };
    let useCase: GetMemberLabelsUseCase;

    beforeEach(() => {
        pullRequestsService = {
            findPullRequestAuthorLabelsByIds: jest.fn().mockResolvedValue([]),
        };
        useCase = new GetMemberLabelsUseCase(
            pullRequestsService as any,
            {
                user: { organization: { uuid: 'org-1' } },
            } as any,
        );
    });

    it('names each id from its stored pull requests, scoped to the organization', async () => {
        pullRequestsService.findPullRequestAuthorLabelsByIds.mockResolvedValue([
            { id: '7', name: 'Bob Smith', username: 'bob' },
            { id: '8', name: '', username: 'carol' },
            { id: '9', name: 'dave', username: 'dave' },
        ]);

        const labels = await useCase.execute('team-1', ['7', ' 8', '9', '7']);

        expect(
            pullRequestsService.findPullRequestAuthorLabelsByIds,
        ).toHaveBeenCalledWith('org-1', ['7', '8', '9']);
        expect(labels).toEqual({
            '7': 'Bob Smith (bob)',
            '8': 'carol',
            '9': 'dave',
        });
    });

    it('leaves out an id that never opened a pull request', async () => {
        pullRequestsService.findPullRequestAuthorLabelsByIds.mockResolvedValue([
            { id: '7', name: 'Bob', username: 'bob' },
        ]);

        await expect(useCase.execute('team-1', ['7', '42'])).resolves.toEqual({
            '7': 'Bob (bob)',
        });
    });

    it('does not query for an empty id list', async () => {
        await expect(useCase.execute('team-1', ['', ' '])).resolves.toEqual({});
        expect(
            pullRequestsService.findPullRequestAuthorLabelsByIds,
        ).not.toHaveBeenCalled();
    });

    it('answers no labels when the store fails, so the page falls back to ids', async () => {
        pullRequestsService.findPullRequestAuthorLabelsByIds.mockRejectedValue(
            new Error('timeout'),
        );

        await expect(useCase.execute('team-1', ['7'])).resolves.toEqual({});
    });
});
