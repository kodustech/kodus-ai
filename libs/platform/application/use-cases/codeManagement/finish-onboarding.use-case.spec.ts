import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';

import { FinishOnboardingUseCase } from './finish-onboarding.use-case';

// The trial is provisioned cloud-only (provisionTrial early-returns unless
// environment.API_CLOUD_MODE). Force cloud mode on so the trial path runs.
jest.mock('@libs/ee/configs/environment', () => {
    const actual = jest.requireActual('@libs/ee/configs/environment');
    return {
        ...actual,
        environment: { ...actual.environment, API_CLOUD_MODE: true },
    };
});

describe('FinishOnboardingUseCase', () => {
    const buildUseCase = (user: { uuid?: string; email?: string } = {}) => {
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
        const generateKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue([]),
        };
        const request = {
            user: { organization: { uuid: 'org-1' }, ...user },
        };
        const teamService = {
            findById: jest.fn().mockResolvedValue({
                name: 'Platform',
                organization: { name: 'Acme' },
            }),
        };
        const codeManagement = {
            getListMembers: jest.fn().mockResolvedValue([]),
        };

        const licenseService = {
            startTrial: jest.fn().mockResolvedValue(true),
        };
        const permissionValidationService = {
            getBYOKConfig: jest.fn().mockResolvedValue(null),
        };
        const organizationService = {
            update: jest.fn().mockResolvedValue(undefined),
        };
        const telemetry = {
            onboardingCompleted: jest.fn(),
            onboardingReviewTriggered: jest.fn(),
            onboardingReviewSkipped: jest.fn(),
        };

        const useCase = new FinishOnboardingUseCase(
            parametersService as any,
            teamService as any,
            organizationService as any,
            {} as any, // reviewPRUseCase
            request as any,
            syncSelectedReposKodyRulesUseCase as any,
            createOrUpdateParametersUseCase as any,
            telemetry as any,
            codeManagement as any,
            generateKodyRulesUseCase as any,
            licenseService as any,
            permissionValidationService as any,
        );

        return {
            useCase,
            createOrUpdateParametersUseCase,
            syncSelectedReposKodyRulesUseCase,
            generateKodyRulesUseCase,
            licenseService,
            permissionValidationService,
            organizationService,
            codeManagement,
        };
    };

    it('commits onboarding synchronously and runs repo-rule import + past-review generation detached', async () => {
        const {
            useCase,
            createOrUpdateParametersUseCase,
            syncSelectedReposKodyRulesUseCase,
            generateKodyRulesUseCase,
        } = buildUseCase();

        await useCase.execute({ teamId: 'team-1', reviewPR: false } as any);

        // Onboarding is committed synchronously...
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            ParametersKey.PLATFORM_CONFIGS,
            expect.objectContaining({ finishOnboard: true }),
            expect.anything(),
        );

        // ...while the LLM-heavy repo-rule import AND the 3-month past-review
        // backfill both run detached (via setImmediate), so neither blocks the
        // onboarding response. Sync runs first; generation is chained off its
        // completion so it sees the imported rules.
        await new Promise((resolve) => setImmediate(resolve));
        expect(
            syncSelectedReposKodyRulesUseCase.execute,
        ).toHaveBeenCalledWith({ teamId: 'team-1', organizationId: 'org-1' });
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', months: 3 },
            'org-1',
        );
    });

    it('provisions the trial server-side after committing onboarding', async () => {
        const { useCase, licenseService } = buildUseCase();

        await useCase.execute({ teamId: 'team-1', reviewPR: false } as any);

        expect(licenseService.startTrial).toHaveBeenCalledWith(
            { organizationId: 'org-1', teamId: 'team-1' },
            false,
        );
    });

    it('does not fail onboarding when trial provisioning throws', async () => {
        const { useCase, licenseService, syncSelectedReposKodyRulesUseCase } =
            buildUseCase();
        licenseService.startTrial.mockRejectedValueOnce(
            new Error('billing down'),
        );

        await expect(
            useCase.execute({ teamId: 'team-1', reviewPR: false } as any),
        ).resolves.not.toThrow();

        // Onboarding still schedules its (detached) rule import despite the
        // billing error.
        await new Promise((resolve) => setImmediate(resolve));
        expect(
            syncSelectedReposKodyRulesUseCase.execute,
        ).toHaveBeenCalledWith({ teamId: 'team-1', organizationId: 'org-1' });
    });

    it('persists the connected GitHub organization member-count snapshot', async () => {
        const { useCase, codeManagement, organizationService } = buildUseCase({
            uuid: 'user-1',
        });
        codeManagement.getListMembers.mockResolvedValue([
            { id: 1 },
            { id: 2 },
            { id: 3 },
        ]);

        await useCase.execute({ teamId: 'team-1', reviewPR: false } as any);

        expect(organizationService.update).toHaveBeenCalledWith(
            { uuid: 'org-1' },
            expect.objectContaining({
                codeHostMemberCount: 3,
                codeHostMemberCountUpdatedAt: expect.any(Date),
            }),
        );
    });
});
