import {
    BuildPreviousReviewDecisionsUseCase,
    capDecisions,
} from './build-previous-review-decisions.use-case';
import {
    MAX_PR_DECISIONS,
    type PrDecisionRecord,
} from '@libs/code-review/domain/contracts/pr-decision-store.contract';

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
    // No per-file cap (#2020): a file's older suggestions must not drop out of
    // the history while other files are quiet, and code moves between files
    // across rounds — one cap over the whole PR, most recent first.
    it('keeps every suggestion of one file while under the cap, most recent first', () => {
        const decisions = Array.from({ length: 8 }, (_, i) =>
            makeRecord({
                suggestionId: `sug-${i}`,
                decidedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
            }),
        );

        const result = capDecisions(decisions);

        expect(result).toHaveLength(8);
        expect(result[0].suggestionId).toBe('sug-7');
        expect(result[7].suggestionId).toBe('sug-0');
    });

    it(`caps the whole PR at ${MAX_PR_DECISIONS}, keeping the most recent overall`, () => {
        const files = Array.from({ length: 10 }, (_, f) => `src/file-${f}.ts`);
        const decisions = files.flatMap((file, f) =>
            Array.from({ length: 5 }, (_, i) =>
                makeRecord({
                    suggestionId: `${file}-${i}`,
                    relevantFile: file,
                    // Later files get later timestamps so the "most recent"
                    // slice is deterministic to assert on.
                    decidedAt: `2026-${String(f + 1).padStart(2, '0')}-0${i + 1}T00:00:00.000Z`,
                }),
            ),
        );

        const result = capDecisions(decisions);

        expect(result).toHaveLength(MAX_PR_DECISIONS);
        // 10 files * 5 = 50 > 40: the two oldest files drop out entirely.
        const keptFiles = new Set(result.map((r) => r.relevantFile));
        expect(keptFiles.has('src/file-9.ts')).toBe(true);
        expect(keptFiles.has('src/file-2.ts')).toBe(true);
        expect(keptFiles.has('src/file-1.ts')).toBe(false);
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

    it('ranks PR-level decisions (relevantFile undefined) with the file-level ones by date (issue #1313 Fase 1b)', () => {
        const decisions = [
            makeRecord({ suggestionId: 'pr-old', relevantFile: undefined, decidedAt: '2026-01-01T00:00:00.000Z' }),
            makeRecord({ suggestionId: 'file-new', relevantFile: 'a.ts', decidedAt: '2026-01-03T00:00:00.000Z' }),
            makeRecord({ suggestionId: 'pr-new', relevantFile: undefined, decidedAt: '2026-01-02T00:00:00.000Z' }),
        ];

        expect(capDecisions(decisions).map((r) => r.suggestionId)).toEqual(['file-new', 'pr-new', 'pr-old']);
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
                }),
        ).rejects.toThrow('Mongo unavailable');
    });

    it('applies capDecisions to whatever the store returns', async () => {
        const decisions = Array.from({ length: MAX_PR_DECISIONS + 5 }, (_, i) =>
            makeRecord({ suggestionId: `sug-${i}`, decidedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }),
        );
        const store = { load: jest.fn().mockResolvedValue(decisions) };
        const useCase = new BuildPreviousReviewDecisionsUseCase(store as any);

        const result = await useCase.execute({
            organizationId: 'org-1',
            prNumber: 1,
            repositoryFullName: 'kodustech/kodus-ai',
        });

        expect(result).toHaveLength(MAX_PR_DECISIONS);
        expect(result[0].suggestionId).toBe(`sug-${MAX_PR_DECISIONS + 4}`);
    });
});
