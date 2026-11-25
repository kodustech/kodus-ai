import {
    compileAuthorPolicyByConnection,
    compileAuthorPolicyConfig,
    repositoryConnectionMap,
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

describe('repositoryConnectionMap', () => {
    it('maps each saved repository to the connection that lists it', () => {
        const map = repositoryConnectionMap([
            { integration: { uuid: 'gh-a' }, configValue: [{ id: 1 }, { id: 2 }] },
            { integration: { uuid: 'gl-b' }, configValue: [{ id: 3 }] },
        ]);

        expect([...map.entries()]).toEqual([
            ['1', 'gh-a'],
            ['2', 'gh-a'],
            ['3', 'gl-b'],
        ]);
    });

    it('leaves an id two connections list unmapped, so neither connection claims it', () => {
        const map = repositoryConnectionMap([
            { integration: { uuid: 'gh-a' }, configValue: [{ id: 7 }] },
            { integration: { uuid: 'gl-b' }, configValue: [{ id: '7' }] },
            { integration: { uuid: 'fj-c' }, configValue: [{ id: 7 }] },
        ]);

        expect(map.has('7')).toBe(false);
    });
});
