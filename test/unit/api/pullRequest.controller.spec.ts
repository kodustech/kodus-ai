import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { PullRequestController } from '@/core/infrastructure/http/controllers/pullRequest.controller';
import { GetEnrichedPullRequestsUseCase } from '@libs/code-review/application/use-cases/dashboard/get-enriched-pull-requests.use-case';
import { GetPullRequestsDailyDigestUseCase } from '@libs/code-review/application/use-cases/dashboard/get-pull-requests-daily-digest.use-case';
import { GetPullRequestsFacetsUseCase } from '@libs/code-review/application/use-cases/dashboard/get-pull-requests-facets.use-case';
import { GetAwaitingPullRequestsUseCase } from '@libs/code-review/application/use-cases/dashboard/get-awaiting-pull-requests.use-case';
import { GetPullRequestAuthorsUseCase } from '@libs/code-review/application/use-cases/dashboard/get-pull-request-authors.use-case';
import { GetPullRequestFilesUseCase } from '@libs/code-review/application/use-cases/pullRequests/get-pull-request-files.use-case';
import { GetPullRequestSuggestionsUseCase } from '@libs/code-review/application/use-cases/pullRequests/get-pull-request-suggestions.use-case';
import { CodeManagementService } from '@libs/platform/infrastructure/services/codeManagement.service';
import { BackfillHistoricalPRsUseCase } from '@libs/platformData/application/use-cases/pullRequests/backfill-historical-prs.use-case';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { TEAM_CLI_KEY_SERVICE_TOKEN } from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AUTH_SERVICE_TOKEN } from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import { CLI_DEVICE_SERVICE_TOKEN } from '@libs/organization/domain/cli-device/contracts/cli-device.service.contract';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

// ============================================================================
// FIXTURES
// ============================================================================

const ORG_ID = 'org-uuid-1111';
const TEAM_ID = 'team-uuid-2222';
const USER_EMAIL = 'dev@kodus.io';
const DEVICE_ID = 'device-uuid-4444';
const DEVICE_TOKEN = 'raw-device-token-5555';
const TEAM_KEY = 'kodus_test-team-key-1234';

const JWT_PAYLOAD = {
    email: USER_EMAIL,
    role: 'owner',
    status: STATUS.ACTIVE,
    organizationId: ORG_ID,
    sub: 'user-uuid-3333',
};

const VALID_JWT = 'valid.jwt.token';
const BEARER_JWT = `Bearer ${VALID_JWT}`;
const BEARER_TEAM_KEY = `Bearer ${TEAM_KEY}`;

const TEAM_KEY_DATA = {
    team: { uuid: TEAM_ID, name: 'my-team' },
    organization: { uuid: ORG_ID, name: 'my-org' },
};

const PR_URL = 'https://github.com/org/repo/pull/42';

function makePrEntity(overrides: Record<string, any> = {}) {
    const data = {
        number: 42,
        repository: { id: 'repo-123', fullName: 'org/repo' },
        files: [
            {
                path: 'src/index.ts',
                suggestions: [
                    {
                        deliveryStatus: DeliveryStatus.SENT,
                        severity: 'critical',
                        label: 'bug',
                        oneSentenceSummary: 'Null pointer dereference',
                        suggestionContent: 'Add null check',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 15,
                    },
                ],
            },
        ],
        prLevelSuggestions: [
            {
                deliveryStatus: DeliveryStatus.SENT,
                severity: 'medium',
                label: 'architecture',
                oneSentenceSummary: 'Consider splitting the module',
                suggestionContent: 'This module has grown too large',
            },
        ],
        ...overrides,
    };
    return { toObject: () => data };
}

function makePassthroughRes() {
    return { setHeader: jest.fn() } as any;
}

// ============================================================================
// MOCKS
// ============================================================================

const mockJwtService = { verify: jest.fn() };
const mockConfigService = {
    get: jest.fn().mockReturnValue({ secret: 'test-secret' }),
};
const mockAuthService = { validateUser: jest.fn() };
const mockTeamCliKeyService = { validateKey: jest.fn() };
const mockCliDeviceService = {
    validateOrRegisterDevice: jest.fn().mockResolvedValue({}),
};
const mockPullRequestsService = { findOne: jest.fn() };
const mockAutomationExecutionService = {
    create: jest.fn().mockResolvedValue({}),
};
const mockGetEnrichedPRs = { execute: jest.fn() };
const mockGetPullRequestsDailyDigest = { execute: jest.fn() };
const mockGetPullRequestsFacets = { execute: jest.fn() };
const mockGetAwaitingPullRequests = { execute: jest.fn() };
const mockGetPullRequestAuthors = { execute: jest.fn() };
const mockGetPullRequestSuggestionsUseCase = { execute: jest.fn() };
const mockGetPullRequestFilesUseCase = { execute: jest.fn() };
const mockCodeManagement = {
    getRepositories: jest.fn(),
    getPullRequestReviewThreads: jest.fn(),
    getPullRequestReviewComments: jest.fn(),
};
const mockBackfillPRs = { execute: jest.fn() };
const mockRequest = { user: { organization: { uuid: ORG_ID } } };

// ============================================================================
// SUITE
// ============================================================================

describe('PullRequestController', () => {
    let controller: PullRequestController;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PullRequestController,
                {
                    provide: GetEnrichedPullRequestsUseCase,
                    useValue: mockGetEnrichedPRs,
                },
                {
                    provide: GetPullRequestsDailyDigestUseCase,
                    useValue: mockGetPullRequestsDailyDigest,
                },
                {
                    provide: GetPullRequestsFacetsUseCase,
                    useValue: mockGetPullRequestsFacets,
                },
                {
                    provide: GetAwaitingPullRequestsUseCase,
                    useValue: mockGetAwaitingPullRequests,
                },
                {
                    provide: GetPullRequestAuthorsUseCase,
                    useValue: mockGetPullRequestAuthors,
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagement,
                },
                {
                    provide: GetPullRequestSuggestionsUseCase,
                    useValue: mockGetPullRequestSuggestionsUseCase,
                },
                {
                    provide: GetPullRequestFilesUseCase,
                    useValue: mockGetPullRequestFilesUseCase,
                },
                {
                    provide: BackfillHistoricalPRsUseCase,
                    useValue: mockBackfillPRs,
                },
                { provide: REQUEST, useValue: mockRequest },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: mockPullRequestsService,
                },
                {
                    provide: TEAM_CLI_KEY_SERVICE_TOKEN,
                    useValue: mockTeamCliKeyService,
                },
                {
                    provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
                    useValue: mockAutomationExecutionService,
                },
                {
                    provide: AUTH_SERVICE_TOKEN,
                    useValue: mockAuthService,
                },
                {
                    provide: CLI_DEVICE_SERVICE_TOKEN,
                    useValue: mockCliDeviceService,
                },
                { provide: JwtService, useValue: mockJwtService },
                { provide: ConfigService, useValue: mockConfigService },
                {
                    provide: EventEmitter2,
                    useValue: { emit: jest.fn() },
                },
            ],
        })
            .overrideGuard(PolicyGuard)
            .useValue({ canActivate: () => true })
            .compile();

        controller = module.get(PullRequestController);

        jest.clearAllMocks();

        // Default happy-path stubs
        mockJwtService.verify.mockReturnValue(JWT_PAYLOAD);
        mockAuthService.validateUser.mockResolvedValue({
            email: USER_EMAIL,
            role: JWT_PAYLOAD.role,
            status: STATUS.ACTIVE,
        });
        mockPullRequestsService.findOne.mockResolvedValue(makePrEntity());
        mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({});
        mockAutomationExecutionService.create.mockResolvedValue({});
        mockGetPullRequestSuggestionsUseCase.execute.mockResolvedValue({
            response: {
                prNumber: 42,
                repositoryId: 'repo-123',
                repositoryFullName: 'org/repo',
                suggestions: {
                    files: [
                        {
                            filePath: 'src/index.ts',
                            severity: 'critical',
                            label: 'bug',
                        },
                    ],
                    prLevel: [
                        {
                            severity: 'medium',
                            label: 'architecture',
                        },
                    ],
                },
            },
            suggestionsCount: 2,
        });
    });

    // =========================================================================
    // GET /pull-requests/suggestions – Team key auth
    // =========================================================================

    describe('GET /pull-requests/suggestions – Team key auth', () => {
        it('returns suggestions with valid team key via x-team-key', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);

            const result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
            );

            expect(mockTeamCliKeyService.validateKey).toHaveBeenCalledWith(
                TEAM_KEY,
            );
            expect(mockJwtService.verify).not.toHaveBeenCalled();
            expect(result).toHaveProperty('suggestions');
            expect(result.suggestions.files).toHaveLength(1);
            expect(result.suggestions.prLevel).toHaveLength(1);
        });

        it('returns suggestions with team key via Bearer kodus_ header', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);

            const result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                undefined,
                BEARER_TEAM_KEY,
            );

            expect(mockTeamCliKeyService.validateKey).toHaveBeenCalledWith(
                TEAM_KEY,
            );
            expect(result).toHaveProperty('suggestions');
        });

        it('throws 401 when team key is invalid', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(null);

            await expect(
                controller.getSuggestionsByPullRequest(
                    PR_URL,
                    undefined,
                    undefined,
                    'json',
                    undefined,
                    undefined,
                    'kodus_bad',
                ),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('throws 401 when team key has no org uuid', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue({
                team: { uuid: TEAM_ID },
                organization: { uuid: undefined },
            });

            await expect(
                controller.getSuggestionsByPullRequest(
                    PR_URL,
                    undefined,
                    undefined,
                    'json',
                    undefined,
                    undefined,
                    TEAM_KEY,
                ),
            ).rejects.toThrow(UnauthorizedException);
        });
    });

    // =========================================================================
    // GET /pull-requests/suggestions – JWT auth
    // =========================================================================

    describe('GET /pull-requests/suggestions – JWT auth', () => {
        it('returns suggestions with valid JWT', async () => {
            const result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                undefined,
                BEARER_JWT,
            );

            expect(mockJwtService.verify).toHaveBeenCalledWith(VALID_JWT, {
                secret: 'test-secret',
            });
            expect(result).toHaveProperty('suggestions');
            expect(result.prNumber).toBe(42);
        });

        it('throws 401 when JWT is invalid', async () => {
            mockJwtService.verify.mockImplementation(() => {
                throw new Error('jwt expired');
            });

            await expect(
                controller.getSuggestionsByPullRequest(
                    PR_URL,
                    undefined,
                    undefined,
                    'json',
                    undefined,
                    undefined,
                    undefined,
                    BEARER_JWT,
                ),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('throws 401 when user account is inactive', async () => {
            mockAuthService.validateUser.mockResolvedValue({
                email: USER_EMAIL,
                role: JWT_PAYLOAD.role,
                status: STATUS.REMOVED,
            });

            await expect(
                controller.getSuggestionsByPullRequest(
                    PR_URL,
                    undefined,
                    undefined,
                    'json',
                    undefined,
                    undefined,
                    undefined,
                    BEARER_JWT,
                ),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('throws 401 when user role has changed', async () => {
            mockAuthService.validateUser.mockResolvedValue({
                email: USER_EMAIL,
                role: 'member',
                status: STATUS.ACTIVE,
            });

            await expect(
                controller.getSuggestionsByPullRequest(
                    PR_URL,
                    undefined,
                    undefined,
                    'json',
                    undefined,
                    undefined,
                    undefined,
                    BEARER_JWT,
                ),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('throws 401 when JWT has no organizationId', async () => {
            mockJwtService.verify.mockReturnValue({
                ...JWT_PAYLOAD,
                organizationId: undefined,
            });

            await expect(
                controller.getSuggestionsByPullRequest(
                    PR_URL,
                    undefined,
                    undefined,
                    'json',
                    undefined,
                    undefined,
                    undefined,
                    BEARER_JWT,
                ),
            ).rejects.toThrow(UnauthorizedException);
        });
    });

    // =========================================================================
    // GET /pull-requests/suggestions – No auth
    // =========================================================================

    describe('GET /pull-requests/suggestions – No auth', () => {
        it('throws 401 when no auth is provided', async () => {
            await expect(
                controller.getSuggestionsByPullRequest(PR_URL),
            ).rejects.toThrow(UnauthorizedException);
        });
    });

    // =========================================================================
    // PR resolution
    // =========================================================================

    describe('GET /pull-requests/suggestions – PR resolution', () => {
        beforeEach(() => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);
        });

        it('finds PR by URL', async () => {
            const result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
            );

            expect(mockPullRequestsService.findOne).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: PR_URL,
                    organizationId: ORG_ID,
                }),
            );
            expect(result.prNumber).toBe(42);
        });

        it('falls back to parsing GitHub URL when direct lookup fails', async () => {
            mockPullRequestsService.findOne
                .mockResolvedValueOnce(null) // direct URL lookup fails
                .mockResolvedValueOnce(makePrEntity()); // fullName + number succeeds

            const result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
            );

            expect(mockPullRequestsService.findOne).toHaveBeenCalledTimes(2);
            expect(result.prNumber).toBe(42);
        });

        it('finds PR by repositoryId + prNumber', async () => {
            mockPullRequestsService.findOne.mockResolvedValueOnce(
                makePrEntity(),
            );

            const result = await controller.getSuggestionsByPullRequest(
                undefined,
                'repo-123',
                '42',
                'json',
                undefined,
                undefined,
                TEAM_KEY,
            );

            expect(result.prNumber).toBe(42);
        });

        it('finds PR by repository fullName as repositoryId', async () => {
            mockPullRequestsService.findOne
                .mockResolvedValueOnce(null) // by repo.id fails
                .mockResolvedValueOnce(makePrEntity()); // by fullName succeeds

            const result = await controller.getSuggestionsByPullRequest(
                undefined,
                'org/repo',
                '42',
                'json',
                undefined,
                undefined,
                TEAM_KEY,
            );

            expect(mockPullRequestsService.findOne).toHaveBeenCalledTimes(2);
            expect(result.prNumber).toBe(42);
        });

        it('throws 404 when PR is not found by URL', async () => {
            mockPullRequestsService.findOne.mockResolvedValue(null);

            await expect(
                controller.getSuggestionsByPullRequest(
                    'https://github.com/org/repo/pull/999',
                    undefined,
                    undefined,
                    'json',
                    undefined,
                    undefined,
                    TEAM_KEY,
                ),
            ).rejects.toThrow(NotFoundException);
        });

        it('throws 404 when PR is not found by repoId + prNumber', async () => {
            mockPullRequestsService.findOne.mockResolvedValue(null);

            await expect(
                controller.getSuggestionsByPullRequest(
                    undefined,
                    'repo-123',
                    '999',
                    'json',
                    undefined,
                    undefined,
                    TEAM_KEY,
                ),
            ).rejects.toThrow(NotFoundException);
        });

        it('throws 404 when no identifier is provided', async () => {
            await expect(
                controller.getSuggestionsByPullRequest(
                    undefined,
                    undefined,
                    undefined,
                    'json',
                    undefined,
                    undefined,
                    TEAM_KEY,
                ),
            ).rejects.toThrow(NotFoundException);
        });
    });

    // =========================================================================
    // Response format
    // =========================================================================

    describe('GET /pull-requests/suggestions – Response format', () => {
        beforeEach(() => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);
        });

        it('returns JSON payload by default', async () => {
            const result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
            );

            expect(result).toHaveProperty('prNumber', 42);
            expect(result).toHaveProperty('repositoryId', 'repo-123');
            expect(result).toHaveProperty('repositoryFullName', 'org/repo');
            expect(result).toHaveProperty('suggestions');
            expect(result.suggestions.files[0]).toHaveProperty(
                'filePath',
                'src/index.ts',
            );
        });

        it('returns markdown when format=markdown', async () => {
            mockGetPullRequestSuggestionsUseCase.execute.mockResolvedValueOnce({
                response: {
                    markdown: '# Suggestions for PR #42 (org/repo)',
                },
                suggestionsCount: 1,
            });

            const result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'markdown',
                undefined,
                undefined,
                TEAM_KEY,
            );

            expect(result).toHaveProperty('markdown');
            expect(result.markdown).toContain('# Suggestions for PR #42');
            expect(result.markdown).toContain('org/repo');
        });

        it('forwards severity filter to the suggestions use case', async () => {
            await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                'critical',
                undefined,
                TEAM_KEY,
            );

            expect(
                mockGetPullRequestSuggestionsUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    severity: 'critical',
                }),
            );
        });

        it('forwards category filter to the suggestions use case', async () => {
            await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                'architecture',
                TEAM_KEY,
            );

            expect(
                mockGetPullRequestSuggestionsUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    category: 'architecture',
                }),
            );
        });

        it('delegates suggestion shaping to the use case', async () => {
            mockPullRequestsService.findOne.mockResolvedValue(
                makePrEntity({
                    files: [
                        {
                            path: 'a.ts',
                            suggestions: [
                                {
                                    deliveryStatus: DeliveryStatus.SENT,
                                    severity: 'high',
                                    label: 'bug',
                                },
                                {
                                    deliveryStatus: DeliveryStatus.NOT_SENT,
                                    severity: 'low',
                                    label: 'style',
                                },
                                {
                                    deliveryStatus: DeliveryStatus.FAILED,
                                    severity: 'medium',
                                    label: 'perf',
                                },
                            ],
                        },
                    ],
                    prLevelSuggestions: [],
                }),
            );

            const _result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
            );

            expect(
                mockGetPullRequestSuggestionsUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    pr: expect.objectContaining({
                        files: [
                            expect.objectContaining({
                                path: 'a.ts',
                            }),
                        ],
                    }),
                }),
            );
        });
    });

    // =========================================================================
    // Device tracking – GET /pull-requests/suggestions
    // =========================================================================

    describe('GET /pull-requests/suggestions – Device tracking', () => {
        beforeEach(() => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);
        });

        it('new device: sets header + includes token in body', async () => {
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({
                deviceToken: 'new-pr-token',
            });
            const res = makePassthroughRes();

            const result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
                undefined,
                DEVICE_ID,
                undefined,
                'Kodus-CLI/1.0',
                res,
            );

            expect(
                mockCliDeviceService.validateOrRegisterDevice,
            ).toHaveBeenCalledWith({
                deviceId: DEVICE_ID,
                deviceToken: undefined,
                organizationId: ORG_ID,
                userAgent: 'Kodus-CLI/1.0',
            });
            expect(res.setHeader).toHaveBeenCalledWith(
                'x-kodus-device-token',
                'new-pr-token',
            );
            expect(result).toHaveProperty('deviceToken', 'new-pr-token');
        });

        it('valid device: no header, no extra token in body', async () => {
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({});
            const res = makePassthroughRes();

            const result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
                undefined,
                DEVICE_ID,
                DEVICE_TOKEN,
                'Kodus-CLI/1.0',
                res,
            );

            expect(res.setHeader).not.toHaveBeenCalled();
            expect(result).not.toHaveProperty('deviceToken');
        });

        it('no device header: skips device tracking entirely', async () => {
            const result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
                undefined,
                undefined, // no device id
            );

            expect(
                mockCliDeviceService.validateOrRegisterDevice,
            ).not.toHaveBeenCalled();
            expect(result).not.toHaveProperty('deviceToken');
        });

        it('device limit reached throws 401', async () => {
            mockCliDeviceService.validateOrRegisterDevice.mockRejectedValue(
                new UnauthorizedException({
                    message: 'Device limit reached',
                    code: 'DEVICE_LIMIT_REACHED',
                    details: { limit: 2, current: 2 },
                }),
            );

            try {
                await controller.getSuggestionsByPullRequest(
                    PR_URL,
                    undefined,
                    undefined,
                    'json',
                    undefined,
                    undefined,
                    TEAM_KEY,
                    undefined,
                    DEVICE_ID,
                    undefined,
                    'Kodus-CLI/1.0',
                );
                fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(UnauthorizedException);
                expect(error.getResponse().code).toBe('DEVICE_LIMIT_REACHED');
            }
        });
    });

    // =========================================================================
    // POST /pull-requests/cli/suggestions
    // =========================================================================

    describe('POST /pull-requests/cli/suggestions', () => {
        it('returns suggestions with team key', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);

            const result = await controller.getSuggestionsByPullRequestWithKey(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
            );

            expect(result).toHaveProperty('suggestions');
            expect(result.prNumber).toBe(42);
        });

        it('returns suggestions with JWT', async () => {
            const result = await controller.getSuggestionsByPullRequestWithKey(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                undefined,
                BEARER_JWT,
            );

            expect(result).toHaveProperty('suggestions');
        });

        it('sets x-kodus-device-token header for new device', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({
                deviceToken: 'post-cli-token',
            });
            const res = makePassthroughRes();

            await controller.getSuggestionsByPullRequestWithKey(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
                undefined,
                DEVICE_ID,
                undefined,
                'Kodus-CLI/1.0',
                res,
            );

            expect(res.setHeader).toHaveBeenCalledWith(
                'x-kodus-device-token',
                'post-cli-token',
            );
        });

        it('throws 401 with no auth', async () => {
            await expect(
                controller.getSuggestionsByPullRequestWithKey(PR_URL),
            ).rejects.toThrow(UnauthorizedException);
        });
    });

    // =========================================================================
    // GET /pull-requests/cli/suggestions
    // =========================================================================

    describe('GET /pull-requests/cli/suggestions', () => {
        it('returns suggestions with team key', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);

            const result =
                await controller.getSuggestionsByPullRequestWithKeyGet(
                    PR_URL,
                    undefined,
                    undefined,
                    'json',
                    undefined,
                    undefined,
                    TEAM_KEY,
                );

            expect(result).toHaveProperty('suggestions');
        });

        it('returns suggestions with JWT', async () => {
            const result =
                await controller.getSuggestionsByPullRequestWithKeyGet(
                    PR_URL,
                    undefined,
                    undefined,
                    'json',
                    undefined,
                    undefined,
                    undefined,
                    BEARER_JWT,
                );

            expect(result).toHaveProperty('suggestions');
        });

        it('sets x-kodus-device-token header for new device', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({
                deviceToken: 'get-cli-token',
            });
            const res = makePassthroughRes();

            await controller.getSuggestionsByPullRequestWithKeyGet(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
                undefined,
                DEVICE_ID,
                undefined,
                'Kodus-CLI/1.0',
                res,
            );

            expect(res.setHeader).toHaveBeenCalledWith(
                'x-kodus-device-token',
                'get-cli-token',
            );
        });

        it('throws 401 with no auth', async () => {
            await expect(
                controller.getSuggestionsByPullRequestWithKeyGet(PR_URL),
            ).rejects.toThrow(UnauthorizedException);
        });
    });

    // =========================================================================
    // Device tracking works with JWT auth too
    // =========================================================================

    describe('Device tracking with JWT auth', () => {
        it('registers device and sets header when using JWT', async () => {
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({
                deviceToken: 'jwt-device-token',
            });
            const res = makePassthroughRes();

            const result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                undefined,
                BEARER_JWT,
                DEVICE_ID,
                undefined,
                'Kodus-CLI/1.0',
                res,
            );

            expect(
                mockCliDeviceService.validateOrRegisterDevice,
            ).toHaveBeenCalledWith({
                deviceId: DEVICE_ID,
                deviceToken: undefined,
                organizationId: ORG_ID,
                userAgent: 'Kodus-CLI/1.0',
            });
            expect(res.setHeader).toHaveBeenCalledWith(
                'x-kodus-device-token',
                'jwt-device-token',
            );
            expect(result).toHaveProperty('deviceToken', 'jwt-device-token');
        });
    });

    // =========================================================================
    // trackSuggestionsFetch (fire-and-forget)
    // =========================================================================

    describe('Suggestions fetch tracking', () => {
        beforeEach(() => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);
        });

        it('calls automationExecutionService.create for every suggestions request', async () => {
            await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
            );

            expect(mockAutomationExecutionService.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    origin: 'cli-suggestions',
                    dataExecution: expect.objectContaining({
                        type: 'CLI_PR_SUGGESTIONS',
                        organizationId: ORG_ID,
                        prNumber: 42,
                        repositoryFullName: 'org/repo',
                        format: 'json',
                    }),
                }),
            );
        });

        it('includes suggestion count in tracking data', async () => {
            await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
            );

            expect(mockAutomationExecutionService.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    dataExecution: expect.objectContaining({
                        suggestionsCount: 2, // 1 file-level + 1 pr-level
                    }),
                }),
            );
        });

        it('includes filter info in tracking when severity/category are set', async () => {
            await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                'critical',
                'bug',
                TEAM_KEY,
            );

            expect(mockAutomationExecutionService.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    dataExecution: expect.objectContaining({
                        filters: {
                            severity: 'critical',
                            category: 'bug',
                        },
                    }),
                }),
            );
        });

        it('does not include filters when none are set', async () => {
            await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
            );

            expect(mockAutomationExecutionService.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    dataExecution: expect.objectContaining({
                        filters: undefined,
                    }),
                }),
            );
        });

        it('does not fail the request if tracking throws', async () => {
            mockAutomationExecutionService.create.mockRejectedValue(
                new Error('tracking failed'),
            );

            const result = await controller.getSuggestionsByPullRequest(
                PR_URL,
                undefined,
                undefined,
                'json',
                undefined,
                undefined,
                TEAM_KEY,
            );

            // Request still succeeds
            expect(result).toHaveProperty('suggestions');
        });
    });
});
