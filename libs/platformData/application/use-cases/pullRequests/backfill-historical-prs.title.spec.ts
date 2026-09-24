import { BackfillHistoricalPRsUseCase } from './backfill-historical-prs.use-case';

/**
 * Regression coverage for prod incident (157 occurrences, 1 org):
 * "PullRequestsModel validation failed: title: Path `title` is required."
 *
 * `title: pr.title || ''` looked like a defensive fallback but wasn't one:
 * `PullRequestsModel` declares `title` as a required Mongoose String, and
 * Mongoose's default required-check for a String path tests `.length`, not
 * just null/undefined — an empty string fails it identically to a missing
 * value. Confirmed against this repo's actual mongoose version
 * (`SchemaString._checkRequired = v => (...) && v.length`) and reproduced
 * with `new Model({ title: '' }).validateSync()`, which throws the exact
 * same "Path `title` is required." message. Every PR whose provider sent an
 * empty/falsy title (not just `undefined`) still failed the save.
 */
describe('BackfillHistoricalPRsUseCase — falls back to a non-empty title', () => {
    const useCase = Object.create(
        BackfillHistoricalPRsUseCase.prototype,
    ) as BackfillHistoricalPRsUseCase;

    const transform = (pr: Record<string, unknown>) =>
        (
            useCase as never as {
                transformPullRequestToDocument: (
                    pr: unknown,
                    orgId: string,
                    fileStats: unknown,
                    commits: unknown,
                    repository: unknown,
                ) => { title?: string };
            }
        ).transformPullRequestToDocument(
            pr,
            'org-1',
            {
                totalAdditions: 0,
                totalDeletions: 0,
                totalChanges: 0,
                totalFiles: 0,
            },
            [],
            { id: 'repo-1', name: 'api' },
        );

    it('keeps a real title untouched', () => {
        expect(transform({ number: 1, title: 'Fix the bug' }).title).toBe(
            'Fix the bug',
        );
    });

    it('falls back to a non-empty placeholder when title is an empty string', () => {
        const title = transform({ number: 1, title: '' }).title;
        expect(title).toBeTruthy();
        expect(title).not.toBe('');
    });

    it('falls back to a non-empty placeholder when title is missing entirely', () => {
        const title = transform({ number: 1 }).title;
        expect(title).toBeTruthy();
        expect(title).not.toBe('');
    });
});
