import { PullRequestsRepository } from './pullRequests.repository';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

/**
 * Regression coverage for the cross-organization data leak that allowed
 * mutations on PR#X / repo "foo" of org A to land on PR#X / repo "foo" of
 * org B (because Mongo filters were missing organizationId).
 *
 * If any of these tests fails, someone has either dropped the organizationId
 * filter on a write/read path that needs it, or has stopped propagating the
 * organizationAndTeamData parameter — either of which reopens the leak.
 */
describe('PullRequestsRepository — multi-tenant filter coverage', () => {
    const ORG: OrganizationAndTeamData = {
        organizationId: 'org-A',
        teamId: 'team-1',
    };

    let model: any;
    let repo: PullRequestsRepository;
    let findOneAndUpdate: jest.Mock;
    let aggregate: jest.Mock;
    let exec: jest.Mock;

    beforeEach(() => {
        exec = jest.fn().mockResolvedValue(null);
        findOneAndUpdate = jest.fn().mockReturnValue({ exec });
        aggregate = jest.fn().mockReturnValue({ exec });

        model = {
            findOneAndUpdate,
            aggregate,
        };

        // The repository only depends on the `pullRequestsModel` field,
        // so constructing without Nest DI keeps the test focused.
        repo = new PullRequestsRepository(model as any);
    });

    describe('addFileToPullRequest', () => {
        it('includes organizationId in the Mongo filter', async () => {
            await repo.addFileToPullRequest(
                42,
                'cal.com',
                {
                    path: 'src/foo.ts',
                    sha: 'abc',
                    filename: 'foo.ts',
                    previousName: '',
                    status: 'added',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    suggestions: [],
                    added: 1,
                    deleted: 0,
                    changes: 1,
                } as any,
                ORG,
            );

            expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
            const filter = findOneAndUpdate.mock.calls[0][0];
            expect(filter).toMatchObject({
                'number': 42,
                'repository.name': 'cal.com',
                'organizationId': 'org-A',
            });
        });

        it('uses the organizationId from the argument, not a hardcoded value', async () => {
            await repo.addFileToPullRequest(
                42,
                'cal.com',
                {} as any,
                { organizationId: 'org-B', teamId: 'team-1' },
            );

            const filter = findOneAndUpdate.mock.calls[0][0];
            expect(filter.organizationId).toBe('org-B');
        });
    });

    describe('addSuggestionToFile', () => {
        it('includes organizationId AND files.id in the Mongo filter', async () => {
            await repo.addSuggestionToFile(
                'file-id-1',
                { suggestionContent: 'x' } as any,
                42,
                'cal.com',
                ORG,
            );

            expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
            const filter = findOneAndUpdate.mock.calls[0][0];
            expect(filter).toMatchObject({
                'number': 42,
                'repository.name': 'cal.com',
                'organizationId': 'org-A',
                'files.id': 'file-id-1',
            });
        });
    });

    describe('updateFile', () => {
        it('includes organizationId in the Mongo filter (defense in depth on top of files.id)', async () => {
            await repo.updateFile(
                'file-id-1',
                { status: 'modified' } as any,
                ORG,
            );

            expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
            const filter = findOneAndUpdate.mock.calls[0][0];
            expect(filter).toMatchObject({
                'files.id': 'file-id-1',
                'organizationId': 'org-A',
            });
        });
    });

    describe('updateSuggestion', () => {
        it('includes organizationId in the Mongo filter (defense in depth on top of suggestions.id)', async () => {
            await repo.updateSuggestion(
                'sugg-id-1',
                { implementationStatus: 'IMPLEMENTED' } as any,
                ORG,
            );

            expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
            const filter = findOneAndUpdate.mock.calls[0][0];
            expect(filter).toMatchObject({
                'files.suggestions.id': 'sugg-id-1',
                'organizationId': 'org-A',
            });
        });
    });

    describe('findFileWithSuggestions', () => {
        it('includes organizationId in the aggregation $match', async () => {
            // aggregate().exec() must resolve to an array
            (exec as jest.Mock).mockResolvedValueOnce([]);

            await repo.findFileWithSuggestions(
                42,
                'cal.com',
                'src/foo.ts',
                ORG,
            );

            expect(aggregate).toHaveBeenCalledTimes(1);
            const pipeline = aggregate.mock.calls[0][0];
            const firstMatch = pipeline[0]?.$match;
            expect(firstMatch).toMatchObject({
                'number': 42,
                'repository.name': 'cal.com',
                'organizationId': 'org-A',
            });
        });
    });

    describe('regression — distinct orgs, same PR# + repo name', () => {
        // Simulates what happened in production: 8 different orgs running
        // benchmarks against the same forked repos (cal.com, sentry, ...).
        // findOneAndUpdate is supposed to scope to one org per call; the
        // test asserts each call carries its own organizationId so two
        // concurrent calls cannot collide on the same document.
        it('two calls with the same PR# and repo name but different orgs send different filters', async () => {
            await repo.addFileToPullRequest(
                5,
                'cal.com',
                { path: 'a.ts' } as any,
                { organizationId: 'org-A', teamId: 't' },
            );
            await repo.addFileToPullRequest(
                5,
                'cal.com',
                { path: 'b.ts' } as any,
                { organizationId: 'org-B', teamId: 't' },
            );

            expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
            expect(findOneAndUpdate.mock.calls[0][0].organizationId).toBe(
                'org-A',
            );
            expect(findOneAndUpdate.mock.calls[1][0].organizationId).toBe(
                'org-B',
            );
        });
    });
});
