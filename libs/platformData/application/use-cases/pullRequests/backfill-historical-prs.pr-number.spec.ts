import { BackfillHistoricalPRsUseCase } from './backfill-historical-prs.use-case';

/**
 * Providers do not agree on what the pull request number is called.
 *
 * The GitHub adapter emits `number` (plus a legacy `pull_number` alias, with a
 * TODO next to it). The GitLab adapter emitted only `pull_number`, carrying
 * `iid`. This use case read `number`, so every GitLab merge request came
 * through as `undefined`: two hours of production logged 68 `Error saving PR
 * #undefined` and 68 `Could not fetch files/commits for PR #undefined` — the
 * same 68 merge requests, failing twice, with no identifier to chase either
 * one by.
 *
 * The document is keyed on that field, so the undefined is also what failed the
 * save. Nothing was backfilled for those repositories, and the log could not
 * say which ones.
 */
describe('BackfillHistoricalPRsUseCase — the pull request number across providers', () => {
    const useCase = Object.create(
        BackfillHistoricalPRsUseCase.prototype,
    ) as BackfillHistoricalPRsUseCase;

    const transform = (pr: Record<string, unknown>) =>
        (useCase as never as {
            transformPullRequestToDocument: (
                pr: unknown,
                orgId: string,
                fileStats: unknown,
                commits: unknown,
                repository: unknown,
            ) => { number?: number };
        }).transformPullRequestToDocument(
            pr,
            'org-1',
            { totalAdditions: 0, totalDeletions: 0, totalChanges: 0, totalFiles: 0 },
            [],
            { id: 'repo-1', name: 'api' },
        );

    it('reads the GitHub shape', () => {
        expect(transform({ number: 4321, pull_number: 4321 }).number).toBe(4321);
    });

    it('reads the GitLab shape, which only carries pull_number', () => {
        expect(transform({ pull_number: 175 }).number).toBe(175);
    });

    it('prefers `number` when a provider sends both', () => {
        // Not interchangeable in principle — if they ever disagree, `number` is
        // the canonical one and the alias is the legacy copy.
        expect(transform({ number: 10, pull_number: 99 }).number).toBe(10);
    });

    it('does not turn a real zero into a missing number', () => {
        // `||` would have swallowed 0 here. No provider numbers a PR zero
        // today, but the coalescing operator is the correct one regardless and
        // this pins it.
        expect(transform({ number: 0, pull_number: 7 }).number).toBe(0);
    });
});
