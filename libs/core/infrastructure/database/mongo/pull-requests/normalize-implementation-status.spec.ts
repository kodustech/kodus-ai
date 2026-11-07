import { normalizeSuggestionImplementationStatus } from './normalize-implementation-status';

function fakeDb(distinct: unknown[], counts: Record<string, number> = {}) {
    const updateMany = jest.fn(async (filter: any) => ({
        modifiedCount:
            counts[filter['files.suggestions.implementationStatus']] ?? 1,
    }));
    const collection = {
        distinct: jest.fn().mockResolvedValue(distinct),
        countDocuments: jest.fn().mockResolvedValue(5),
        updateMany,
    };
    return { db: { collection: jest.fn(() => collection) } as any, collection };
}

describe('normalizeSuggestionImplementationStatus', () => {
    it('rewrites each spelling that maps to one status, and nothing else', async () => {
        const { db, collection } = fakeDb(
            [
                'implemented',
                'not_implemented',
                'IMPLEMENTED',
                'PARTIALLY_IMPLEMENTED',
                'not implemented',
                'The suggestion was applied.',
                null,
            ],
            {
                'IMPLEMENTED': 4,
                'PARTIALLY_IMPLEMENTED': 2,
                'not implemented': 3,
            },
        );

        const result = await normalizeSuggestionImplementationStatus(db);

        expect(db.collection).toHaveBeenCalledWith('pullRequests');
        expect(collection.updateMany.mock.calls).toEqual([
            [
                { 'files.suggestions.implementationStatus': 'IMPLEMENTED' },
                {
                    $set: {
                        'files.$[f].suggestions.$[s].implementationStatus':
                            'implemented',
                    },
                },
                {
                    arrayFilters: [
                        { 'f.suggestions.implementationStatus': 'IMPLEMENTED' },
                        { 's.implementationStatus': 'IMPLEMENTED' },
                    ],
                },
            ],
            [
                {
                    'files.suggestions.implementationStatus':
                        'PARTIALLY_IMPLEMENTED',
                },
                {
                    $set: {
                        'files.$[f].suggestions.$[s].implementationStatus':
                            'partially_implemented',
                    },
                },
                {
                    arrayFilters: [
                        {
                            'f.suggestions.implementationStatus':
                                'PARTIALLY_IMPLEMENTED',
                        },
                        { 's.implementationStatus': 'PARTIALLY_IMPLEMENTED' },
                    ],
                },
            ],
            [
                { 'files.suggestions.implementationStatus': 'not implemented' },
                {
                    $set: {
                        'files.$[f].suggestions.$[s].implementationStatus':
                            'not_implemented',
                    },
                },
                {
                    arrayFilters: [
                        {
                            'f.suggestions.implementationStatus':
                                'not implemented',
                        },
                        { 's.implementationStatus': 'not implemented' },
                    ],
                },
            ],
        ]);
        expect(result).toEqual({
            rewritten: {
                'IMPLEMENTED': 4,
                'PARTIALLY_IMPLEMENTED': 2,
                'not implemented': 3,
            },
            leftAlone: ['The suggestion was applied.'],
        });
    });

    it('only counts the pull requests it would change on a dry run', async () => {
        const { db, collection } = fakeDb(['IMPLEMENTED']);

        const result = await normalizeSuggestionImplementationStatus(db, {
            dryRun: true,
        });

        expect(collection.updateMany).not.toHaveBeenCalled();
        expect(collection.countDocuments).toHaveBeenCalledWith({
            'files.suggestions.implementationStatus': 'IMPLEMENTED',
        });
        expect(result.rewritten).toEqual({ IMPLEMENTED: 5 });
    });
});
