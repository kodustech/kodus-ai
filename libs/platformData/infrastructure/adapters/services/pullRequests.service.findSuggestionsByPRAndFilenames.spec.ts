import { PullRequestsService } from './pullRequests.service';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';

describe('PullRequestsService.findSuggestionsByPRAndFilenames (issue #1313)', () => {
    it('delegates to the repository with the exact same arguments, in order', async () => {
        const findSuggestionsByPRAndFilenames = jest
            .fn()
            .mockResolvedValue([{ id: 'sug-1' }]);
        const service = new PullRequestsService(
            { findSuggestionsByPRAndFilenames } as any,
            {} as any,
        );

        const result = await service.findSuggestionsByPRAndFilenames(
            42,
            'kodustech/kodus-ai',
            ['src/a.ts', 'src/b.ts'],
            'org-1',
            DeliveryStatus.SENT,
        );

        expect(findSuggestionsByPRAndFilenames).toHaveBeenCalledWith(
            42,
            'kodustech/kodus-ai',
            ['src/a.ts', 'src/b.ts'],
            'org-1',
            DeliveryStatus.SENT,
        );
        expect(result).toEqual([{ id: 'sug-1' }]);
    });
});

describe('PullRequestsService.findPrLevelSuggestionsByPR (issue #1313 Fase 1b)', () => {
    it('delegates to the repository with the exact same arguments, in order', async () => {
        const findPrLevelSuggestionsByPR = jest
            .fn()
            .mockResolvedValue([{ id: 'pr-sug-1' }]);
        const service = new PullRequestsService(
            { findPrLevelSuggestionsByPR } as any,
            {} as any,
        );

        const result = await service.findPrLevelSuggestionsByPR(
            42,
            'kodustech/kodus-ai',
            'org-1',
            DeliveryStatus.SENT,
        );

        expect(findPrLevelSuggestionsByPR).toHaveBeenCalledWith(
            42,
            'kodustech/kodus-ai',
            'org-1',
            DeliveryStatus.SENT,
        );
        expect(result).toEqual([{ id: 'pr-sug-1' }]);
    });
});
