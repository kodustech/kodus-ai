import { ParametersKey } from '@libs/core/domain/enums';

import { GetCodeReviewParameterUseCase } from '../get-code-review-parameter.use-case';

describe('GetCodeReviewParameterUseCase — get-or-create', () => {
    const makeEntity = () => ({
        toObject: () => ({
            configValue: { repositories: [] },
            createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const build = (
        findByKey: jest.Mock,
        createActiveVersionIfAbsent: jest.Mock,
    ) => {
        const parametersService = { findByKey, createActiveVersionIfAbsent };
        const useCase = new GetCodeReviewParameterUseCase(
            parametersService as any,
            {} as any, // codeBaseConfigService
            {} as any, // authorizationService
            {} as any, // promptReferenceManager
        );
        // Short-circuit the heavy inheritance/formatting logic; we only care
        // about the get-or-create branch here.
        jest.spyOn(
            useCase as any,
            'getCodeReviewConfigFormatted',
        ).mockResolvedValue({ configs: {}, repositories: [] });
        return { useCase, parametersService };
    };

    const user = { organization: { uuid: 'org-1' } };

    it('idempotently creates the default config when the team has none, then returns it', async () => {
        const createActiveVersionIfAbsent = jest
            .fn()
            .mockResolvedValue(makeEntity());
        const findByKey = jest.fn().mockResolvedValue(null);

        const { useCase } = build(findByKey, createActiveVersionIfAbsent);

        const result = await useCase.execute(user as any, 'team-1');

        expect(createActiveVersionIfAbsent).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            'team-1',
            {
                id: 'global',
                name: 'Global',
                isSelected: true,
                configs: {},
                repositories: [],
            },
        );
        expect(result).toBeDefined();
    });

    it('does not create anything when the config already exists', async () => {
        const createActiveVersionIfAbsent = jest.fn();
        const findByKey = jest.fn().mockResolvedValue(makeEntity());

        const { useCase } = build(findByKey, createActiveVersionIfAbsent);

        await useCase.execute(user as any, 'team-1');

        expect(createActiveVersionIfAbsent).not.toHaveBeenCalled();
    });
});
