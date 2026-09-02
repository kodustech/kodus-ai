import { SavePullRequestUseCase } from './save.use-case';
import { PlatformType } from '@libs/core/domain/enums';

/**
 * Mutation-killing tests for the two deterministic private predicates in
 * SavePullRequestUseCase:
 *
 *   - isValidPullRequestAction: OR-chain over four payload shapes plus a
 *     BITBUCKET platform short-circuit.
 *   - shouldFetchFilesAndCommits: multi-provider decision whether to fetch
 *     fresh files/commits from the Git API.
 *
 * Both are pure and touch none of the constructor deps, so the use-case is
 * built with inert `{} as any` stubs and the methods are reached via
 * `(useCase as any).method(...)`.
 */
describe('SavePullRequestUseCase deterministic predicates', () => {
    let useCase: SavePullRequestUseCase;

    beforeEach(() => {
        // None of the four constructor deps are used by the target methods.
        useCase = new SavePullRequestUseCase(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
    });

    const isValid = (payload: any, platformType: PlatformType) =>
        (useCase as any).isValidPullRequestAction({ payload, platformType });

    const shouldFetch = (payload: any, platformType: PlatformType) =>
        (useCase as any).shouldFetchFilesAndCommits(payload, platformType);

    describe('isValidPullRequestAction', () => {
        // Exact valid-action membership. Each string must independently make
        // the predicate true so removing any array member is caught.
        const validTopLevelActions = [
            'opened',
            'closed',
            'synchronize',
            'synchronized',
            'review_requested',
            'review_request_removed',
            'assigned',
            'unassigned',
            'active',
            'completed',
            'ready_for_review',
        ];

        it.each(validTopLevelActions)(
            'returns true when payload.action is the valid action "%s" (non-bitbucket)',
            (action) => {
                expect(isValid({ action }, PlatformType.GITHUB)).toBe(true);
            },
        );

        const validObjectActions = ['open', 'close', 'merge', 'update'];

        it.each(validObjectActions)(
            'returns true when object_attributes.action is the valid object action "%s"',
            (action) => {
                expect(
                    isValid(
                        { object_attributes: { action } },
                        PlatformType.GITLAB,
                    ),
                ).toBe(true);
            },
        );

        it('isolates the object_attributes.action clause (only that clause true)', () => {
            // 'update' is NOT a valid top-level action, so this can only pass
            // through the object_attributes branch.
            expect(
                isValid(
                    {
                        action: 'update',
                        object_attributes: { action: 'update' },
                    },
                    PlatformType.GITHUB,
                ),
            ).toBe(true);
            // Same key value at top level alone is invalid.
            expect(isValid({ action: 'update' }, PlatformType.GITHUB)).toBe(
                false,
            );
        });

        it('returns true only via the resource.status clause', () => {
            expect(
                isValid(
                    { resource: { status: 'active' } },
                    PlatformType.GITHUB,
                ),
            ).toBe(true);
            // A status not in validActions must not pass.
            expect(
                isValid(
                    { resource: { status: 'notARealStatus' } },
                    PlatformType.GITHUB,
                ),
            ).toBe(false);
        });

        it('returns true only via the resource.pullRequest.status clause', () => {
            expect(
                isValid(
                    { resource: { pullRequest: { status: 'completed' } } },
                    PlatformType.GITHUB,
                ),
            ).toBe(true);
            expect(
                isValid(
                    { resource: { pullRequest: { status: 'nope' } } },
                    PlatformType.GITHUB,
                ),
            ).toBe(false);
        });

        it('returns true for BITBUCKET regardless of an otherwise-invalid payload', () => {
            expect(isValid({ action: 'garbage' }, PlatformType.BITBUCKET)).toBe(
                true,
            );
        });

        it('returns false for a non-bitbucket platform with an invalid payload', () => {
            expect(isValid({ action: 'garbage' }, PlatformType.GITHUB)).toBe(
                false,
            );
            expect(isValid({ action: 'garbage' }, PlatformType.GITLAB)).toBe(
                false,
            );
        });

        it('returns false for an empty payload on a non-bitbucket platform', () => {
            expect(isValid({}, PlatformType.GITHUB)).toBe(false);
        });

        it('does not treat a valid top-level action as a valid object action', () => {
            // 'opened' is valid at top level but NOT in validObjectActions.
            expect(
                isValid(
                    { object_attributes: { action: 'opened' } },
                    PlatformType.GITHUB,
                ),
            ).toBe(false);
        });
    });

    describe('shouldFetchFilesAndCommits', () => {
        const githubFetchActions = [
            'opened',
            'synchronize',
            'synchronized',
            'ready_for_review',
        ];

        it.each(githubFetchActions)(
            'returns true for GitHub fetch action "%s"',
            (action) => {
                expect(shouldFetch({ action }, PlatformType.GITHUB)).toBe(true);
            },
        );

        it('returns false for a GitHub action outside the fetch set', () => {
            // 'closed' is a valid PR action but must NOT trigger a fetch.
            expect(shouldFetch({ action: 'closed' }, PlatformType.GITHUB)).toBe(
                false,
            );
            expect(
                shouldFetch({ action: 'assigned' }, PlatformType.GITHUB),
            ).toBe(false);
        });

        it('returns true for GitLab object action "open"', () => {
            expect(
                shouldFetch(
                    { object_attributes: { action: 'open' } },
                    PlatformType.GITLAB,
                ),
            ).toBe(true);
        });

        it('returns true for GitLab "update" when last_commit.id differs from oldrev', () => {
            expect(
                shouldFetch(
                    {
                        object_attributes: {
                            action: 'update',
                            last_commit: { id: 'newsha' },
                            oldrev: 'oldsha',
                        },
                    },
                    PlatformType.GITLAB,
                ),
            ).toBe(true);
        });

        it('returns false for GitLab "update" when last_commit.id equals oldrev', () => {
            expect(
                shouldFetch(
                    {
                        object_attributes: {
                            action: 'update',
                            last_commit: { id: 'samesha' },
                            oldrev: 'samesha',
                        },
                    },
                    PlatformType.GITLAB,
                ),
            ).toBe(false);
        });

        it('returns false for GitLab "update" when oldrev is missing', () => {
            expect(
                shouldFetch(
                    {
                        object_attributes: {
                            action: 'update',
                            last_commit: { id: 'newsha' },
                        },
                    },
                    PlatformType.GITLAB,
                ),
            ).toBe(false);
        });

        it('returns false for GitLab "update" when last_commit.id is missing', () => {
            expect(
                shouldFetch(
                    {
                        object_attributes: {
                            action: 'update',
                            oldrev: 'oldsha',
                        },
                    },
                    PlatformType.GITLAB,
                ),
            ).toBe(false);
        });

        it('returns false for a GitLab object action outside the fetch set', () => {
            expect(
                shouldFetch(
                    { object_attributes: { action: 'close' } },
                    PlatformType.GITLAB,
                ),
            ).toBe(false);
        });

        it('returns true when Azure resource.status is "active"', () => {
            expect(
                shouldFetch(
                    { resource: { status: 'active' } },
                    PlatformType.AZURE_REPOS,
                ),
            ).toBe(true);
        });

        it('returns true when Azure resource.pullRequest.status is "active"', () => {
            expect(
                shouldFetch(
                    { resource: { pullRequest: { status: 'active' } } },
                    PlatformType.AZURE_REPOS,
                ),
            ).toBe(true);
        });

        it('returns false when Azure resource status is not "active"', () => {
            expect(
                shouldFetch(
                    { resource: { status: 'completed' } },
                    PlatformType.AZURE_REPOS,
                ),
            ).toBe(false);
            expect(
                shouldFetch(
                    { resource: { pullRequest: { status: 'completed' } } },
                    PlatformType.AZURE_REPOS,
                ),
            ).toBe(false);
        });

        it('always returns true for BITBUCKET (conservative fallback)', () => {
            // New-PR shape.
            expect(
                shouldFetch(
                    { pullrequest: { state: 'OPEN' } },
                    PlatformType.BITBUCKET,
                ),
            ).toBe(true);
            // Push-with-changes shape.
            expect(
                shouldFetch(
                    { push: { changes: [{}] } },
                    PlatformType.BITBUCKET,
                ),
            ).toBe(true);
            // Neither shape matches, but Bitbucket still fetches to be safe.
            expect(shouldFetch({}, PlatformType.BITBUCKET)).toBe(true);
        });

        it('returns false for a non-fetch event on a non-bitbucket platform', () => {
            expect(shouldFetch({ action: 'closed' }, PlatformType.GITHUB)).toBe(
                false,
            );
            expect(shouldFetch({}, PlatformType.GITHUB)).toBe(false);
            expect(shouldFetch({}, PlatformType.GITLAB)).toBe(false);
        });
    });
});
