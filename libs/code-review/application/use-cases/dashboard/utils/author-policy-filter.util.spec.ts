import {
    compileAuthorPolicyByConnection,
    compileAuthorPolicyConfig,
    shouldIncludeAuthorByPolicy,
} from './author-policy-filter.util';

describe('author-policy-filter.util', () => {
    it('should include all authors when policy is all', () => {
        const config = compileAuthorPolicyConfig({
            ignoredUsers: ['bot-1'],
            allowedUsers: ['alice'],
        });

        expect(
            shouldIncludeAuthorByPolicy({
                policy: 'all',
                authorId: 'bot-1',
                config,
            }),
        ).toBe(true);
        expect(
            shouldIncludeAuthorByPolicy({
                policy: 'all',
                authorId: 'random-user',
                config,
            }),
        ).toBe(true);
    });

    it('should exclude ignored users in reviewable policy', () => {
        const config = compileAuthorPolicyConfig({
            ignoredUsers: ['dependabot[bot]'],
        });

        expect(
            shouldIncludeAuthorByPolicy({
                policy: 'reviewable',
                authorId: 'dependabot[bot]',
                config,
            }),
        ).toBe(false);
        expect(
            shouldIncludeAuthorByPolicy({
                policy: 'reviewable',
                authorId: 'wellington',
                config,
            }),
        ).toBe(true);
    });

    it('should exclude users not present in allowedUsers when allow-list exists', () => {
        const config = compileAuthorPolicyConfig({
            allowedUsers: ['wellington', 'caio'],
            ignoredUsers: [],
        });

        expect(
            shouldIncludeAuthorByPolicy({
                policy: 'reviewable',
                authorId: 'wellington',
                config,
            }),
        ).toBe(true);
        expect(
            shouldIncludeAuthorByPolicy({
                policy: 'reviewable',
                authorId: 'dependabot[bot]',
                config,
            }),
        ).toBe(false);
    });

    it('should include only excluded authors when policy is excluded', () => {
        const config = compileAuthorPolicyConfig({
            ignoredUsers: ['dependabot[bot]'],
        });

        expect(
            shouldIncludeAuthorByPolicy({
                policy: 'excluded',
                authorId: 'dependabot[bot]',
                config,
            }),
        ).toBe(true);
        expect(
            shouldIncludeAuthorByPolicy({
                policy: 'excluded',
                authorId: 'wellington',
                config,
            }),
        ).toBe(false);
    });

    it('should treat empty or missing author ids as reviewable', () => {
        const config = compileAuthorPolicyConfig({
            ignoredUsers: ['bot-1'],
        });

        expect(
            shouldIncludeAuthorByPolicy({
                policy: 'reviewable',
                authorId: undefined,
                config,
            }),
        ).toBe(true);
        expect(
            shouldIncludeAuthorByPolicy({
                policy: 'reviewable',
                authorId: '',
                config,
            }),
        ).toBe(true);
    });
});

describe('author policy per Git connection', () => {
    const configValue = {
        ignoredUsers: ['7'],
        connections: { 'gl-b': { ignoredUsers: ['9'] } },
    };
    const repoConnection = new Map([
        ['repo-gh', 'gh-a'],
        ['repo-gl', 'gl-b'],
    ]);

    it("filters a PR with the lists of its repository's connection", () => {
        const forRepository = compileAuthorPolicyByConnection(
            configValue,
            repoConnection,
        );

        expect(forRepository('repo-gl').ignoredUsers).toEqual(new Set(['9']));
        expect(forRepository('repo-gh').ignoredUsers).toEqual(new Set(['7']));
    });

    it('uses the organization lists for a repository no connection lists', () => {
        const forRepository = compileAuthorPolicyByConnection(
            configValue,
            repoConnection,
        );

        expect(forRepository('unknown').ignoredUsers).toEqual(new Set(['7']));
        expect(forRepository(undefined).ignoredUsers).toEqual(new Set(['7']));
    });
});
