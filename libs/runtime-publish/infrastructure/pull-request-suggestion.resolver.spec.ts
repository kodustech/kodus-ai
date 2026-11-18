import { PullRequestSuggestionResolver } from './pull-request-suggestion.resolver';

const input = (suggestionId: string) => ({
    organizationAndTeamData: { organizationId: 'org-a', teamId: 'team-a' },
    repositoryId: 'repo-1',
    prNumber: 42,
    suggestionId,
});

describe('PullRequestSuggestionResolver', () => {
    it('finds the review comment of a delivered suggestion, scoped to org, repo and PR', async () => {
        const findOne = jest.fn().mockResolvedValue({
            files: [{ suggestions: [{ id: 'other', comment: { id: 1 } }] }, { suggestions: [{ id: 'sug-1', comment: { id: 777 } }] }],
        });
        const resolver = new PullRequestSuggestionResolver({ findOne } as any);
        expect(await resolver.resolve(input('sug-1'))).toEqual({ commentId: 777 });
        expect(findOne.mock.calls[0][0]).toEqual({
            'number': 42,
            'organizationId': 'org-a',
            'repository.id': 'repo-1',
            'files.suggestions.id': 'sug-1',
        });
    });

    it('is null for an unknown PR, an unknown suggestion or one never posted as a comment', async () => {
        const none = new PullRequestSuggestionResolver({ findOne: jest.fn().mockResolvedValue(null) } as any);
        expect(await none.resolve(input('sug-1'))).toBeNull();
        const notPosted = new PullRequestSuggestionResolver({
            findOne: jest.fn().mockResolvedValue({ files: [{ suggestions: [{ id: 'sug-1' }] }] }),
        } as any);
        expect(await notPosted.resolve(input('sug-1'))).toBeNull();
    });
});
