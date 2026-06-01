import { KodyFineTuningService } from '@libs/kodyFineTuning/infrastructure/adapters/services/kodyFineTuning.service';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

// Bug C2 regression — k-means was being fed a raw
// `suggestions.map(s => s.suggestionEmbed)` array, which could include
// null/undefined (embedding call failed) or vectors of different
// dimensions. ml-kmeans throws cryptically or produces garbage clusters.
// The fix filters invalid vectors and validates dimensions before clustering.
describe('KodyFineTuningService.clusterizeSuggestions — Bug C2', () => {
    let service: KodyFineTuningService;

    const buildSuggestion = (id: string, embed: any) =>
        ({
            uuid: `uuid-${id}`,
            suggestionId: id,
            suggestionContent: `content ${id}`,
            oneSentenceSummary: `summary ${id}`,
            suggestionEmbed: embed,
            improvedCode: '',
            severity: 'medium',
            label: 'x',
            feedbackType: 'positive',
            pullRequestNumber: 1,
            repositoryId: 'r',
            repositoryFullName: 'org/r',
            organization: { uuid: 'o' },
            language: 'typescript',
        }) as any;

    const validVec384 = (seed: number) =>
        Array.from({ length: 384 }, (_, i) => (seed + i) / 384);

    beforeEach(() => {
        const globalParametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    maxClusters: 10,
                    divisorForClusterQuantity: 2,
                },
            }),
        };

        service = new KodyFineTuningService(
            {} as any, // pullRequestsService
            {} as any, // codeReviewFeedbackService
            {} as any, // suggestionEmbeddedService
            globalParametersService as any,
        );
    });

    it('does not crash when some embeddings are null (skips invalid entries)', async () => {
        const suggestions = [
            buildSuggestion('a', null),
            buildSuggestion('b', validVec384(0.1)),
            buildSuggestion('c', undefined),
            buildSuggestion('d', validVec384(0.9)),
        ];

        const result = await service.clusterizeSuggestions(suggestions);

        // Only the two valid vectors cluster; null/undefined are dropped.
        expect(result).toHaveLength(2);
        expect(result.map((r) => r.suggestionId).sort()).toEqual(['b', 'd']);
        expect(result.every((r) => typeof r.cluster === 'number')).toBe(true);
    });

    it('does not crash when vectors have mismatched dimensions', async () => {
        const suggestions = [
            buildSuggestion('a', validVec384(0.1)),
            buildSuggestion('b', [1, 2, 3]), // wrong dimension
            buildSuggestion('c', validVec384(0.5)),
        ];

        const result = await service.clusterizeSuggestions(suggestions);

        // Only the 384-dim vectors are kept.
        expect(result).toHaveLength(2);
        expect(result.map((r) => r.suggestionId).sort()).toEqual(['a', 'c']);
    });

    it('returns an empty array when no valid vectors remain', async () => {
        const suggestions = [
            buildSuggestion('a', null),
            buildSuggestion('b', undefined),
        ];

        const result = await service.clusterizeSuggestions(suggestions);

        expect(result).toEqual([]);
    });

    it('preserves clustering for all-valid input (regression)', async () => {
        const suggestions = [
            buildSuggestion('a', validVec384(0.0)),
            buildSuggestion('b', validVec384(0.25)),
            buildSuggestion('c', validVec384(0.5)),
            buildSuggestion('d', validVec384(0.75)),
        ];

        const result = await service.clusterizeSuggestions(suggestions);

        expect(result).toHaveLength(4);
        expect(result.map((r) => r.suggestionId).sort()).toEqual([
            'a',
            'b',
            'c',
            'd',
        ]);
    });
});
