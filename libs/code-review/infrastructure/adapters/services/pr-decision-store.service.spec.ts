import {
    PrDecisionStoreService,
    toOutcome,
    toRecord,
    toRecordFromPrLevel,
} from './pr-decision-store.service';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
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

describe('toRecord', () => {
    it('maps every field a consumer needs, deriving outcome from implementationStatus', () => {
        const record = toRecord(
            makeSuggestion({ implementationStatus: ImplementationStatus.IMPLEMENTED }),
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
});

describe('toRecordFromPrLevel (issue #1313 Fase 1b)', () => {
    it('maps to a record with NO relevantFile and outcome always pending', () => {
        const record = toRecordFromPrLevel(makePrLevelSuggestion());

        expect(record).toEqual({
            suggestionId: 'pr-sug-1',
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
});

describe('PrDecisionStoreService.load', () => {
    function makeService(over: {
        findSuggestionsByPRAndFilenames?: jest.Mock;
        findPrLevelSuggestionsByPR?: jest.Mock;
    } = {}) {
        const repo = {
            findSuggestionsByPRAndFilenames:
                over.findSuggestionsByPRAndFilenames ??
                jest.fn().mockResolvedValue([]),
            findPrLevelSuggestionsByPR:
                over.findPrLevelSuggestionsByPR ??
                jest.fn().mockResolvedValue([]),
        };
        return { service: new PrDecisionStoreService(repo as any), repo };
    }

    it('returns an empty array without querying when filePaths is empty', async () => {
        const { service, repo } = makeService();

        const result = await service.load({
            organizationId: 'org-1',
            prNumber: 42,
            repositoryFullName: 'kodustech/kodus-ai',
            filePaths: [],
        });

        expect(result).toEqual([]);
        expect(repo.findSuggestionsByPRAndFilenames).not.toHaveBeenCalled();
        expect(repo.findPrLevelSuggestionsByPR).not.toHaveBeenCalled();
    });

    it('queries only SENT suggestions scoped to org + PR + repo fullName + filePaths', async () => {
        const { service, repo } = makeService({
            findSuggestionsByPRAndFilenames: jest
                .fn()
                .mockResolvedValue([makeSuggestion()]),
        });

        const result = await service.load({
            organizationId: 'org-1',
            prNumber: 42,
            repositoryFullName: 'kodustech/kodus-ai',
            filePaths: ['src/foo.ts'],
        });

        expect(repo.findSuggestionsByPRAndFilenames).toHaveBeenCalledWith(
            42,
            'kodustech/kodus-ai',
            ['src/foo.ts'],
            'org-1',
            DeliveryStatus.SENT,
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
            filePaths: ['src/foo.ts'],
        });

        expect(repo.findPrLevelSuggestionsByPR).toHaveBeenCalledWith(
            42,
            'kodustech/kodus-ai',
            'org-1',
            DeliveryStatus.SENT,
        );
        expect(result).toHaveLength(1);
        expect(result[0].relevantFile).toBeUndefined();
    });

    it('merges file-scoped and PR-level results together', async () => {
        const { service } = makeService({
            findSuggestionsByPRAndFilenames: jest
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
            filePaths: ['src/foo.ts'],
        });

        expect(result).toHaveLength(2);
    });

    it('fails open PER SOURCE: a file-scoped error still returns the PR-level results', async () => {
        const { service } = makeService({
            findSuggestionsByPRAndFilenames: jest
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
            filePaths: ['src/foo.ts'],
        });

        expect(result).toHaveLength(1);
        expect(result[0].relevantFile).toBeUndefined();
    });

    it('fails open PER SOURCE: a PR-level error still returns the file-scoped results', async () => {
        const { service } = makeService({
            findSuggestionsByPRAndFilenames: jest
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
            filePaths: ['src/foo.ts'],
        });

        expect(result).toHaveLength(1);
        expect(result[0].relevantFile).toBe('src/foo.ts');
    });

    it('fails open entirely: both sources erroring returns an empty list, never throws', async () => {
        const { service } = makeService({
            findSuggestionsByPRAndFilenames: jest
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
                filePaths: ['src/foo.ts'],
            }),
        ).resolves.toEqual([]);
    });
});
