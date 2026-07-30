/**
 * REGRESSION TESTS - FindByKeyParametersUseCase
 *
 * These tests capture the CURRENT behavior of the parameters lookup.
 * When implementing caching optimization, these tests ensure
 * behavior remains identical.
 *
 * CRITICAL: Do NOT modify existing tests when implementing cache.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { FindByKeyParametersUseCase } from '@libs/organization/application/use-cases/parameters/find-by-key-use-case';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ParametersEntity } from '@libs/organization/domain/parameters/entities/parameters.entity';

// ============================================================================
// MOCKS
// ============================================================================

const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

const mockConfigService = {
    get: jest.fn().mockReturnValue(60000), // Default TTL
};

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => mockLogger,
}));

const createMockParametersService = () => ({
    findByKey: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
});

const createMockCentralizedConfigPrService = () => ({
    getCentralizedConfigWithValidatedPullRequest: jest.fn(),
});

// ============================================================================
// TEST FIXTURES
// ============================================================================

function createMockParameterEntity<K extends ParametersKey>(
    configKey: K,
    configValue: any,
    overrides: Partial<ParametersEntity<K>> = {},
): ParametersEntity<K> {
    return {
        uuid: `param-${Math.random().toString(36).substr(2, 9)}`,
        configKey,
        configValue,
        team: null,
        active: true,
        description: `Test parameter for ${configKey}`,
        version: '1.0.0',
        createdAt: new Date('2024-01-15'),
        updatedAt: new Date('2024-01-15'),
        ...overrides,
    } as ParametersEntity<K>;
}

const MOCK_ORG_AND_TEAM_DATA: OrganizationAndTeamData = {
    organizationId: 'org-123',
    teamId: 'team-456',
};

// ============================================================================
// REGRESSION TESTS
// ============================================================================

describe('FindByKeyParametersUseCase', () => {
    let useCase: FindByKeyParametersUseCase;
    let mockParametersService: ReturnType<typeof createMockParametersService>;

    beforeEach(async () => {
        mockParametersService = createMockParametersService();
        const mockCentralizedConfigPrService =
            createMockCentralizedConfigPrService();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                FindByKeyParametersUseCase,
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: mockParametersService,
                },
                {
                    provide: ConfigService,
                    useValue: mockConfigService,
                },
                {
                    provide: CentralizedConfigPrService,
                    useValue: mockCentralizedConfigPrService,
                },
            ],
        }).compile();

        useCase = module.get<FindByKeyParametersUseCase>(
            FindByKeyParametersUseCase,
        );

        jest.clearAllMocks();
    });

    describe('REGRESSION: Basic parameter retrieval', () => {
        it('should return parameter when found', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.CODE_REVIEW_CONFIG,
                {
                    enabled: true,
                    maxSuggestions: 10,
                },
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            const result = await useCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(result.configKey).toBe(ParametersKey.CODE_REVIEW_CONFIG);
            expect(result.configValue.enabled).toBe(true);
            expect(result.configValue.maxSuggestions).toBe(10);
        });

        it('should return null when parameter not found', async () => {
            mockParametersService.findByKey.mockResolvedValue(null);

            const result = await useCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(result).toBeNull();
        });

        it('should call parametersService.findByKey with correct arguments', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.LANGUAGE_CONFIG,
                { language: 'en' },
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            await useCase.execute(
                ParametersKey.LANGUAGE_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(mockParametersService.findByKey).toHaveBeenCalledWith(
                ParametersKey.LANGUAGE_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );
        });
    });

    describe('REGRESSION: CODE_REVIEW_CONFIG special handling', () => {
        /**
         * The use case has special logic for CODE_REVIEW_CONFIG that adds
         * showToggleCodeReviewVersion based on createdAt date.
         *
         * CRITICAL: This behavior MUST be preserved when implementing cache.
         */

        it('should add showToggleCodeReviewVersion=true for users before Sept 11, 2025', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.CODE_REVIEW_CONFIG,
                { enabled: true },
                { createdAt: new Date('2025-09-10') }, // Day before cutoff
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            const result = await useCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(result.configValue.showToggleCodeReviewVersion).toBe(true);
        });

        it('should add showToggleCodeReviewVersion=false for users on Sept 11, 2025', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.CODE_REVIEW_CONFIG,
                { enabled: true },
                { createdAt: new Date('2025-09-11') }, // On cutoff date
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            const result = await useCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(result.configValue.showToggleCodeReviewVersion).toBe(false);
        });

        it('should add showToggleCodeReviewVersion=false for users after Sept 11, 2025', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.CODE_REVIEW_CONFIG,
                { enabled: true },
                { createdAt: new Date('2025-09-12') }, // Day after cutoff
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            const result = await useCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(result.configValue.showToggleCodeReviewVersion).toBe(false);
        });

        it('should add showToggleCodeReviewVersion=true for users in 2024', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.CODE_REVIEW_CONFIG,
                { enabled: true },
                { createdAt: new Date('2024-06-15') },
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            const result = await useCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(result.configValue.showToggleCodeReviewVersion).toBe(true);
        });

        it('should preserve existing configValue fields when adding showToggleCodeReviewVersion', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.CODE_REVIEW_CONFIG,
                {
                    enabled: true,
                    maxSuggestions: 20,
                    customField: 'test',
                },
                { createdAt: new Date('2024-01-01') },
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            const result = await useCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(result.configValue).toEqual({
                enabled: true,
                maxSuggestions: 20,
                customField: 'test',
                showToggleCodeReviewVersion: true,
            });
        });
    });

    describe('REGRESSION: Non-CODE_REVIEW_CONFIG parameters', () => {
        it('should NOT add showToggleCodeReviewVersion for other config types', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.LANGUAGE_CONFIG,
                { language: 'en' },
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            const result = await useCase.execute(
                ParametersKey.LANGUAGE_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(result.configValue).toEqual({ language: 'en' });
            expect(
                (result.configValue as any).showToggleCodeReviewVersion,
            ).toBeUndefined();
        });

        it('should return all parameter fields correctly', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.CHECKIN_CONFIG,
                { time: '09:00', timezone: 'UTC' },
                {
                    uuid: 'specific-uuid',
                    active: true,
                    description: 'Check-in configuration',
                    version: '2.0.0',
                },
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            const result = await useCase.execute(
                ParametersKey.CHECKIN_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(result.configKey).toBe(ParametersKey.CHECKIN_CONFIG);
            expect(result.uuid).toBe('specific-uuid');
            expect(result.active).toBe(true);
            expect(result.description).toBe('Check-in configuration');
            expect(result.version).toBe('2.0.0');
        });
    });

    describe('CENTRALIZED_CONFIG active pull request validation', () => {
        it('should return validated config when centralized config has active pull request', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.CENTRALIZED_CONFIG,
                {
                    enabled: true,
                    repository: { id: 'repo-1', name: 'centralized-repo' },
                    activePullRequest: {
                        prUrl: 'https://example.test/pull/123',
                        prNumber: 123,
                        sourceBranch: 'kodus-centralized-config-global-123',
                        targetBranch: 'main',
                        repository: { id: 'repo-1', name: 'centralized-repo' },
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-01T00:00:00.000Z',
                    },
                },
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            const result = await useCase.execute(
                ParametersKey.CENTRALIZED_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(result.configKey).toBe(ParametersKey.CENTRALIZED_CONFIG);
            expect(result.configValue.enabled).toBe(true);
        });

        it('should clear active pull request metadata when pull request is merged', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.CENTRALIZED_CONFIG,
                {
                    enabled: true,
                    repository: { id: 'repo-1', name: 'centralized-repo' },
                    activePullRequest: {
                        prUrl: 'https://example.test/pull/123',
                        prNumber: 123,
                        sourceBranch: 'kodus-centralized-config-global-123',
                        targetBranch: 'main',
                        repository: { id: 'repo-1', name: 'centralized-repo' },
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-01T00:00:00.000Z',
                    },
                },
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    FindByKeyParametersUseCase,
                    {
                        provide: PARAMETERS_SERVICE_TOKEN,
                        useValue: mockParametersService,
                    },
                    {
                        provide: ConfigService,
                        useValue: mockConfigService,
                    },
                    {
                        provide: CentralizedConfigPrService,
                        useValue: {
                            getCentralizedConfigWithValidatedPullRequest: jest
                                .fn()
                                .mockResolvedValue({
                                    enabled: true,
                                    repository: {
                                        id: 'repo-1',
                                        name: 'centralized-repo',
                                    },
                                    activePullRequest: null,
                                }),
                        },
                    },
                ],
            }).compile();

            const useCaseWithValidation =
                module.get<FindByKeyParametersUseCase>(
                    FindByKeyParametersUseCase,
                );

            const result = await useCaseWithValidation.execute(
                ParametersKey.CENTRALIZED_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(result.configValue.activePullRequest).toBeNull();
        });
    });

    describe('REGRESSION: Error handling', () => {
        it('should log error and rethrow when service throws', async () => {
            const testError = new Error('Database connection failed');
            mockParametersService.findByKey.mockRejectedValue(testError);

            await expect(
                useCase.execute(
                    ParametersKey.CODE_REVIEW_CONFIG,
                    MOCK_ORG_AND_TEAM_DATA,
                ),
            ).rejects.toThrow('Database connection failed');

            expect(mockLogger.error).toHaveBeenCalled();
        });

        it('should include parametersKey in error log metadata', async () => {
            const testError = new Error('Test error');
            mockParametersService.findByKey.mockRejectedValue(testError);

            try {
                await useCase.execute(
                    ParametersKey.CODE_REVIEW_CONFIG,
                    MOCK_ORG_AND_TEAM_DATA,
                );
            } catch {
                // Expected
            }

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: expect.objectContaining({
                        parametersKey: ParametersKey.CODE_REVIEW_CONFIG,
                    }),
                }),
            );
        });
    });
});

// ============================================================================
// CACHE OPTIMIZATION CONTRACT TESTS
// ============================================================================

describe('FindByKeyParametersUseCase - Cache Optimization Contract', () => {
    let useCase: FindByKeyParametersUseCase;
    let mockParametersService: ReturnType<typeof createMockParametersService>;

    beforeEach(async () => {
        mockParametersService = createMockParametersService();
        const mockCentralizedConfigPrService =
            createMockCentralizedConfigPrService();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                FindByKeyParametersUseCase,
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: mockParametersService,
                },
                {
                    provide: ConfigService,
                    useValue: mockConfigService,
                },
                {
                    provide: CentralizedConfigPrService,
                    useValue: mockCentralizedConfigPrService,
                },
            ],
        }).compile();

        useCase = module.get<FindByKeyParametersUseCase>(
            FindByKeyParametersUseCase,
        );

        jest.clearAllMocks();
    });

    describe('Cache behavior', () => {
        /**
         * OPTIMIZED: First call hits DB, subsequent calls use cache.
         * Cache has TTL (default 60s).
         */

        it('should call service only once for repeated calls within TTL (OPTIMIZED: with cache)', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.LANGUAGE_CONFIG,
                { language: 'en' },
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            // Call 3 times
            await useCase.execute(
                ParametersKey.LANGUAGE_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );
            await useCase.execute(
                ParametersKey.LANGUAGE_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );
            await useCase.execute(
                ParametersKey.LANGUAGE_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            // OPTIMIZED: Only 1 call to service (cache hit for calls 2 and 3)
            expect(mockParametersService.findByKey).toHaveBeenCalledTimes(1);
        });

        it('should return consistent results across multiple calls', async () => {
            const mockParameter = createMockParameterEntity(
                ParametersKey.LANGUAGE_CONFIG,
                { language: 'en' },
            );

            mockParametersService.findByKey.mockResolvedValue(mockParameter);

            const result1 = await useCase.execute(
                ParametersKey.LANGUAGE_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );
            const result2 = await useCase.execute(
                ParametersKey.LANGUAGE_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            // Results should be identical
            expect(result1).toEqual(result2);
        });
    });

    describe('FUTURE: Cache key scenarios', () => {
        /**
         * When implementing cache, the key should include:
         * - parametersKey
         * - organizationId
         * - teamId (if applicable)
         */

        it('should differentiate by organizationId', async () => {
            const mockParameter1 = createMockParameterEntity(
                ParametersKey.LANGUAGE_CONFIG,
                { language: 'en' },
            );
            const mockParameter2 = createMockParameterEntity(
                ParametersKey.LANGUAGE_CONFIG,
                { language: 'pt' },
            );

            mockParametersService.findByKey
                .mockResolvedValueOnce(mockParameter1)
                .mockResolvedValueOnce(mockParameter2);

            const result1 = await useCase.execute(
                ParametersKey.LANGUAGE_CONFIG,
                { organizationId: 'org-1' },
            );
            const result2 = await useCase.execute(
                ParametersKey.LANGUAGE_CONFIG,
                { organizationId: 'org-2' },
            );

            // Different orgs should get different results
            expect(result1.configValue.language).toBe('en');
            expect(result2.configValue.language).toBe('pt');
        });

        it('should differentiate by parametersKey', async () => {
            const langConfig = createMockParameterEntity(
                ParametersKey.LANGUAGE_CONFIG,
                { language: 'en' },
            );
            const checkinConfig = createMockParameterEntity(
                ParametersKey.CHECKIN_CONFIG,
                { time: '09:00' },
            );

            mockParametersService.findByKey
                .mockResolvedValueOnce(langConfig)
                .mockResolvedValueOnce(checkinConfig);

            const result1 = await useCase.execute(
                ParametersKey.LANGUAGE_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );
            const result2 = await useCase.execute(
                ParametersKey.CHECKIN_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );

            expect(result1.configKey).toBe(ParametersKey.LANGUAGE_CONFIG);
            expect(result2.configKey).toBe(ParametersKey.CHECKIN_CONFIG);
        });
    });
});

// ============================================================================
// PERFORMANCE BASELINE
// ============================================================================

describe('FindByKeyParametersUseCase - Performance Baseline', () => {
    let useCase: FindByKeyParametersUseCase;
    let mockParametersService: ReturnType<typeof createMockParametersService>;

    beforeEach(async () => {
        mockParametersService = createMockParametersService();
        const mockCentralizedConfigPrService =
            createMockCentralizedConfigPrService();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                FindByKeyParametersUseCase,
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: mockParametersService,
                },
                {
                    provide: ConfigService,
                    useValue: mockConfigService,
                },
                {
                    provide: CentralizedConfigPrService,
                    useValue: mockCentralizedConfigPrService,
                },
            ],
        }).compile();

        useCase = module.get<FindByKeyParametersUseCase>(
            FindByKeyParametersUseCase,
        );

        jest.clearAllMocks();
    });

    it('should document: OPTIMIZED implementation uses cache for repeated calls', async () => {
        /**
         * From performance report:
         * - findByKey is called 30+ times across the codebase per request
         * - BEFORE: Each call = 1 DB query (30 queries!)
         * - AFTER: First call = DB query, subsequent = cache hit
         * - Parameters rarely change, so 60s TTL is safe
         *
         * RESULT: ~29 DB queries saved per request cycle
         */

        const mockParameter = createMockParameterEntity(
            ParametersKey.CODE_REVIEW_CONFIG,
            { enabled: true },
        );

        mockParametersService.findByKey.mockResolvedValue(mockParameter);

        // Simulate 30 calls (matching the 30+ places in codebase)
        for (let i = 0; i < 30; i++) {
            await useCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                MOCK_ORG_AND_TEAM_DATA,
            );
        }

        // OPTIMIZED: Only 1 DB call (29 cache hits!)
        expect(mockParametersService.findByKey).toHaveBeenCalledTimes(1);
    });
});
