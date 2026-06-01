import {
    PermissionValidationService,
    ValidationErrorType,
} from '@libs/ee/shared/services/permissionValidation.service';
import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

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
    };
}

function createMockOrgParamsService(byok: any = null) {
    return {
        findByKey: jest.fn().mockResolvedValue(
            byok ? { configValue: byok } : null,
        ),
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
    });

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
            createMockLicenseService({ subscriptionStatus: 'trial', planType: 'trial' }),
            createMockOrgParamsService(),
        );

        const result = await service.validateExecutionPermissions(orgData);
        expect(result.allowed).toBe(true);
    });

    // ─── free_byok ──────────────────────────────────────────────────

    describe('free_byok plan', () => {
        it('should allow with BYOK configured (no user check)', async () => {
            const service = createService(
                createMockLicenseService({ planType: 'free_byok' }),
                createMockOrgParamsService(byokConfig),
            );

            const result = await service.validateExecutionPermissions(orgData, 'user-123');
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
            const licenseService = createMockLicenseService({ planType: 'teams_byok' });
            licenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'user-123' },
            ]);
            const service = createService(
                licenseService,
                createMockOrgParamsService(byokConfig),
            );

            const result = await service.validateExecutionPermissions(orgData, 'user-123');
            expect(result.allowed).toBe(true);
        });

        it('should deny when user is NOT licensed', async () => {
            const licenseService = createMockLicenseService({ planType: 'teams_byok' });
            licenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'other-user' },
            ]);
            const service = createService(
                licenseService,
                createMockOrgParamsService(byokConfig),
            );

            const result = await service.validateExecutionPermissions(orgData, 'user-123');
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(ValidationErrorType.USER_NOT_LICENSED);
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

            const result = await service.validateExecutionPermissions(orgData, 'user-123');
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(ValidationErrorType.BYOK_REQUIRED);
        });

        it('should deny when no licensed users exist at all', async () => {
            const licenseService = createMockLicenseService({ planType: 'teams_byok' });
            licenseService.getAllUsersWithLicense.mockResolvedValue([]);
            const service = createService(
                licenseService,
                createMockOrgParamsService(byokConfig),
            );

            const result = await service.validateExecutionPermissions(orgData, 'user-123');
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(ValidationErrorType.USER_NOT_LICENSED);
            expect(result.metadata?.availableUsers).toBe(0);
        });
    });

    // ─── teams_managed ──────────────────────────────────────────────

    describe('teams_managed plan', () => {
        it('should allow when user is licensed', async () => {
            const licenseService = createMockLicenseService({ planType: 'teams_managed' });
            licenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'user-123' },
            ]);
            const service = createService(
                licenseService,
                createMockOrgParamsService(),
            );

            const result = await service.validateExecutionPermissions(orgData, 'user-123');
            expect(result.allowed).toBe(true);
        });

        it('should deny when user is NOT licensed', async () => {
            const licenseService = createMockLicenseService({ planType: 'teams_managed' });
            licenseService.getAllUsersWithLicense.mockResolvedValue([]);
            const service = createService(
                licenseService,
                createMockOrgParamsService(),
            );

            const result = await service.validateExecutionPermissions(orgData, 'user-123');
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(ValidationErrorType.USER_NOT_LICENSED);
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

            const result = await service.validateExecutionPermissions(orgData, 'user-123');
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

            const result = await service.validateExecutionPermissions(orgData, 'user-123');
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(ValidationErrorType.USER_NOT_LICENSED);
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
            const licenseService = createMockLicenseService({ planType: 'teams_byok' });
            const orgParamsService = createMockOrgParamsService();
            orgParamsService.findByKey.mockRejectedValue(new Error('BYOK_NOT_CONFIGURED'));

            const service = createService(licenseService, orgParamsService);

            const result = await service.validateExecutionPermissions(orgData, 'user-123');
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

            const result = await service.validateExecutionPermissions(orgData, 'user-123');
            expect(result.allowed).toBe(false);
            expect(result.errorType).toBe(ValidationErrorType.INVALID_LICENSE);
        });
    });
});
