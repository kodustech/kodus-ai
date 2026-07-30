import { GetPendingKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/get-pending-kody-rules.use-case';
import {
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('GetPendingKodyRulesUseCase', () => {
    const buildUseCase = (items: any[]) => {
        const findRulesUseCase = { execute: jest.fn().mockResolvedValue(items) };
        const request = { user: { organization: { uuid: 'org-1' } } } as any;
        return {
            useCase: new GetPendingKodyRulesUseCase(
                request,
                findRulesUseCase as any,
            ),
            findRulesUseCase,
        };
    };

    it('queries pending status, scoped to the repository, and splits counts by type', async () => {
        const { useCase, findRulesUseCase } = buildUseCase([
            { uuid: 'r1', type: KodyRulesType.STANDARD },
            { uuid: 'r2', type: KodyRulesType.STANDARD },
            { uuid: 'm1', type: KodyRulesType.MEMORY },
            { uuid: 'm2' }, // missing type → counts as a rule (STANDARD default)
        ]);

        const result = await useCase.execute({ repositoryId: 'repo-1' });

        expect(findRulesUseCase.execute).toHaveBeenCalledWith(
            'org-1',
            { status: KodyRulesStatus.PENDING },
            'repo-1',
        );
        expect(result.counts).toEqual({ total: 4, rules: 3, memories: 1 });
        expect(result.items).toHaveLength(4);
    });

    it('returns zeroed counts when nothing is pending', async () => {
        const { useCase } = buildUseCase([]);
        const result = await useCase.execute();
        expect(result).toEqual({
            items: [],
            counts: { total: 0, rules: 0, memories: 0 },
        });
    });

    it('throws when organization id is missing', async () => {
        const findRulesUseCase = { execute: jest.fn() };
        const useCase = new GetPendingKodyRulesUseCase(
            { user: { organization: {} } } as any,
            findRulesUseCase as any,
        );
        await expect(useCase.execute()).rejects.toThrow(
            'Organization ID not found',
        );
        expect(findRulesUseCase.execute).not.toHaveBeenCalled();
    });
});
