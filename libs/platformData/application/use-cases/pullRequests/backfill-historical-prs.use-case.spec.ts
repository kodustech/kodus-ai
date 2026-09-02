import { BackfillHistoricalPRsUseCase } from './backfill-historical-prs.use-case';

/**
 * Mutation-killing tests for the deterministic transform in
 * BackfillHistoricalPRsUseCase.
 *
 * transformPullRequestToDocument is a pure private method: it maps a raw
 * PullRequest payload (plus computed file stats, commits and repository
 * metadata) into the persisted IPullRequests document shape. It is full of
 * `||` fallback chains and optional-chaining guards, so every branch is
 * pinned here with exact values.
 */
describe('BackfillHistoricalPRsUseCase.transformPullRequestToDocument', () => {
    // Frozen clock so every `new Date().toISOString()` fallback is a known,
    // assertable literal instead of a moving target.
    const NOW_ISO = '2026-01-01T00:00:00.000Z';

    let useCase: BackfillHistoricalPRsUseCase;

    const transform = (
        pr: any,
        organizationId: string,
        fileStats: {
            totalAdded: number;
            totalDeleted: number;
            totalChanges: number;
        },
        commits: any[],
        repository: {
            id: string;
            name: string;
            fullName?: string;
            url?: string;
        },
    ) =>
        (useCase as any).transformPullRequestToDocument(
            pr,
            organizationId,
            fileStats,
            commits,
            repository,
        );

    const zeroStats = { totalAdded: 0, totalDeleted: 0, totalChanges: 0 };

    beforeAll(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW_ISO));
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    beforeEach(() => {
        // Both constructor deps are unused by the target method: inert stubs.
        useCase = new BackfillHistoricalPRsUseCase({} as any, {} as any);
    });

    it('maps a fully-populated PR to the exact document shape (head.repo wins)', () => {
        const pr = {
            title: 'Add feature',
            state: 'open',
            merged_at: '2026-05-01T10:00:00.000Z',
            number: 42,
            prURL: 'https://example.com/pr/42',
            base: {
                ref: 'main',
                repo: {
                    id: 'base-repo-id',
                    name: 'base-repo',
                    fullName: 'org/base-repo',
                },
            },
            head: {
                ref: 'feature-branch',
                repo: {
                    id: 'head-repo-id',
                    name: 'head-repo',
                    fullName: 'org/head-repo',
                },
            },
            created_at: '2026-04-01T08:00:00.000Z',
            closed_at: '2026-05-02T09:00:00.000Z',
            updated_at: '2026-05-02T09:30:00.000Z',
            user: { id: 7, login: 'octocat', name: 'Octo Cat' },
            reviewers: [{ id: 11 }, { id: 12 }],
            participants: [{ id: 21 }, { id: 22 }],
            isDraft: true,
        };

        const commits = [{ sha: 'abc', message: 'msg' }];

        const result = transform(
            pr,
            'org-123',
            { totalAdded: 5, totalDeleted: 3, totalChanges: 8 },
            commits,
            {
                id: 'repo-arg-id',
                name: 'repo-arg-name',
                fullName: 'arg/full',
                url: 'https://example.com/repo',
            },
        );

        expect(result).toEqual({
            title: 'Add feature',
            status: 'open',
            merged: true,
            number: 42,
            url: 'https://example.com/pr/42',
            baseBranchRef: 'main',
            headBranchRef: 'feature-branch',
            repository: {
                // head.repo takes precedence over base.repo
                id: 'head-repo-id',
                name: 'head-repo',
                fullName: 'org/head-repo',
                language: '',
                url: 'https://example.com/repo',
                createdAt: NOW_ISO,
                updatedAt: NOW_ISO,
            },
            openedAt: '2026-04-01T08:00:00.000Z',
            closedAt: '2026-05-02T09:00:00.000Z',
            files: [],
            totalAdded: 5,
            totalDeleted: 3,
            totalChanges: 8,
            createdAt: '2026-04-01T08:00:00.000Z',
            updatedAt: '2026-05-02T09:30:00.000Z',
            provider: '',
            user: { id: '7', username: 'octocat' },
            reviewers: [
                { id: '11', username: '' },
                { id: '12', username: '' },
            ],
            assignees: [
                { id: '21', username: '' },
                { id: '22', username: '' },
            ],
            organizationId: 'org-123',
            commits,
            syncedEmbeddedSuggestions: false,
            syncedWithIssues: false,
            isDraft: true,
        });
    });

    it('applies every default when the PR payload is empty', () => {
        const commits: any[] = [];

        const result = transform({}, 'org-999', zeroStats, commits, {
            id: 'repo-1',
            name: 'repo-name',
            // no fullName, no url -> fall through to ''
        });

        expect(result).toEqual({
            title: '',
            status: 'unknown',
            merged: false,
            number: undefined,
            url: '',
            baseBranchRef: '',
            headBranchRef: '',
            repository: {
                id: '',
                name: '',
                fullName: '',
                language: '',
                url: '',
                createdAt: NOW_ISO,
                updatedAt: NOW_ISO,
            },
            openedAt: NOW_ISO,
            closedAt: '',
            files: [],
            totalAdded: 0,
            totalDeleted: 0,
            totalChanges: 0,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            provider: '',
            user: { id: '', username: '' },
            reviewers: [],
            assignees: [],
            organizationId: 'org-999',
            commits,
            syncedEmbeddedSuggestions: false,
            syncedWithIssues: false,
            isDraft: false,
        });
    });

    describe('merged flag (!!pr.merged_at)', () => {
        it('is true when merged_at is a non-empty string', () => {
            const result = transform(
                { merged_at: '2026-05-01T00:00:00.000Z' },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.merged).toBe(true);
        });

        it('is false when merged_at is absent', () => {
            const result = transform({}, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(result.merged).toBe(false);
        });

        it('is false when merged_at is an empty string (falsy boundary)', () => {
            const result = transform({ merged_at: '' }, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(result.merged).toBe(false);
        });
    });

    describe('repoData precedence (pr.head?.repo || pr.base?.repo)', () => {
        it('falls back to base.repo when head is missing', () => {
            const result = transform(
                {
                    base: {
                        repo: {
                            id: 'base-id',
                            name: 'base-name',
                            fullName: 'org/base',
                        },
                    },
                },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n', fullName: 'arg/full', url: 'u' },
            );
            expect(result.repository.id).toBe('base-id');
            expect(result.repository.name).toBe('base-name');
            expect(result.repository.fullName).toBe('org/base');
        });

        it('falls back to base.repo when head has no repo', () => {
            const result = transform(
                {
                    head: { ref: 'feat' },
                    base: { repo: { id: 'base-id', name: 'base-name' } },
                },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.repository.id).toBe('base-id');
        });

        it('uses pr.repositoryData.id when neither head nor base repo exists', () => {
            const result = transform(
                { repositoryData: { id: 'data-id', name: 'data-name' } },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.repository.id).toBe('data-id');
            expect(result.repository.name).toBe('data-name');
        });

        it('uses pr.repositoryId when repoData and repositoryData ids are absent', () => {
            const result = transform(
                { repositoryId: 'plain-id' },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.repository.id).toBe('plain-id');
        });
    });

    describe('branch ref fallbacks', () => {
        it('baseBranchRef prefers pr.base.ref over targetRefName', () => {
            const result = transform(
                { base: { ref: 'main' }, targetRefName: 'target' },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.baseBranchRef).toBe('main');
        });

        it('baseBranchRef falls back to targetRefName when base.ref is absent', () => {
            const result = transform(
                { targetRefName: 'target' },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.baseBranchRef).toBe('target');
        });

        it('headBranchRef prefers pr.head.ref over sourceRefName', () => {
            const result = transform(
                { head: { ref: 'feature' }, sourceRefName: 'source' },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.headBranchRef).toBe('feature');
        });

        it('headBranchRef falls back to sourceRefName when head.ref is absent', () => {
            const result = transform(
                { sourceRefName: 'source' },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.headBranchRef).toBe('source');
        });
    });

    describe('repository.fullName and url fallbacks', () => {
        it('fullName uses repository arg when repoData.fullName is absent', () => {
            const result = transform(
                { head: { repo: { id: 'x', name: 'y' } } },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n', fullName: 'arg/full' },
            );
            expect(result.repository.fullName).toBe('arg/full');
        });

        it('url comes from repository arg (empty string when absent)', () => {
            const withUrl = transform({}, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
                url: 'https://x',
            });
            expect(withUrl.repository.url).toBe('https://x');

            const withoutUrl = transform({}, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(withoutUrl.repository.url).toBe('');
        });
    });

    describe('date fallbacks', () => {
        it('openedAt/createdAt use pr.created_at when present', () => {
            const result = transform(
                { created_at: '2026-03-03T03:03:03.000Z' },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.openedAt).toBe('2026-03-03T03:03:03.000Z');
            expect(result.createdAt).toBe('2026-03-03T03:03:03.000Z');
        });

        it('openedAt/createdAt fall back to now when pr.created_at is absent', () => {
            const result = transform({}, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(result.openedAt).toBe(NOW_ISO);
            expect(result.createdAt).toBe(NOW_ISO);
        });

        it('closedAt is pr.closed_at when present, empty string otherwise', () => {
            const withClose = transform(
                { closed_at: '2026-06-06T06:06:06.000Z' },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(withClose.closedAt).toBe('2026-06-06T06:06:06.000Z');

            const withoutClose = transform({}, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(withoutClose.closedAt).toBe('');
        });

        it('updatedAt uses pr.updated_at, falling back to now', () => {
            const withUpdate = transform(
                { updated_at: '2026-07-07T07:07:07.000Z' },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(withUpdate.updatedAt).toBe('2026-07-07T07:07:07.000Z');

            const withoutUpdate = transform({}, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(withoutUpdate.updatedAt).toBe(NOW_ISO);
        });
    });

    describe('user mapping', () => {
        it('stringifies numeric user id and prefers login over name', () => {
            const result = transform(
                { user: { id: 99, login: 'the-login', name: 'the-name' } },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.user).toEqual({ id: '99', username: 'the-login' });
        });

        it('falls back to name when login is absent', () => {
            const result = transform(
                { user: { id: 1, name: 'the-name' } },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.user).toEqual({ id: '1', username: 'the-name' });
        });

        it('produces empty id and username when user is absent', () => {
            const result = transform({}, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(result.user).toEqual({ id: '', username: '' });
        });
    });

    describe('reviewers and assignees', () => {
        it('maps reviewers to stringified ids with empty username', () => {
            const result = transform(
                { reviewers: [{ id: 5 }, { id: 6 }] },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.reviewers).toEqual([
                { id: '5', username: '' },
                { id: '6', username: '' },
            ]);
        });

        it('maps participants into assignees with stringified ids', () => {
            const result = transform(
                { participants: [{ id: 8 }] },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.assignees).toEqual([{ id: '8', username: '' }]);
        });

        it('returns empty arrays when reviewers/participants are absent', () => {
            const result = transform({}, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(result.reviewers).toEqual([]);
            expect(result.assignees).toEqual([]);
        });
    });

    describe('passthrough and static fields', () => {
        it('passes commits through by reference and organizationId verbatim', () => {
            const commits = [{ sha: 'deadbeef', message: 'x' }];
            const result = transform({}, 'org-abc', zeroStats, commits, {
                id: 'r',
                name: 'n',
            });
            expect(result.commits).toBe(commits);
            expect(result.organizationId).toBe('org-abc');
        });

        it('copies fileStats totals exactly', () => {
            const result = transform(
                {},
                'o',
                { totalAdded: 100, totalDeleted: 40, totalChanges: 140 },
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.totalAdded).toBe(100);
            expect(result.totalDeleted).toBe(40);
            expect(result.totalChanges).toBe(140);
        });

        it('sets the fixed literal fields', () => {
            const result = transform({}, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(result.provider).toBe('');
            expect(result.language).toBeUndefined();
            expect(result.repository.language).toBe('');
            expect(result.files).toEqual([]);
            expect(result.syncedEmbeddedSuggestions).toBe(false);
            expect(result.syncedWithIssues).toBe(false);
        });

        it('isDraft reflects pr.isDraft, defaulting to false', () => {
            const draft = transform({ isDraft: true }, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(draft.isDraft).toBe(true);

            const notDraft = transform({ isDraft: false }, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(notDraft.isDraft).toBe(false);

            const absent = transform({}, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(absent.isDraft).toBe(false);
        });
    });

    describe('title, status and url scalar fallbacks', () => {
        it('title and url use the value when present', () => {
            const result = transform(
                { title: 'T', prURL: 'https://u' },
                'o',
                zeroStats,
                [],
                { id: 'r', name: 'n' },
            );
            expect(result.title).toBe('T');
            expect(result.url).toBe('https://u');
        });

        it('status prefers pr.state, defaulting to the literal "unknown"', () => {
            const closed = transform({ state: 'closed' }, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(closed.status).toBe('closed');

            const missing = transform({}, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(missing.status).toBe('unknown');
        });

        it('number is copied verbatim (including 0)', () => {
            const result = transform({ number: 0 }, 'o', zeroStats, [], {
                id: 'r',
                name: 'n',
            });
            expect(result.number).toBe(0);
        });
    });
});
