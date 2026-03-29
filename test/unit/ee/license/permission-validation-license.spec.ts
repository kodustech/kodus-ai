import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
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

// Mock the environment module
const mockEnvironment = {
    API_CLOUD_MODE: false,
    API_DEVELOPMENT_MODE: false,
};
jest.mock('@libs/ee/configs/environment', () => ({
    get environment() {
        return mockEnvironment;
    },
}));

function createMockLicenseService(validationResult: any = { valid: false }) {
    return {
        validateOrganizationLicense: jest
            .fn()
            .mockResolvedValue(validationResult),
        getAllUsersWithLicense: jest.fn().mockResolvedValue([]),
        assignLicense: jest.fn().mockResolvedValue(true),
    };
}

function createMockOrgParamsService() {
    return {
        findByKey: jest.fn().mockResolvedValue(null),
    };
}

const orgData = { organizationId: 'org-123' };

describe('PermissionValidationService.shouldLimitResources (self-hosted)', () => {
    beforeEach(() => {
        mockEnvironment.API_CLOUD_MODE = false;
        mockEnvironment.API_DEVELOPMENT_MODE = false;
    });

    it('should NOT limit when self-hosted with valid license', async () => {
        const licenseService = createMockLicenseService({
            valid: true,
            subscriptionStatus: SubscriptionStatus.LICENSED_SELF_HOSTED,
            planType: 'enterprise',
            numberOfLicenses: 50,
        });

        const service = new PermissionValidationService(
            licenseService as any,
            createMockOrgParamsService() as any,
        );

        const result = await service.shouldLimitResources(orgData);
        expect(result).toBe(false);
    });

    it('should limit when self-hosted without license', async () => {
        const licenseService = createMockLicenseService({ valid: false });

        const service = new PermissionValidationService(
            licenseService as any,
            createMockOrgParamsService() as any,
        );

        const result = await service.shouldLimitResources(orgData);
        expect(result).toBe(true);
    });

    it('should limit when self-hosted with expired license', async () => {
        const licenseService = createMockLicenseService({
            valid: false,
            subscriptionStatus: SubscriptionStatus.EXPIRED,
        });

        const service = new PermissionValidationService(
            licenseService as any,
            createMockOrgParamsService() as any,
        );

        const result = await service.shouldLimitResources(orgData);
        expect(result).toBe(true);
    });

    it('should NOT limit in development mode', async () => {
        mockEnvironment.API_DEVELOPMENT_MODE = true;
        const licenseService = createMockLicenseService({ valid: false });

        const service = new PermissionValidationService(
            licenseService as any,
            createMockOrgParamsService() as any,
        );

        const result = await service.shouldLimitResources(orgData);
        expect(result).toBe(false);
    });

    it('should NOT limit cloud with active paid plan', async () => {
        mockEnvironment.API_CLOUD_MODE = true;
        const licenseService = createMockLicenseService({
            valid: true,
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            planType: 'teams_byok',
        });

        const service = new PermissionValidationService(
            licenseService as any,
            createMockOrgParamsService() as any,
        );

        const result = await service.shouldLimitResources(orgData);
        expect(result).toBe(false);
    });

    it('should limit cloud with free plan', async () => {
        mockEnvironment.API_CLOUD_MODE = true;
        const licenseService = createMockLicenseService({
            valid: true,
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            planType: 'free_byok',
        });

        const service = new PermissionValidationService(
            licenseService as any,
            createMockOrgParamsService() as any,
        );

        const result = await service.shouldLimitResources(orgData);
        expect(result).toBe(true);
    });
});
