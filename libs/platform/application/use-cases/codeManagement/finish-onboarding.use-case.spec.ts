import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';

import { FinishOnboardingUseCase } from './finish-onboarding.use-case';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('FinishOnboardingUseCase — background rule generation', () => {
    const buildUseCase = () => {
        let ruleGenFinished = false;

        const parametersService = {
            findByKey: jest
                .fn()
                .mockResolvedValue({ configValue: { existing: true } }),
        };
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        const generateKodyRulesUseCase = {
            execute: jest.fn(async () => {
                // Slow, like the real Bitbucket-heavy run.
                await delay(200);
                ruleGenFinished = true;
                return [];
            }),
        };
        const findKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue([]),
        };
        const changeStatusKodyRulesUseCase = {
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
            generateKodyRulesUseCase as any,
            findKodyRulesUseCase as any,
            changeStatusKodyRulesUseCase as any,
            request as any,
            syncSelectedReposKodyRulesUseCase as any,
            createOrUpdateParametersUseCase as any,
            {} as any, // telemetry
        );

        return {
            useCase,
            createOrUpdateParametersUseCase,
            generateKodyRulesUseCase,
            isRuleGenFinished: () => ruleGenFinished,
        };
    };

    it('completes onboarding without waiting for rule generation', async () => {
        const {
            useCase,
            createOrUpdateParametersUseCase,
            generateKodyRulesUseCase,
            isRuleGenFinished,
        } = buildUseCase();

        await useCase.execute({ teamId: 'team-1', reviewPR: false } as any);

        // execute() resolved before rule generation finished — it wasn't awaited.
        expect(isRuleGenFinished()).toBe(false);
        // ...but onboarding itself is committed synchronously.
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            ParametersKey.PLATFORM_CONFIGS,
            expect.objectContaining({ finishOnboard: true }),
            expect.anything(),
        );

        // The detached job still runs to completion afterwards.
        await delay(300);
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', months: 3 },
            'org-1',
        );
    });
});
