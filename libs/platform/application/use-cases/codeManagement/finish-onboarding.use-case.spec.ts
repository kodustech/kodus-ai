import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';

import { FinishOnboardingUseCase } from './finish-onboarding.use-case';

describe('FinishOnboardingUseCase', () => {
    const buildUseCase = () => {
        const parametersService = {
            findByKey: jest
                .fn()
                .mockResolvedValue({ configValue: { existing: true } }),
        };
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        const syncSelectedReposKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        // No `uuid` on the user → the telemetry block is skipped.
        const request = { user: { organization: { uuid: 'org-1' } } };

        const useCase = new FinishOnboardingUseCase(
            parametersService as any,
            {} as any, // teamService
            {} as any, // reviewPRUseCase
            request as any,
            syncSelectedReposKodyRulesUseCase as any,
            createOrUpdateParametersUseCase as any,
            {} as any, // telemetry
        );

        return {
            useCase,
            createOrUpdateParametersUseCase,
            syncSelectedReposKodyRulesUseCase,
        };
    };

    it('commits onboarding and imports repo rules (no past-review generation)', async () => {
        const {
            useCase,
            createOrUpdateParametersUseCase,
            syncSelectedReposKodyRulesUseCase,
        } = buildUseCase();

        await useCase.execute({ teamId: 'team-1', reviewPR: false } as any);

        // Onboarding is committed...
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            ParametersKey.PLATFORM_CONFIGS,
            expect.objectContaining({ finishOnboard: true }),
            expect.anything(),
        );
        // ...and only imports rules from repo files. Past-review generation is
        // a separate async action, not part of onboarding.
        expect(
            syncSelectedReposKodyRulesUseCase.execute,
        ).toHaveBeenCalledWith({ teamId: 'team-1' });
    });
});
