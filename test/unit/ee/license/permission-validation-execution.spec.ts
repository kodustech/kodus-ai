import {
    PermissionValidationService,
    ValidationErrorType,
} from '@libs/ee/shared/services/permissionValidation.service';
import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';

jest.mock('@libs/core/log/logger', () => {
    // Shared across every createLogger() instance so tests can assert on the
    // warn channel (e.g. the BYOK state-divergence alarm).
    const warn = jest.fn();
    return {
        __warn: warn,
        createLogger: () => ({
            log: jest.fn(),
            error: jest.fn(),
            warn,
            debug: jest.fn(),
            info: jest.fn(),
        }),
    };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __warn: mockLoggerWarn } = require('@libs/core/log/logger');

const mockEnvironment = {
    API_CLOUD_MODE: true,
    API_DEVELOPMENT_MODE: false,
};
jest.mock('@libs/ee/configs/environment', () => ({
    get environment() {
        return mockEnvironment;
    },
}));

const VALID_ORG_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const orgData = { organizationId: VALID_ORG_ID };

const byokConfig = {
    main: { provider: 'openai', model: 'gpt-4', apiKey: 'sk-test' },
};

function createMockLicenseService(overrides: any = {}) {
    return {
        validateOrganizationLicense: jest.fn().mockResolvedValue({
            valid: true,
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            planType: 'teams_byok',
            ...overrides,
        }),
        getAllUsersWithLicense: jest.fn().mockResolvedValue([]),
        assignLicense: jest.fn().mockResolvedValue(true),
        consumeTrialReviewCredit: jest.fn().mockResolvedValue({
            allowed: true,
            trialReviewCreditsTotal: 5,
            trialReviewCreditsUsed: 1,
            trialReviewCreditsRemaining: 4,
            trialCreditTier: 'base',
            trialUnlocks: [],
        }),
    };
}

function createMockOrgParamsService(byok: any = null) {
    return {
        findByKey: jest
            .fn()
            .mockResolvedValue(byok ? { configValue: byok } : null),
    };
}

function createService(licenseService: any, orgParamsService: any) {
    return new PermissionValidationService(
        licenseService as any,
        orgParamsService as any,
    );
}

describe('PermissionValidationService.validateExecutionPermissions', () => {
    beforeEach(() => {
        mockEnvironment.API_CLOUD_MODE = true;
        mockEnvironment.API_DEVELOPMENT_MODE = false;
        mockLoggerWarn.mockClear();
    });

    const divergenceWarned = () =>
        mockLoggerWarn.mock.calls.some((call: any[]) =>
            String(call?.[0]?.message).includes('BYOK state divergence'),
        );

    // ─── Development mode ───────────────────────────────────────────

    it('should allow in development mode', async () => {
        mockEnvironment.API_DEVELOPMENT_MODE = true;
        const service = createService(
            createMockLicenseService({ valid: false }),
            createMockOrgParamsService(),
        );

        const result = await service.validateExecutionPermissions(orgData);
        expect(result.allowed).toBe(true);
    });

    // ─── Invalid org license ────────────────────────────────────────

    it('should deny when org license is invalid', async () => {
        const service = createService(
            createMockLicenseService({ valid: false }),
            createMockOrgParamsService(),
        );

        const result = await service.validateExecutionPermissions(orgData);
        expect(result.allowed).toBe(false);
        expect(result.errorType).toBe(ValidationErrorType.INVALID_LICENSE);
    });

    // ─── Trial ──────────────────────────────────────────────────────

    it('should allow trial without BYOK and without user check', async () => {
        const service = createService(
            createMockLicenseService({
                subscriptionStatus: 'trial',
                planType: 'trial',
            }),
            createMockOrgParamsService(),
        );

        const result = await service.validateExecutionPermissions(orgData);
        expect(result.allowed).toBe(true);
    });

    it('should NOT consume or gate a legacy trial that has no credit data (old behavior)', async () => {
        const licenseService = createMockLicenseService({
            subscriptionStatus: 'trial',
            planType: 'trial',
            // No trialReviewCredits* fields → legacy trial, pre-credit model.
        });
        const service = createService(
            licenseService,
            createMockOrgParamsService(),
        );

        const result = await service.validateExecutionPermissions(
            orgData,
            undefined,
            'ValidatePrerequisitesStage',
            {
                consumeTrialReviewCredit: true,
                trialReviewCreditUsageKey: 'repo-1:123',
            },
        );

        expect(result.allowed).toBe(true);
        expect(
            licenseService.consumeTrialReviewCredit,
        ).not.toHaveBeenCalled();
    });

    it('should consume one managed trial credit when requested by review execution', async () => {
        const licenseService = createMockLicenseService({
            subscriptionStatus: 'trial',
            planType: 'trial',
            trialReviewCreditsTotal: 5,
            trialReviewCreditsUsed: 0,
            trialReviewCreditsRemaining: 5,
        });
        const service = createService(
            licenseService,
            createMockOrgParamsService(),
        );

        const result = await service.validateExecutionPermissions(
            orgData,
            undefined,
            'ValidatePrerequisitesStage',
            {
                consumeTrialReviewCredit: true,
                trialReviewCreditUsageKey: 'repo-1:123',
            },
        );

        expect(result.allowed).toBe(true);
        expect(licenseService.consumeTrialReviewCredit).toHaveBeenCalledWith(
            orgData,
            'repo-1:123',
        );
        expect(result.metadata?.trialReviewCreditsRemaining).toBe(4);
    });

    it('should deny trial review when billing cannot consume a trial credit', async () => {
        const licenseService = createMockLicenseService({
            subscriptionStatus: 'trial',
            planType: 'trial',
            trialReviewCreditsTotal: 5,
            trialReviewCreditsUsed: 5,
            trialReviewCreditsRemaining: 1,
        });
        licenseService.consumeTrialReviewCredit.mockResolvedValue({
            allowed: false,
            reason: 'TRIAL_REVIEW_CREDITS_EXHAUSTED',
            trialReviewCreditsTotal: 5,
            trialReviewCreditsUsed: 5,
            trialReviewCreditsRemaining: 0,
        });
        const service = createService(
            licenseService,
            createMockOrgParamsService(),
        );

        const result = await service.validateExecutionPermissions(
            orgData,
            undefined,
            'ValidatePrerequisitesStage',
            {
                consumeTrialReviewCredit: true,
                trialReviewCreditUsageKey: 'repo-1:123',
            },
        );

        expect(result.allowed).toBe(false);
        expect(result.errorType).toBe(ValidationErrorType.PLAN_LIMIT_EXCEEDED);
        // Credits genuinely gone → flagged as exhausted.
        expect(result.metadata?.trialCreditsExhausted).toBe(true);
    });

    it('does NOT flag exhaustion when the credit consume fails transiently (billing unreachable)', async () => {
        // A transport failure to billing surfaces as PLAN_LIMIT_EXCEEDED too,
        // but the reviews are NOT actually used up — the message must stay
        // generic, not "you've used all your trial reviews".
        const licenseService = createMockLicenseService({
            subscriptionStatus: 'trial',
            planType: 'trial',
            trialReviewCreditsTotal: 5,
            trialReviewCreditsUsed: 3,
            trialReviewCreditsRemaining: 2,
        });
        licenseService.consumeTrialReviewCredit.mockResolvedValue({
            allowed: false,
            reason: 'CONSUME_TRIAL_REVIEW_CREDIT_FAILED',
        });
        const service = createService(
            licenseService,
            createMockOrgParamsService(),
        );

        const result = await service.validateExecutionPermissions(
            orgData,
            undefined,
            'ValidatePrerequisitesStage',
            {
                consumeTrialReviewCredit: true,
                trialReviewCreditUsageKey: 'repo-1:123',
            },
        );

        expect(result.allowed).toBe(false);
        expect(result.errorType).toBe(ValidationErrorType.PLAN_LIMIT_EXCEEDED);
        expect(result.metadata?.trialCreditsExhausted).toBe(false);
    });

    it('should deny managed trial when review credits are exhausted', async () => {
        const service = createService(
            createMockLicenseService({
                subscriptionStatus: 'trial',
                planType: 'trial',
                trialReviewCreditsTotal: 5,
                trialReviewCreditsUsed: 5,
                trialReviewCreditsRemaining: 0,
            }),
            createMockOrgParamsService(),
        );

        const result = await service.validateExecutionPermissions(orgData);
        expect(result.allowed).toBe(false);
        expect(result.errorType).toBe(ValidationErrorType.PLAN_LIMIT_EXCEEDED);
    });

    it('should allow BYOK trial even when managed review credits are exhausted', async () => {
        const service = createService(
            createMockLicenseService({
                subscriptionStatus: 'trial',
                planType: 'trial',
                trialReviewCreditsTotal: 5,
                trialReviewCreditsUsed: 5,
                trialReviewCreditsRemaining: 0,
            }),
            createMockOrgParamsService(byokConfig),
        );

        const result = await service.validateExecutionPermissions(orgData);
        expect(result.allowed).toBe(true);
        expect(result.byokConfig).toEqual(byokConfig);
    });

    it('blocks a *_byok trial with billing byok:true but no local config, and warns on the divergence', async () => {
        // The production incident: billing keeps a plan-derived byok:true for a
        // teams_byok trial, but the local config row is gone. The gate trusts
        // the local row (blocks at 0 credits) and flags the mismatch so support
        // can find it in observability_logs_ts.
        const service = createService(
            createMockLicenseService({
                subscriptionStatus: 'trial',
                planType: 'teams_byok',
                byok: true,
                trialReviewCreditsTotal: 5,
                trialReviewCreditsUsed: 5,
                trialReviewCreditsRemaining: 0,
            }),
            createMockOrgParamsService(),
        );

        const result = await service.validateExecutionPermissions(orgData);

        expect(result.allowed).toBe(false);
        expect(result.errorType).toBe(ValidationErrorType.PLAN_LIMIT_EXCEEDED);
        expect(result.subscriptionStatus).toBe('trial');
        expect(result.metadata?.trialCreditsExhausted).toBe(true);
        expect(divergenceWarned()).toBe(true);
    });

    it('does NOT warn about divergence when the local BYOK config is present', async () => {
        const service = createService(
            createMockLicenseService({
                subscriptionStatus: 'trial',
                planType: 'teams_byok',
                byok: true,
                trialReviewCreditsTotal: 5,
                trialReviewCreditsUsed: 5,
                trialReviewCreditsRemaining: 0,
            }),
            createMockOrgParamsService(byokConfig),
        );

        const result = await service.validateExecutionPermissions(orgData);

        expect(result.allowed).toBe(true);
        expect(result.byokConfig).toEqual(byokConfig);
        expect(divergenceWarned()).toBe(false);
    });

    it('should NOT consume a trial credit when BYOK is configured (key, not credits)', async () => {
        const licenseService = createMockLicenseService({
            subscriptionStatus: 'trial',
            planType: 'trial',
            trialReviewCreditsTotal: 5,
            trialReviewCreditsUsed: 0,
            trialReviewCreditsRemaining: 5,
        });
        const service = createService(
            licenseService,
            createMockOrgParamsService(byokConfig),
        );

        const result = await service.validateExecutionPermissions(
            orgData,
            undefined,
            'ValidatePrerequisitesStage',
            { consumeTrialReviewCredit: true, trialReviewCreditUsageKey: 'r:1' },
        );

        expect(result.allowed).toBe(true);
        expect(result.byokConfig).toEqual(byokConfig);
        expect(
            licenseService.consumeTrialReviewCredit,
        ).not.toHaveBeenCalled();
    });

    it('does NOT block an exhausted trial when the BYOK lookup fails (fail open)', async () => {
        // A user who burned their 5 credits and then connected BYOK must not
        // be gated by a flaky BYOK-config read. When getBYOKConfig throws we
        // can't rule out a key, so we neither block nor consume.
        const licenseService = createMockLicenseService({
            subscriptionStatus: 'trial',
            planType: 'trial',
            trialReviewCreditsTotal: 5,
            trialReviewCreditsUsed: 5,
            trialReviewCreditsRemaining: 0,
        });
        const flakyOrgParams = {
            findByKey: jest.fn().mockRejectedValue(new Error('flaky DB')),
        };
        const service = createService(licenseService, flakyOrgParams);

        const result = await service.validateExecutionPermissions(
            orgData,
            undefined,
            'ValidatePrerequisitesStage',
            { consumeTrialReviewCredit: true, trialReviewCreditUsageKey: 'r:1' },
        );

        expect(result.allowed).toBe(true);
        expect(
            licenseService.consumeTrialReviewCredit,
        ).not.toHaveBeenCalled();
    });

    // ─── free_byok ──────────────────────────────────────────────────

    describe('free_byok plan', () => {
        it('should allow with BYOK configured (no user check)', async () => {
            const service = createService(
                createMockLicenseService({ planType: 'free_byok' }),
                createMockOrgParamsService(byokConfig),
            );

            const result = await service.validateExecutionPermissions(
                orgData,
                'user-123',
            );
            expect(result.allowed).toBe(true);
        });

        it('should allow even without userGitId', async () => {
            const service = createService(
                createMockLicenseService({ planType: 'free_byok' }),
                createMockOrgParamsService(byokConfig),
            );

            const result = await service.validateExecutionPermissions(orgData);
            expect(result.allowed).toBe(true);
        });

        it('should deny when BYOK not configured', async () => {
            const service = createService(
                createMockLicenseService({ planType: 'free_byok' }),
                createMockOrgParamsService(),
            );

            const result = await service.validateExecutionPermissions(orgData);
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(ValidationErrorType.BYOK_REQUIRED);
        });
    });

    // ─── teams_byok ─────────────────────────────────────────────────

    describe('teams_byok plan', () => {
        it('should allow with BYOK configured and user licensed', async () => {
            const licenseService = createMockLicenseService({
                planType: 'teams_byok',
            });
            licenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'user-123' },
            ]);
            const service = createService(
                licenseService,
                createMockOrgParamsService(byokConfig),
            );

            const result = await service.validateExecutionPermissions(
                orgData,
                'user-123',
            );
            expect(result.allowed).toBe(true);
        });

        it('should deny when user is NOT licensed', async () => {
            const licenseService = createMockLicenseService({
                planType: 'teams_byok',
            });
            licenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'other-user' },
            ]);
            const service = createService(
                licenseService,
                createMockOrgParamsService(byokConfig),
            );

            const result = await service.validateExecutionPermissions(
                orgData,
                'user-123',
            );
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(
                ValidationErrorType.USER_NOT_LICENSED,
            );
        });

        it('should deny when no userGitId provided', async () => {
            const service = createService(
                createMockLicenseService({ planType: 'teams_byok' }),
                createMockOrgParamsService(byokConfig),
            );

            const result = await service.validateExecutionPermissions(orgData);
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(ValidationErrorType.NOT_ERROR);
            expect(result.metadata?.reason).toBe('USER_ID_REQUIRED');
        });

        it('should deny when BYOK not configured (before user check)', async () => {
            const service = createService(
                createMockLicenseService({ planType: 'teams_byok' }),
                createMockOrgParamsService(),
            );

            const result = await service.validateExecutionPermissions(
                orgData,
                'user-123',
            );
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(ValidationErrorType.BYOK_REQUIRED);
        });

        it('should deny when no licensed users exist at all', async () => {
            const licenseService = createMockLicenseService({
                planType: 'teams_byok',
            });
            licenseService.getAllUsersWithLicense.mockResolvedValue([]);
            const service = createService(
                licenseService,
                createMockOrgParamsService(byokConfig),
            );

            const result = await service.validateExecutionPermissions(
                orgData,
                'user-123',
            );
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(
                ValidationErrorType.USER_NOT_LICENSED,
            );
            expect(result.metadata?.availableUsers).toBe(0);
        });
    });

    // ─── teams_managed ──────────────────────────────────────────────

    describe('teams_managed plan', () => {
        it('should allow when user is licensed', async () => {
            const licenseService = createMockLicenseService({
                planType: 'teams_managed',
            });
            licenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'user-123' },
            ]);
            const service = createService(
                licenseService,
                createMockOrgParamsService(),
            );

            const result = await service.validateExecutionPermissions(
                orgData,
                'user-123',
            );
            expect(result.allowed).toBe(true);
        });

        it('should deny when user is NOT licensed', async () => {
            const licenseService = createMockLicenseService({
                planType: 'teams_managed',
            });
            licenseService.getAllUsersWithLicense.mockResolvedValue([]);
            const service = createService(
                licenseService,
                createMockOrgParamsService(),
            );

            const result = await service.validateExecutionPermissions(
                orgData,
                'user-123',
            );
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(
                ValidationErrorType.USER_NOT_LICENSED,
            );
        });

        it('should deny when no userGitId provided', async () => {
            const service = createService(
                createMockLicenseService({ planType: 'teams_managed' }),
                createMockOrgParamsService(),
            );

            const result = await service.validateExecutionPermissions(orgData);
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(ValidationErrorType.NOT_ERROR);
            expect(result.metadata?.reason).toBe('USER_ID_REQUIRED');
        });
    });

    // ─── Self-hosted ────────────────────────────────────────────────

    describe('self-hosted', () => {
        beforeEach(() => {
            mockEnvironment.API_CLOUD_MODE = false;
        });

        it('should allow without license (Community Edition)', async () => {
            const service = createService(
                createMockLicenseService({ valid: false }),
                createMockOrgParamsService(),
            );

            const result = await service.validateExecutionPermissions(orgData);
            expect(result.allowed).toBe(true);
        });

        it('should allow with valid license and licensed user', async () => {
            const licenseService = createMockLicenseService({
                subscriptionStatus: SubscriptionStatus.LICENSED_SELF_HOSTED,
            });
            licenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'user-123' },
            ]);
            const service = createService(
                licenseService,
                createMockOrgParamsService(),
            );

            const result = await service.validateExecutionPermissions(
                orgData,
                'user-123',
            );
            expect(result.allowed).toBe(true);
        });

        it('should deny with valid license and unlicensed user', async () => {
            const licenseService = createMockLicenseService({
                subscriptionStatus: SubscriptionStatus.LICENSED_SELF_HOSTED,
            });
            licenseService.getAllUsersWithLicense.mockResolvedValue([]);
            const service = createService(
                licenseService,
                createMockOrgParamsService(),
            );

            const result = await service.validateExecutionPermissions(
                orgData,
                'user-123',
            );
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(
                ValidationErrorType.USER_NOT_LICENSED,
            );
        });

        it('should allow with valid license and no userGitId', async () => {
            const service = createService(
                createMockLicenseService({
                    subscriptionStatus: SubscriptionStatus.LICENSED_SELF_HOSTED,
                }),
                createMockOrgParamsService(),
            );

            const result = await service.validateExecutionPermissions(orgData);
            expect(result.allowed).toBe(true);
        });
    });

    // ─── Error handling ─────────────────────────────────────────────

    describe('error handling', () => {
        it('should return BYOK_REQUIRED on BYOK_NOT_CONFIGURED exception', async () => {
            const licenseService = createMockLicenseService({
                planType: 'teams_byok',
            });
            const orgParamsService = createMockOrgParamsService();
            orgParamsService.findByKey.mockRejectedValue(
                new Error('BYOK_NOT_CONFIGURED'),
            );

            const service = createService(licenseService, orgParamsService);

            const result = await service.validateExecutionPermissions(
                orgData,
                'user-123',
            );
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(ValidationErrorType.BYOK_REQUIRED);
        });

        it('should return INVALID_LICENSE on generic exception', async () => {
            const licenseService = createMockLicenseService();
            licenseService.validateOrganizationLicense.mockRejectedValue(
                new Error('unexpected error'),
            );
            const service = createService(
                licenseService,
                createMockOrgParamsService(),
            );

            const result = await service.validateExecutionPermissions(
                orgData,
                'user-123',
            );
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(ValidationErrorType.INVALID_LICENSE);
        });
    });
});
