/**
 * Shared mock factories and fixtures for delete integration tests.
 */

export const MOCK_ORG_ID = 'org-uuid-1234';
export const MOCK_TEAM_ID = 'team-uuid-5678';
export const MOCK_INTEGRATION_UUID = 'integration-uuid-0001';
export const MOCK_AUTH_INTEGRATION_UUID = 'auth-integration-uuid-0001';
export const MOCK_INTEGRATION_CONFIG_UUID = 'integration-config-uuid-0001';

export const MOCK_REPOSITORIES = [
    { id: 'repo-1', name: 'frontend-app', isSelected: true, directories: [] },
    { id: 'repo-2', name: 'backend-api', isSelected: true, directories: [] },
    { id: 'repo-3', name: 'shared-lib', isSelected: false, directories: [] },
];

export const MOCK_CODE_REVIEW_CONFIG = {
    uuid: 'param-uuid-0001',
    configValue: {
        repositories: MOCK_REPOSITORIES,
        configs: { reviewOptions: { enabled: true } },
    },
};

export function createMockLogger() {
    return {
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    };
}

export function createMockIntegrationService() {
    return {
        findOne: jest.fn(),
        delete: jest.fn().mockResolvedValue(undefined),
        find: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    };
}

export function createMockAuthIntegrationService() {
    return {
        findOne: jest.fn(),
        delete: jest.fn().mockResolvedValue(undefined),
        find: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    };
}

export function createMockIntegrationConfigService() {
    return {
        findOne: jest.fn(),
        delete: jest.fn().mockResolvedValue(undefined),
        find: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    };
}

export function createMockCodeManagementService() {
    return {
        deleteWebhook: jest.fn().mockResolvedValue(undefined),
    };
}

export function createMockParametersService() {
    return {
        findOne: jest.fn(),
        delete: jest.fn().mockResolvedValue(undefined),
        find: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        createOrUpdateConfig: jest.fn().mockResolvedValue(undefined),
    };
}

export function createMockPullRequestMessagesService() {
    return {
        deleteByFilter: jest.fn().mockResolvedValue(true),
        find: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    };
}

export function createMockKodyRulesService() {
    return {
        updateRulesStatusByFilter: jest.fn().mockResolvedValue({}),
        find: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    };
}

export function createMockEventEmitter() {
    return {
        emit: jest.fn(),
    };
}

export function createMockRequest(overrides?: Partial<{ user: any }>) {
    return {
        user: {
            organization: { uuid: MOCK_ORG_ID },
            uuid: 'user-uuid-0001',
            email: 'test@kodus.io',
            ...overrides?.user,
        },
    };
}

export function createMockCreateOrUpdateParametersUseCase() {
    return {
        execute: jest.fn().mockResolvedValue(undefined),
    };
}

export function createMockIntegrationEntity(
    platform: string,
    authMode: string,
    overrides?: Record<string, any>,
) {
    return {
        uuid: MOCK_INTEGRATION_UUID,
        platform,
        status: true,
        authIntegration: {
            uuid: MOCK_AUTH_INTEGRATION_UUID,
            authDetails: {
                authMode,
                installationId: authMode === 'oauth' ? 12345 : undefined,
                accessToken: 'mock-access-token',
                ...overrides?.authDetails,
            },
        },
        ...overrides,
    };
}

export function createMockIntegrationConfigEntity() {
    return {
        uuid: MOCK_INTEGRATION_CONFIG_UUID,
        configKey: 'repositories',
        configValue: MOCK_REPOSITORIES,
    };
}

export const MOCK_INSTALLATION_CONFIG_UUID = 'integration-config-uuid-0002';

export function createMockInstallationConfigEntity() {
    return {
        uuid: MOCK_INSTALLATION_CONFIG_UUID,
        configKey: 'installation_github',
        configValue: { installId: '12345', installationStatus: 'SUCCESS' },
    };
}
