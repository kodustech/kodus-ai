import {
    BuildPreviousReviewDecisionsUseCase,
    capDecisions,
} from './build-previous-review-decisions.use-case';
import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';

function makeRecord(
    overrides: Partial<PrDecisionRecord> = {},
): PrDecisionRecord {
    return {
        suggestionId: 'sug-1',
        relevantFile: 'src/foo.ts',
        suggestionContent: 'content',
        label: 'bug',
        outcome: 'implemented',
        decidedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('capDecisions', () => {
    it('keeps at most 5 decisions per file, most recent first', () => {
        const decisions = Array.from({ length: 8 }, (_, i) =>
            makeRecord({
                suggestionId: `sug-${i}`,
                decidedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
            }),
        );

        const result = capDecisions(decisions);

        expect(result).toHaveLength(5);
        // Most recent (2026-01-08) first.
        expect(result[0].suggestionId).toBe('sug-7');
        expect(result[4].suggestionId).toBe('sug-3');
    });

    it('caps the total across files at 30, keeping the most recent overall', () => {
        const files = Array.from({ length: 10 }, (_, f) => `src/file-${f}.ts`);
        const decisions = files.flatMap((file, f) =>
            Array.from({ length: 5 }, (_, i) =>
                makeRecord({
                    suggestionId: `${file}-${i}`,
                    relevantFile: file,
                    // Later files get later timestamps so the "most recent 30"
                    // slice is deterministic to assert on.
                    decidedAt: `2026-${String(f + 1).padStart(2, '0')}-0${i + 1}T00:00:00.000Z`,
                }),
            ),
        );

        const result = capDecisions(decisions);

        expect(result).toHaveLength(30);
        // Every kept record comes from one of the 6 most recent files
        // (10 files * 5 each = 50 > 30, so the oldest 4 files' decisions
        // are entirely dropped by the overall cap).
        const keptFiles = new Set(result.map((r) => r.relevantFile));
        expect(keptFiles.has('src/file-9.ts')).toBe(true);
        expect(keptFiles.has('src/file-0.ts')).toBe(false);
    });

    it('does not throw when a record has no decidedAt (legacy data predating the field) — sorts it last', () => {
        const decisions = [
            makeRecord({ suggestionId: 'legacy', decidedAt: undefined as any }),
            makeRecord({
                suggestionId: 'recent',
                decidedAt: '2026-06-01T00:00:00.000Z',
            }),
        ];

        let result: PrDecisionRecord[] = [];
        expect(() => {
            result = capDecisions(decisions);
        }).not.toThrow();
        expect(result.map((r) => r.suggestionId)).toEqual(['recent', 'legacy']);
    });

    it('does not mix files together when applying the per-file cap', () => {
        const decisions = [
            makeRecord({ suggestionId: 'a', relevantFile: 'a.ts' }),
            makeRecord({ suggestionId: 'b', relevantFile: 'b.ts' }),
        ];

        const result = capDecisions(decisions);

        expect(result).toHaveLength(2);
    });

    it('buckets PR-level decisions (relevantFile undefined) together, capped like any file (issue #1313 Fase 1b)', () => {
        const decisions = [
            ...Array.from({ length: 7 }, (_, i) =>
                makeRecord({
                    suggestionId: `pr-${i}`,
                    relevantFile: undefined,
                    decidedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
                }),
            ),
            makeRecord({ suggestionId: 'file-1', relevantFile: 'a.ts' }),
        ];

        const result = capDecisions(decisions);

        const prLevel = result.filter((r) => r.relevantFile === undefined);
        expect(prLevel).toHaveLength(5); // per-bucket cap applies here too
        expect(result.some((r) => r.suggestionId === 'file-1')).toBe(true);
    });
});

describe('BuildPreviousReviewDecisionsUseCase', () => {
    it('returns an empty array without capping when the store has nothing', async () => {
        const store = { load: jest.fn().mockResolvedValue([]) };
        const useCase = new BuildPreviousReviewDecisionsUseCase(store as any);

        const result = await useCase.execute({
            organizationId: 'org-1',
            prNumber: 1,
            repositoryFullName: 'kodustech/kodus-ai',
            filePaths: ['src/foo.ts'],
        });

        expect(result).toEqual([]);
    });

    it('propagates a store.load() rejection instead of swallowing it — fail-open is the caller stage\'s job, not this use-case\'s', async () => {
        const store = {
            load: jest.fn().mockRejectedValue(new Error('Mongo unavailable')),
        };
        const useCase = new BuildPreviousReviewDecisionsUseCase(store as any);

        await expect(
            useCase.execute({
                organizationId: 'org-1',
                prNumber: 1,
                repositoryFullName: 'kodustech/kodus-ai',
                filePaths: ['src/foo.ts'],
            }),
        ).rejects.toThrow('Mongo unavailable');
    });

    it('applies capDecisions to whatever the store returns', async () => {
        const decisions = Array.from({ length: 6 }, (_, i) =>
            makeRecord({ suggestionId: `sug-${i}`, decidedAt: `2026-01-0${i + 1}T00:00:00.000Z` }),
        );
        const store = { load: jest.fn().mockResolvedValue(decisions) };
        const useCase = new BuildPreviousReviewDecisionsUseCase(store as any);

        const result = await useCase.execute({
            organizationId: 'org-1',
            prNumber: 1,
            repositoryFullName: 'kodustech/kodus-ai',
            filePaths: ['src/foo.ts'],
        });

        expect(result).toHaveLength(5);
    });
});
