import {
    PrDecisionStoreService,
    toOutcome,
    toRecord,
    toRecordFromPrLevel,
} from './pr-decision-store.service';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { MAX_PR_DECISIONS } from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import type {
    ISuggestion,
    ISuggestionByPR,
} from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

function makeSuggestion(overrides: Partial<ISuggestion> = {}): ISuggestion {
    return {
        id: 'sug-1',
        relevantFile: 'src/foo.ts',
        language: 'typescript',
        suggestionContent: 'Use const instead of let.',
        existingCode: '',
        improvedCode: '',
        oneSentenceSummary: 'Use const.',
        relevantLinesStart: 10,
        relevantLinesEnd: 12,
        label: 'bug',
        severity: 'medium',
        priorityStatus: undefined as any,
        deliveryStatus: DeliveryStatus.SENT,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    } as ISuggestion;
}

function makePrLevelSuggestion(
    overrides: Partial<ISuggestionByPR> = {},
): ISuggestionByPR {
    return {
        id: 'pr-sug-1',
        suggestionContent: 'Split this into two migrations.',
        oneSentenceSummary: 'One migration = one logical change.',
        label: 'bug' as any,
        deliveryStatus: DeliveryStatus.SENT,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    } as ISuggestionByPR;
}

describe('toOutcome', () => {
    it('maps IMPLEMENTED to implemented', () => {
        expect(toOutcome(ImplementationStatus.IMPLEMENTED)).toBe('implemented');
    });

    it('maps PARTIALLY_IMPLEMENTED to partially_implemented', () => {
        expect(toOutcome(ImplementationStatus.PARTIALLY_IMPLEMENTED)).toBe(
            'partially_implemented',
        );
    });

    it('maps NOT_IMPLEMENTED to not_implemented (never "rejected")', () => {
        expect(toOutcome(ImplementationStatus.NOT_IMPLEMENTED)).toBe(
            'not_implemented',
        );
    });

    it('maps undefined to pending — the async implementation-check race (issue #1313)', () => {
        expect(toOutcome(undefined)).toBe('pending');
    });
});

describe('decision records read the full explanation', () => {
    it('file-level: prefers fullExplanation over the short body', () => {
        const record = toRecord({
            id: 's-1',
            suggestionContent: 'Short body.',
            fullExplanation: 'The whole explanation.',
        } as any);
        expect(record.suggestionContent).toBe('The whole explanation.');
    });

    it('PR-level: prefers fullExplanation, falls back to the body for older records', () => {
        expect(
            toRecordFromPrLevel({
                id: 'p-1',
                suggestionContent: 'Short.',
                fullExplanation: 'Whole.',
            } as any).suggestionContent,
        ).toBe('Whole.');
        expect(
            toRecordFromPrLevel({
                id: 'p-2',
                suggestionContent: 'Legacy.',
            } as any).suggestionContent,
        ).toBe('Legacy.');
    });
});

describe('toRecord', () => {
    it('maps every field a consumer needs, deriving outcome from implementationStatus', () => {
        const record = toRecord(
            makeSuggestion({
                implementationStatus: ImplementationStatus.IMPLEMENTED,
            }),
        );

        expect(record).toEqual({
            suggestionId: 'sug-1',
            relevantFile: 'src/foo.ts',
            relevantLinesStart: 10,
            relevantLinesEnd: 12,
            suggestionContent: 'Use const instead of let.',
            label: 'bug',
            outcome: 'implemented',
            decidedAt: '2026-01-01T00:00:00.000Z',
        });
    });

    it('passes brokenKodyRulesIds through so the sharded judge can resolve the rule identity (PR #1895 review)', () => {
        const record = toRecord(
            makeSuggestion({
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-uuid-1'],
            }),
        );

        expect(record.brokenKodyRulesIds).toEqual(['rule-uuid-1']);
    });

    it('leaves brokenKodyRulesIds absent when the source suggestion never got one (LLM omitted ruleUuid, or legacy record)', () => {
        const record = toRecord(makeSuggestion({ label: 'kody_rules' }));

        expect(record.brokenKodyRulesIds).toBeUndefined();
    });
});

describe('toRecordFromPrLevel (issue #1313 Fase 1b)', () => {
    it('maps to a record with NO relevantFile and outcome always pending', () => {
        const record = toRecordFromPrLevel(makePrLevelSuggestion());

        expect(record).toEqual({
            suggestionId: expect.stringMatching(/^pr-/),
            suggestionContent: 'Split this into two migrations.',
            label: 'bug',
            outcome: 'pending',
            decidedAt: '2026-01-01T00:00:00.000Z',
        });
        expect('relevantFile' in record).toBe(false);
    });

    it('defaults decidedAt to empty string when createdAt is missing (legacy data)', () => {
        const record = toRecordFromPrLevel(
            makePrLevelSuggestion({ createdAt: undefined }),
        );
        expect(record.decidedAt).toBe('');
    });

    it('gives legacy comments with a repeated rule id stable, distinct references', () => {
        const newer = makePrLevelSuggestion({
            id: 'rule-1',
            comment: { id: 102, pullRequestReviewId: null as any },
        });
        const older = makePrLevelSuggestion({
            id: 'rule-1',
            comment: { id: 101, pullRequestReviewId: null as any },
        });
        expect(toRecordFromPrLevel(newer).suggestionId).not.toBe(
            toRecordFromPrLevel(older).suggestionId,
        );
        expect(toRecordFromPrLevel(newer).suggestionId).toBe(
            toRecordFromPrLevel({ ...newer }).suggestionId,
        );
    });

    it('distinguishes legacy suggestions without comment metadata by their recorded date and content', () => {
        const base = makePrLevelSuggestion({
            id: 'rule-1',
            comment: undefined,
        });
        const ids = [
            base,
            { ...base, createdAt: '2026-01-02T00:00:00.000Z' },
            { ...base, suggestionContent: 'A different issue.' },
        ].map((s) => toRecordFromPrLevel(s).suggestionId);
        expect(new Set(ids).size).toBe(3);
        expect(toRecordFromPrLevel({ ...base }).suggestionId).toBe(ids[0]);
    });

    it('passes brokenKodyRulesIds through for a PR-level kody_rules decision (PR #1895 review)', () => {
        const record = toRecordFromPrLevel(
            makePrLevelSuggestion({
                label: 'kody_rules' as any,
                brokenKodyRulesIds: ['rule-uuid-1'],
            }),
        );

        expect(record.brokenKodyRulesIds).toEqual(['rule-uuid-1']);
    });

    it('leaves brokenKodyRulesIds absent for a PR-level kody_rules decision with none (agent-review.stage.ts:1527 fallback path)', () => {
        const record = toRecordFromPrLevel(
            makePrLevelSuggestion({ label: 'kody_rules' as any }),
        );

        expect(record.brokenKodyRulesIds).toBeUndefined();
    });
});

describe('PrDecisionStoreService.load', () => {
    function makeService(
        over: {
            findSuggestionsOnPR?: jest.Mock;
            findPrLevelSuggestionsByPR?: jest.Mock;
        } = {},
    ) {
        const repo = {
            findSuggestionsOnPR:
                over.findSuggestionsOnPR ?? jest.fn().mockResolvedValue([]),
            findPrLevelSuggestionsByPR:
                over.findPrLevelSuggestionsByPR ??
                jest.fn().mockResolvedValue([]),
        };
        return { service: new PrDecisionStoreService(repo as any), repo };
    }

    // The whole PR, not the files of the current diff (#2020): a finding can
    // repeat a suggestion anchored on a file the code moved out of.
    it('queries the most recent SENT suggestions on the whole PR, scoped to org + PR + repo fullName', async () => {
        const { service, repo } = makeService({
            findSuggestionsOnPR: jest
                .fn()
                .mockResolvedValue([makeSuggestion()]),
        });

        const result = await service.load({
            organizationId: 'org-1',
            prNumber: 42,
            repositoryFullName: 'kodustech/kodus-ai',
        });

        expect(repo.findSuggestionsOnPR).toHaveBeenCalledWith(
            42,
            'kodustech/kodus-ai',
            'org-1',
            DeliveryStatus.SENT,
            MAX_PR_DECISIONS,
        );
        expect(result).toHaveLength(1);
    });

    it('also queries PR-level suggestions scoped to org + PR + repo fullName (no file filter)', async () => {
        const { service, repo } = makeService({
            findPrLevelSuggestionsByPR: jest
                .fn()
                .mockResolvedValue([makePrLevelSuggestion()]),
        });

        const result = await service.load({
            organizationId: 'org-1',
            prNumber: 42,
            repositoryFullName: 'kodustech/kodus-ai',
        });

        // Same cap as the file-level read: PR-level history is not cut at 5.
        expect(repo.findPrLevelSuggestionsByPR).toHaveBeenCalledWith(
            42,
            'kodustech/kodus-ai',
            'org-1',
            DeliveryStatus.SENT,
            MAX_PR_DECISIONS,
        );
        expect(result).toHaveLength(1);
        expect(result[0].relevantFile).toBeUndefined();
    });

    it('merges file-scoped and PR-level results together', async () => {
        const { service } = makeService({
            findSuggestionsOnPR: jest
                .fn()
                .mockResolvedValue([makeSuggestion()]),
            findPrLevelSuggestionsByPR: jest
                .fn()
                .mockResolvedValue([makePrLevelSuggestion()]),
        });

        const result = await service.load({
            organizationId: 'org-1',
            prNumber: 42,
            repositoryFullName: 'kodustech/kodus-ai',
        });

        expect(result).toHaveLength(2);
    });

    it('fails open PER SOURCE: a file-scoped error still returns the PR-level results', async () => {
        const { service } = makeService({
            findSuggestionsOnPR: jest
                .fn()
                .mockRejectedValue(new Error('Mongo unavailable')),
            findPrLevelSuggestionsByPR: jest
                .fn()
                .mockResolvedValue([makePrLevelSuggestion()]),
        });

        const result = await service.load({
            organizationId: 'org-1',
            prNumber: 42,
            repositoryFullName: 'kodustech/kodus-ai',
        });

        expect(result).toHaveLength(1);
        expect(result[0].relevantFile).toBeUndefined();
    });

    it('fails open PER SOURCE: a PR-level error still returns the file-scoped results', async () => {
        const { service } = makeService({
            findSuggestionsOnPR: jest
                .fn()
                .mockResolvedValue([makeSuggestion()]),
            findPrLevelSuggestionsByPR: jest
                .fn()
                .mockRejectedValue(new Error('Mongo unavailable')),
        });

        const result = await service.load({
            organizationId: 'org-1',
            prNumber: 42,
            repositoryFullName: 'kodustech/kodus-ai',
        });

        expect(result).toHaveLength(1);
        expect(result[0].relevantFile).toBe('src/foo.ts');
    });

    it('fails open entirely: both sources erroring returns an empty list, never throws', async () => {
        const { service } = makeService({
            findSuggestionsOnPR: jest
                .fn()
                .mockRejectedValue(new Error('Mongo unavailable')),
            findPrLevelSuggestionsByPR: jest
                .fn()
                .mockRejectedValue(new Error('Mongo unavailable')),
        });

        await expect(
            service.load({
                organizationId: 'org-1',
                prNumber: 42,
                repositoryFullName: 'kodustech/kodus-ai',
            }),
        ).resolves.toEqual([]);
    });
});
