import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
    ForbiddenException,
    HttpException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';

import { CliReviewController } from '@/core/infrastructure/http/controllers/cli/cli-review.controller';
import { ExecuteCliReviewUseCase } from '@libs/cli-review/application/use-cases/execute-cli-review.use-case';
import { EnqueueCliReviewUseCase } from '@libs/cli-review/application/use-cases/enqueue-cli-review.use-case';
import { GetCliReviewJobStatusUseCase } from '@libs/cli-review/application/use-cases/get-cli-review-job-status.use-case';
import { WaitForCliReviewJobUseCase } from '@libs/cli-review/application/use-cases/wait-for-cli-review-job.use-case';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { SubmitCliSessionCaptureUseCase } from '@libs/cli-review/application/use-cases/submit-cli-session-capture.use-case';
import { AUTHENTICATED_RATE_LIMITER_SERVICE_TOKEN } from '@libs/cli-review/domain/contracts/authenticated-rate-limiter.service.contract';
import { TRIAL_RATE_LIMITER_SERVICE_TOKEN } from '@libs/cli-review/domain/contracts/trial-rate-limiter.service.contract';
import { GITHUB_PUBLIC_PR_SERVICE_TOKEN } from '@libs/cli-review/domain/contracts/github-public-pr.service.contract';
import { TEAM_CLI_KEY_SERVICE_TOKEN } from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import { TEAM_SERVICE_TOKEN } from '@libs/organization/domain/team/contracts/team.service.contract';
import { AUTH_SERVICE_TOKEN } from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import { CLI_DEVICE_SERVICE_TOKEN } from '@libs/organization/domain/cli-device/contracts/cli-device.service.contract';
import { TriggerBusinessValidationUseCase } from '@libs/platform/application/use-cases/codeManagement/trigger-business-validation.use-case';
import { TeamEntity } from '@libs/organization/domain/team/entities/team.entity';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { CliReviewRequestDto } from '@/core/infrastructure/http/dtos/cli-review.dto';
import { IngestSessionEventUseCase } from '@libs/cli-review/application/use-cases/ingest-session-event.use-case';
import { PublicPrReviewUseCase } from '@libs/cli-review/application/use-cases/public-pr-review.use-case';
import { ListFeaturedPublicReviewsUseCase } from '@libs/cli-review/application/use-cases/list-featured-public-reviews.use-case';
import { GetFeaturedPublicReviewUseCase } from '@libs/cli-review/application/use-cases/get-featured-public-review.use-case';
import { ValidateCliKeyUseCase } from '@libs/cli-review/application/use-cases/validate-cli-key.use-case';

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
    team: { uuid: TEAM_ID, name: 'my-team', cliConfig: null },
    organization: { uuid: ORG_ID, name: 'my-org' },
};

function makeTeamEntity(overrides: { uuid?: string; orgUuid?: string } = {}) {
    return TeamEntity.create({
        uuid: overrides.uuid ?? TEAM_ID,
        name: 'my-team',
        status: STATUS.ACTIVE,
        organization: { uuid: overrides.orgUuid ?? ORG_ID, name: 'my-org' },
        cliConfig: null,
    });
}

const MINIMAL_BODY: CliReviewRequestDto = {
    diff: 'diff --git a/x b/x\n+const x = 1;',
};

const SESSION_CAPTURE_BODY = {
    branch: 'feat/auth',
    sha: 'a1b2c3d4e5f6',
    orgRepo: 'kodustech/cli',
    agent: 'claude-code',
    event: 'stop',
    signals: {
        sessionId: 'sess-abc',
        turnId: 'turn-123',
        prompt: 'Refactor auth to use JWT',
        assistantMessage: 'I decided to use JWT for stateless authentication.',
        modifiedFiles: ['src/auth/jwt.ts', 'src/auth/middleware.ts'],
        toolUses: [
            {
                tool: 'Write',
                filePath: 'src/auth/jwt.ts',
                summary: 'Created JWT helper',
            },
        ],
    },
    summary: 'Refactored auth module',
    capturedAt: '2025-06-01T10:30:00.000Z',
};

function makeRes() {
    const res: any = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
    };
    return res;
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
const mockTeamService = {
    findById: jest.fn(),
    findFirstCreatedTeam: jest.fn(),
};
const mockTeamCliKeyService = { validateKey: jest.fn() };
const mockRateLimiter = {
    checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
};
const mockTrialRateLimiter = {
    checkRateLimit: jest.fn(),
    getRateLimitStatus: jest.fn(),
};
const mockExecuteCliReview = {
    execute: jest.fn().mockResolvedValue({ suggestions: [] }),
};
const mockEnqueueCliReview = {
    execute: jest
        .fn()
        .mockResolvedValue({ jobId: 'job-1', correlationId: 'corr-1' }),
};
// Job-status / wait-for-job logic was extracted out of the controller and
// into dedicated use cases; tests mock those directly instead of poking
// the underlying queue service.
const mockGetCliReviewJobStatus = {
    execute: jest.fn().mockResolvedValue({
        jobId: 'job-1',
        status: JobStatus.COMPLETED,
        result: { suggestions: [] },
        createdAt: new Date(),
    }),
};
const mockWaitForCliReviewJob = {
    execute: jest.fn().mockResolvedValue({ suggestions: [] }),
};
const mockSubmitCliSessionCapture = {
    execute: jest.fn().mockResolvedValue({ id: 'cap_abc123', accepted: true }),
};
const mockTriggerBusinessValidation = {
    execute: jest.fn(),
};
const mockIngestSessionEvent = {
    execute: jest.fn().mockResolvedValue({ accepted: true }),
};
const mockCliDeviceService = {
    validateOrRegisterDevice: jest.fn().mockResolvedValue({}),
};
const mockPublicPrReview = { execute: jest.fn() };
const mockListFeaturedReviews = { execute: jest.fn() };
const mockGetFeaturedReview = { execute: jest.fn() };

// ============================================================================
// SUITE
// ============================================================================

describe('CliReviewController', () => {
    let controller: CliReviewController;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CliReviewController,
                {
                    provide: ExecuteCliReviewUseCase,
                    useValue: mockExecuteCliReview,
                },
                {
                    provide: EnqueueCliReviewUseCase,
                    useValue: mockEnqueueCliReview,
                },
                {
                    provide: GetCliReviewJobStatusUseCase,
                    useValue: mockGetCliReviewJobStatus,
                },
                {
                    provide: WaitForCliReviewJobUseCase,
                    useValue: mockWaitForCliReviewJob,
                },
                {
                    provide: SubmitCliSessionCaptureUseCase,
                    useValue: mockSubmitCliSessionCapture,
                },
                {
                    provide: IngestSessionEventUseCase,
                    useValue: mockIngestSessionEvent,
                },
                {
                    provide: TriggerBusinessValidationUseCase,
                    useValue: mockTriggerBusinessValidation,
                },
                {
                    provide: AUTHENTICATED_RATE_LIMITER_SERVICE_TOKEN,
                    useValue: mockRateLimiter,
                },
                {
                    provide: TRIAL_RATE_LIMITER_SERVICE_TOKEN,
                    useValue: mockTrialRateLimiter,
                },
                // Public-demo deps — only the trial endpoints touch
                // these, but Nest needs every constructor arg resolved
                // even when the test never calls those routes.
                {
                    provide: GITHUB_PUBLIC_PR_SERVICE_TOKEN,
                    useValue: { fetch: jest.fn() },
                },
                {
                    provide: PublicPrReviewUseCase,
                    useValue: mockPublicPrReview,
                },
                {
                    provide: ListFeaturedPublicReviewsUseCase,
                    useValue: mockListFeaturedReviews,
                },
                {
                    provide: GetFeaturedPublicReviewUseCase,
                    useValue: mockGetFeaturedReview,
                },
                // Real use case wired against the existing mocked tokens
                // (teamCliKey, team, auth, cliDevice, jwt, config) so
                // the controller test scenarios keep exercising the
                // validation logic end-to-end.
                ValidateCliKeyUseCase,
                {
                    provide: TEAM_CLI_KEY_SERVICE_TOKEN,
                    useValue: mockTeamCliKeyService,
                },
                {
                    provide: TEAM_SERVICE_TOKEN,
                    useValue: mockTeamService,
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
            ],
        }).compile();

        controller = module.get(CliReviewController);

        jest.clearAllMocks();

        // Default happy-path stubs
        mockJwtService.verify.mockReturnValue(JWT_PAYLOAD);
        mockAuthService.validateUser.mockResolvedValue({
            email: USER_EMAIL,
            role: JWT_PAYLOAD.role,
            status: STATUS.ACTIVE,
        });
        mockRateLimiter.checkRateLimit.mockResolvedValue({ allowed: true });
        mockExecuteCliReview.execute.mockResolvedValue({ suggestions: [] });
        mockSubmitCliSessionCapture.execute.mockResolvedValue({
            id: 'cap_abc123',
            accepted: true,
        });
        mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({});
    });

    // =========================================================================
    // POST /cli/review — JWT auth (Route 2)
    // =========================================================================

    describe('POST /cli/review – JWT auth', () => {
        describe('team resolved via findById (correct teamId)', () => {
            it('executes review when teamId matches a team in the org', async () => {
                mockTeamService.findById.mockResolvedValue(makeTeamEntity());

                const result = await controller.review(
                    MINIMAL_BODY,
                    undefined,
                    BEARER_JWT,
                    TEAM_ID,
                );

                expect(mockTeamService.findById).toHaveBeenCalledWith(TEAM_ID);
                expect(
                    mockTeamService.findFirstCreatedTeam,
                ).not.toHaveBeenCalled();
                expect(mockEnqueueCliReview.execute).toHaveBeenCalledWith(
                    expect.objectContaining({
                        organizationAndTeamData: {
                            organizationId: ORG_ID,
                            teamId: TEAM_ID,
                        },
                    }),
                );
                expect(result).toEqual({ suggestions: [] });
            });
        });

        describe('fallback via findFirstCreatedTeam', () => {
            it('falls back when CLI sends organizationId as teamId (main bug scenario)', async () => {
                mockTeamService.findById.mockResolvedValue(null);
                mockTeamService.findFirstCreatedTeam.mockResolvedValue(
                    makeTeamEntity(),
                );

                await controller.review(
                    MINIMAL_BODY,
                    undefined,
                    BEARER_JWT,
                    ORG_ID,
                );

                expect(mockTeamService.findById).toHaveBeenCalledWith(ORG_ID);
                expect(
                    mockTeamService.findFirstCreatedTeam,
                ).toHaveBeenCalledWith(ORG_ID);
                expect(mockEnqueueCliReview.execute).toHaveBeenCalledWith(
                    expect.objectContaining({
                        organizationAndTeamData: {
                            organizationId: ORG_ID,
                            teamId: TEAM_ID,
                        },
                    }),
                );
            });

            it('falls back when no teamId is provided at all', async () => {
                mockTeamService.findFirstCreatedTeam.mockResolvedValue(
                    makeTeamEntity(),
                );

                await controller.review(
                    MINIMAL_BODY,
                    undefined,
                    BEARER_JWT,
                    undefined,
                );

                expect(mockTeamService.findById).not.toHaveBeenCalled();
                expect(
                    mockTeamService.findFirstCreatedTeam,
                ).toHaveBeenCalledWith(ORG_ID);
                expect(mockEnqueueCliReview.execute).toHaveBeenCalled();
            });
        });

        describe('error cases', () => {
            it('throws 401 when no active team found for the org', async () => {
                mockTeamService.findById.mockResolvedValue(null);
                mockTeamService.findFirstCreatedTeam.mockResolvedValue(null);

                await expect(
                    controller.review(
                        MINIMAL_BODY,
                        undefined,
                        BEARER_JWT,
                        TEAM_ID,
                    ),
                ).rejects.toThrow(UnauthorizedException);
            });

            it('throws 401 when JWT is invalid', async () => {
                mockJwtService.verify.mockImplementation(() => {
                    throw new Error('jwt malformed');
                });

                await expect(
                    controller.review(
                        MINIMAL_BODY,
                        undefined,
                        BEARER_JWT,
                        TEAM_ID,
                    ),
                ).rejects.toThrow(UnauthorizedException);
            });

            it('throws 401 when user is not found', async () => {
                mockAuthService.validateUser.mockResolvedValue(null);

                await expect(
                    controller.review(
                        MINIMAL_BODY,
                        undefined,
                        BEARER_JWT,
                        TEAM_ID,
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
                    controller.review(
                        MINIMAL_BODY,
                        undefined,
                        BEARER_JWT,
                        TEAM_ID,
                    ),
                ).rejects.toThrow(UnauthorizedException);
            });

            it('throws 401 when user account is removed', async () => {
                mockAuthService.validateUser.mockResolvedValue({
                    email: USER_EMAIL,
                    role: JWT_PAYLOAD.role,
                    status: STATUS.REMOVED,
                });

                await expect(
                    controller.review(
                        MINIMAL_BODY,
                        undefined,
                        BEARER_JWT,
                        TEAM_ID,
                    ),
                ).rejects.toThrow(UnauthorizedException);
            });

            it('throws 403 when team belongs to a different org', async () => {
                mockTeamService.findById.mockResolvedValue(
                    makeTeamEntity({ orgUuid: 'other-org-uuid' }),
                );

                await expect(
                    controller.review(
                        MINIMAL_BODY,
                        undefined,
                        BEARER_JWT,
                        TEAM_ID,
                    ),
                ).rejects.toThrow(ForbiddenException);
            });

            it('throws 401 when no auth header is provided', async () => {
                await expect(
                    controller.review(
                        MINIMAL_BODY,
                        undefined,
                        undefined,
                        TEAM_ID,
                    ),
                ).rejects.toThrow(UnauthorizedException);
            });
        });
    });

    // =========================================================================
    // POST /cli/review — Team key auth (Route 1)
    // =========================================================================

    describe('POST /cli/review – Team key auth', () => {
        it('executes review with valid team key via x-team-key header', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);

            const result = await controller.review(
                MINIMAL_BODY,
                TEAM_KEY,
                undefined, // no auth header
                undefined, // no teamId query
            );

            expect(mockTeamCliKeyService.validateKey).toHaveBeenCalledWith(
                TEAM_KEY,
            );
            expect(mockJwtService.verify).not.toHaveBeenCalled();
            expect(mockEnqueueCliReview.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    organizationAndTeamData: {
                        organizationId: ORG_ID,
                        teamId: TEAM_ID,
                    },
                }),
            );
            expect(result).toEqual({ suggestions: [] });
        });

        it('executes review when team key is sent via Bearer header with kodus_ prefix', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);

            await controller.review(
                MINIMAL_BODY,
                undefined,
                BEARER_TEAM_KEY,
                undefined,
            );

            expect(mockTeamCliKeyService.validateKey).toHaveBeenCalledWith(
                TEAM_KEY,
            );
            expect(mockEnqueueCliReview.execute).toHaveBeenCalled();
        });

        it('throws 401 when team key is invalid/revoked', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(null);

            await expect(
                controller.review(MINIMAL_BODY, TEAM_KEY),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('throws 401 when team key data is incomplete (missing uuid)', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue({
                team: { uuid: null, name: 'team' },
                organization: { uuid: ORG_ID, name: 'org' },
            });

            await expect(
                controller.review(MINIMAL_BODY, TEAM_KEY),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('throws 401 when team key data has no organization uuid', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue({
                team: { uuid: TEAM_ID, name: 'team' },
                organization: { uuid: null, name: 'org' },
            });

            await expect(
                controller.review(MINIMAL_BODY, TEAM_KEY),
            ).rejects.toThrow(UnauthorizedException);
        });
    });

    // =========================================================================
    // POST /cli/review — Rate limiting
    // =========================================================================

    describe('POST /cli/review – Rate limiting', () => {
        it('throws 429 when rate limit is exceeded', async () => {
            mockTeamService.findById.mockResolvedValue(makeTeamEntity());
            mockRateLimiter.checkRateLimit.mockResolvedValue({
                allowed: false,
                remaining: 0,
                resetAt: new Date('2026-01-01T00:00:00Z'),
            });

            await expect(
                controller.review(MINIMAL_BODY, undefined, BEARER_JWT, TEAM_ID),
            ).rejects.toThrow(HttpException);

            try {
                await controller.review(
                    MINIMAL_BODY,
                    undefined,
                    BEARER_JWT,
                    TEAM_ID,
                );
            } catch (error) {
                expect(error.getStatus()).toBe(429);
            }
        });
    });

    // =========================================================================
    // POST /cli/memory/captures
    // =========================================================================

    describe('POST /cli/memory/captures', () => {
        it('submits capture with valid x-team-key', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);

            const result = await controller.submitSessionCapture(
                SESSION_CAPTURE_BODY as any,
                TEAM_KEY,
                undefined,
                undefined,
            );

            expect(mockTeamCliKeyService.validateKey).toHaveBeenCalledWith(
                TEAM_KEY,
            );
            expect(mockSubmitCliSessionCapture.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    organizationAndTeamData: {
                        organizationId: ORG_ID,
                        teamId: TEAM_ID,
                    },
                    input: expect.objectContaining({
                        branch: SESSION_CAPTURE_BODY.branch,
                        orgRepo: SESSION_CAPTURE_BODY.orgRepo,
                        event: 'stop',
                    }),
                }),
            );
            expect(result).toEqual({ id: 'cap_abc123', accepted: true });
        });

        it('submits capture with team key sent via Bearer kodus_ token', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);

            await controller.submitSessionCapture(
                SESSION_CAPTURE_BODY as any,
                undefined,
                BEARER_TEAM_KEY,
                undefined,
            );

            expect(mockTeamCliKeyService.validateKey).toHaveBeenCalledWith(
                TEAM_KEY,
            );
            expect(mockSubmitCliSessionCapture.execute).toHaveBeenCalled();
        });

        it('submits capture with JWT auth route', async () => {
            mockTeamService.findById.mockResolvedValue(makeTeamEntity());

            await controller.submitSessionCapture(
                SESSION_CAPTURE_BODY as any,
                undefined,
                BEARER_JWT,
                TEAM_ID,
            );

            expect(mockJwtService.verify).toHaveBeenCalledWith(VALID_JWT, {
                secret: 'test-secret',
            });
            expect(mockSubmitCliSessionCapture.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    organizationAndTeamData: {
                        organizationId: ORG_ID,
                        teamId: TEAM_ID,
                    },
                    input: expect.objectContaining({
                        branch: SESSION_CAPTURE_BODY.branch,
                        orgRepo: SESSION_CAPTURE_BODY.orgRepo,
                        event: 'stop',
                    }),
                }),
            );
        });

        it('throws 401 when auth is missing', async () => {
            await expect(
                controller.submitSessionCapture(
                    SESSION_CAPTURE_BODY as any,
                    undefined,
                    undefined,
                    undefined,
                ),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('throws 401 when team key is invalid', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(null);

            await expect(
                controller.submitSessionCapture(
                    SESSION_CAPTURE_BODY as any,
                    TEAM_KEY,
                    undefined,
                    undefined,
                ),
            ).rejects.toThrow(UnauthorizedException);
        });
    });

    // =========================================================================
    // validateKeyInternal
    // =========================================================================

    describe('validateKeyInternal', () => {
        // Helper kept after the validateKeyInternal helper was extracted
        // into ValidateCliKeyUseCase. Behaviorally identical — same
        // mocks back the same wires (teamCliKey, team, auth, jwt).
        const runValidate = (
            teamKey?: string,
            authHeader?: string,
            queryTeamId?: string,
        ) =>
            (controller as any).validateCliKeyUseCase.execute({
                teamKey,
                authHeader,
                queryTeamId,
            });

        describe('Team key route', () => {
            it('returns valid=true with team key via x-team-key', async () => {
                mockTeamCliKeyService.validateKey.mockResolvedValue(
                    TEAM_KEY_DATA,
                );

                const result = await runValidate(
                    TEAM_KEY,
                    undefined,
                    undefined,
                );

                expect(result.valid).toBe(true);
                expect(result.teamId).toBe(TEAM_ID);
                expect(result.organizationId).toBe(ORG_ID);
                expect(result.team.id).toBe(TEAM_ID);
                expect(result.organization.id).toBe(ORG_ID);
            });

            it('returns valid=true when team key is sent via Bearer kodus_', async () => {
                mockTeamCliKeyService.validateKey.mockResolvedValue(
                    TEAM_KEY_DATA,
                );

                const result = await runValidate(
                    undefined,
                    BEARER_TEAM_KEY,
                    undefined,
                );

                expect(result.valid).toBe(true);
                expect(mockTeamCliKeyService.validateKey).toHaveBeenCalledWith(
                    TEAM_KEY,
                );
            });

            it('returns valid=false when team key is invalid', async () => {
                mockTeamCliKeyService.validateKey.mockResolvedValue(null);

                const result = await runValidate(
                    'kodus_invalid',
                    undefined,
                    undefined,
                );

                expect(result.valid).toBe(false);
                expect(result.error).toBeDefined();
            });

            it('returns valid=false when team key data is incomplete', async () => {
                mockTeamCliKeyService.validateKey.mockResolvedValue({
                    team: { uuid: null },
                    organization: { uuid: ORG_ID },
                });

                const result = await runValidate(
                    TEAM_KEY,
                    undefined,
                    undefined,
                );

                expect(result.valid).toBe(false);
            });
        });

        describe('JWT route', () => {
            it('returns valid=true with correct teamId resolved via findById', async () => {
                mockTeamService.findById.mockResolvedValue(makeTeamEntity());

                const result = await runValidate(
                    undefined,
                    BEARER_JWT,
                    TEAM_ID,
                );

                expect(result.valid).toBe(true);
                expect(result.teamId).toBe(TEAM_ID);
                expect(result.organizationId).toBe(ORG_ID);
            });

            it('returns valid=true via fallback when CLI sends orgId as teamId', async () => {
                mockTeamService.findById.mockResolvedValue(null);
                mockTeamService.findFirstCreatedTeam.mockResolvedValue(
                    makeTeamEntity(),
                );

                const result = await runValidate(
                    undefined,
                    BEARER_JWT,
                    ORG_ID,
                );

                expect(result.valid).toBe(true);
                expect(result.teamId).toBe(TEAM_ID);
            });

            it('returns valid=false when explicit teamId is not found and differs from orgId', async () => {
                mockTeamService.findById.mockResolvedValue(null);

                const result = await runValidate(
                    undefined,
                    BEARER_JWT,
                    'stale-team-uuid',
                );

                expect(result.valid).toBe(false);
                expect(result.error).toContain('Team not found');
                expect(
                    mockTeamService.findFirstCreatedTeam,
                ).not.toHaveBeenCalled();
            });

            it('returns valid=false when no teamId provided and no team exists for org', async () => {
                mockTeamService.findFirstCreatedTeam.mockResolvedValue(null);

                const result = await runValidate(
                    undefined,
                    BEARER_JWT,
                    undefined,
                );

                expect(result.valid).toBe(false);
            });

            it('returns valid=false when JWT is invalid', async () => {
                mockJwtService.verify.mockImplementation(() => {
                    throw new Error('jwt expired');
                });

                const result = await runValidate(
                    undefined,
                    BEARER_JWT,
                    TEAM_ID,
                );

                expect(result.valid).toBe(false);
                expect(result.error).toMatch(/invalid|expired/i);
            });

            it('returns valid=false when team belongs to different org', async () => {
                mockTeamService.findById.mockResolvedValue(
                    makeTeamEntity({ orgUuid: 'other-org-uuid' }),
                );

                const result = await runValidate(
                    undefined,
                    BEARER_JWT,
                    TEAM_ID,
                );

                expect(result.valid).toBe(false);
            });

            it('returns valid=false when user is inactive', async () => {
                mockAuthService.validateUser.mockResolvedValue({
                    email: USER_EMAIL,
                    role: JWT_PAYLOAD.role,
                    status: STATUS.REMOVED,
                });

                const result = await runValidate(
                    undefined,
                    BEARER_JWT,
                    TEAM_ID,
                );

                expect(result.valid).toBe(false);
            });

            it('includes user email in response', async () => {
                mockTeamService.findById.mockResolvedValue(makeTeamEntity());

                const result = await runValidate(
                    undefined,
                    BEARER_JWT,
                    TEAM_ID,
                );

                expect(result.email).toBe(USER_EMAIL);
                expect(result.user.email).toBe(USER_EMAIL);
            });
        });

        describe('No auth', () => {
            it('returns valid=false when no auth is provided', async () => {
                const result = await runValidate(
                    undefined,
                    undefined,
                    undefined,
                );

                expect(result.valid).toBe(false);
                expect(result.error).toMatch(/authentication required/i);
            });
        });
    });

    // =========================================================================
    // GET /cli/validate-key
    // =========================================================================

    describe('GET /cli/validate-key', () => {
        describe('Team key auth', () => {
            it('returns 200 with valid=true for valid team key', async () => {
                mockTeamCliKeyService.validateKey.mockResolvedValue(
                    TEAM_KEY_DATA,
                );
                const res = makeRes();

                await controller.validateKey(
                    TEAM_KEY,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    res,
                );

                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.json).toHaveBeenCalledWith(
                    expect.objectContaining({
                        valid: true,
                        teamId: TEAM_ID,
                        organizationId: ORG_ID,
                    }),
                );
            });

            it('returns 401 with valid=false for invalid team key', async () => {
                mockTeamCliKeyService.validateKey.mockResolvedValue(null);
                const res = makeRes();

                await controller.validateKey(
                    'kodus_bad',
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    res,
                );

                expect(res.status).toHaveBeenCalledWith(401);
                expect(res.json).toHaveBeenCalledWith(
                    expect.objectContaining({ valid: false }),
                );
            });
        });

        describe('JWT auth', () => {
            it('returns 200 with valid=true for valid JWT', async () => {
                mockTeamService.findById.mockResolvedValue(makeTeamEntity());
                const res = makeRes();

                await controller.validateKey(
                    undefined,
                    BEARER_JWT,
                    TEAM_ID,
                    undefined,
                    undefined,
                    undefined,
                    res,
                );

                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.json).toHaveBeenCalledWith(
                    expect.objectContaining({
                        valid: true,
                        teamId: TEAM_ID,
                        organizationId: ORG_ID,
                        email: USER_EMAIL,
                    }),
                );
            });

            it('returns 401 for invalid JWT', async () => {
                mockJwtService.verify.mockImplementation(() => {
                    throw new Error('jwt malformed');
                });
                const res = makeRes();

                await controller.validateKey(
                    undefined,
                    BEARER_JWT,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    res,
                );

                expect(res.status).toHaveBeenCalledWith(401);
                expect(res.json).toHaveBeenCalledWith(
                    expect.objectContaining({ valid: false }),
                );
            });
        });

        describe('No auth', () => {
            it('returns 401 when no auth is provided', async () => {
                const res = makeRes();

                await controller.validateKey(
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    res,
                );

                expect(res.status).toHaveBeenCalledWith(401);
                expect(res.json).toHaveBeenCalledWith(
                    expect.objectContaining({ valid: false }),
                );
            });
        });

        describe('Device tracking', () => {
            it('sets x-kodus-device-token header when new device is registered', async () => {
                mockTeamCliKeyService.validateKey.mockResolvedValue(
                    TEAM_KEY_DATA,
                );
                mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue(
                    { deviceToken: 'new-raw-token' },
                );
                const res = makeRes();

                await controller.validateKey(
                    TEAM_KEY,
                    undefined,
                    undefined,
                    DEVICE_ID,
                    undefined,
                    'Kodus-CLI/1.0',
                    res,
                );

                expect(res.setHeader).toHaveBeenCalledWith(
                    'x-kodus-device-token',
                    'new-raw-token',
                );
                expect(res.json).toHaveBeenCalledWith(
                    expect.objectContaining({ deviceToken: 'new-raw-token' }),
                );
            });

            it('does not set header when device has valid token', async () => {
                mockTeamCliKeyService.validateKey.mockResolvedValue(
                    TEAM_KEY_DATA,
                );
                mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue(
                    {},
                );
                const res = makeRes();

                await controller.validateKey(
                    TEAM_KEY,
                    undefined,
                    undefined,
                    DEVICE_ID,
                    DEVICE_TOKEN,
                    'Kodus-CLI/1.0',
                    res,
                );

                expect(res.setHeader).not.toHaveBeenCalled();
            });

            it('skips device tracking when no x-kodus-device-id', async () => {
                mockTeamCliKeyService.validateKey.mockResolvedValue(
                    TEAM_KEY_DATA,
                );
                const res = makeRes();

                await controller.validateKey(
                    TEAM_KEY,
                    undefined,
                    undefined,
                    undefined, // no device id
                    undefined,
                    undefined,
                    res,
                );

                expect(
                    mockCliDeviceService.validateOrRegisterDevice,
                ).not.toHaveBeenCalled();
            });

            it('returns error json with code when device limit is reached', async () => {
                mockTeamCliKeyService.validateKey.mockResolvedValue(
                    TEAM_KEY_DATA,
                );
                mockCliDeviceService.validateOrRegisterDevice.mockRejectedValue(
                    new UnauthorizedException({
                        message: 'Device limit reached',
                        code: 'DEVICE_LIMIT_REACHED',
                        details: { limit: 2, current: 2 },
                    }),
                );
                const res = makeRes();

                await controller.validateKey(
                    TEAM_KEY,
                    undefined,
                    undefined,
                    DEVICE_ID,
                    undefined,
                    'Kodus-CLI/1.0',
                    res,
                );

                expect(res.status).toHaveBeenCalledWith(401);
                expect(res.json).toHaveBeenCalledWith(
                    expect.objectContaining({
                        valid: false,
                        code: 'DEVICE_LIMIT_REACHED',
                        details: { limit: 2, current: 2 },
                    }),
                );
            });
        });
    });

    // =========================================================================
    // POST /cli/validate-key (mirrors GET)
    // =========================================================================

    describe('POST /cli/validate-key', () => {
        it('returns 200 with valid team key', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);
            const res = makeRes();

            await controller.validateKeyPost(
                TEAM_KEY,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                res,
            );

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ valid: true }),
            );
        });

        it('returns 200 with valid JWT', async () => {
            mockTeamService.findById.mockResolvedValue(makeTeamEntity());
            const res = makeRes();

            await controller.validateKeyPost(
                undefined,
                BEARER_JWT,
                TEAM_ID,
                undefined,
                undefined,
                undefined,
                res,
            );

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ valid: true }),
            );
        });

        it('sets x-kodus-device-token header for new device', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({
                deviceToken: 'post-token',
            });
            const res = makeRes();

            await controller.validateKeyPost(
                TEAM_KEY,
                undefined,
                undefined,
                DEVICE_ID,
                undefined,
                'Kodus-CLI/1.0',
                res,
            );

            expect(res.setHeader).toHaveBeenCalledWith(
                'x-kodus-device-token',
                'post-token',
            );
        });
    });

    // =========================================================================
    // Device tracking – POST /cli/review (response header + body)
    // =========================================================================

    describe('Device tracking – POST /cli/review', () => {
        beforeEach(() => {
            mockTeamService.findById.mockResolvedValue(makeTeamEntity());
        });

        it('new device receives token in body and response header', async () => {
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({
                deviceToken: 'new-raw-token',
            });
            const res = makePassthroughRes();

            const result = await controller.review(
                MINIMAL_BODY,
                undefined,
                BEARER_JWT,
                TEAM_ID,
                DEVICE_ID,
                undefined,
                'Kodus-CLI/1.0',
                undefined, // asyncHeader
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
                'new-raw-token',
            );
            expect(result).toEqual(
                expect.objectContaining({ deviceToken: 'new-raw-token' }),
            );
        });

        it('existing device with valid token: no header, no token in body', async () => {
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({});
            const res = makePassthroughRes();

            const result = await controller.review(
                MINIMAL_BODY,
                undefined,
                BEARER_JWT,
                TEAM_ID,
                DEVICE_ID,
                DEVICE_TOKEN,
                'Kodus-CLI/1.0',
                undefined, // asyncHeader
                res,
            );

            expect(res.setHeader).not.toHaveBeenCalled();
            expect(result).not.toHaveProperty('deviceToken');
        });

        it('invalid token triggers self-healing: reissues token in header + body', async () => {
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({
                deviceToken: 'reissued-token',
            });
            const res = makePassthroughRes();

            const result = await controller.review(
                MINIMAL_BODY,
                undefined,
                BEARER_JWT,
                TEAM_ID,
                DEVICE_ID,
                'wrong-token',
                'Kodus-CLI/1.0',
                undefined, // asyncHeader
                res,
            );

            expect(res.setHeader).toHaveBeenCalledWith(
                'x-kodus-device-token',
                'reissued-token',
            );
            expect(result).toEqual(
                expect.objectContaining({ deviceToken: 'reissued-token' }),
            );
        });

        it('no x-kodus-device-id header skips device tracking', async () => {
            const result = await controller.review(
                MINIMAL_BODY,
                undefined,
                BEARER_JWT,
                TEAM_ID,
                undefined,
                undefined,
                undefined,
            );

            expect(
                mockCliDeviceService.validateOrRegisterDevice,
            ).not.toHaveBeenCalled();
            expect(result).toEqual({ suggestions: [] });
        });

        it('device limit reached throws 401 with DEVICE_LIMIT_REACHED code', async () => {
            mockCliDeviceService.validateOrRegisterDevice.mockRejectedValue(
                new UnauthorizedException({
                    message:
                        'Device limit reached (2). Remove an existing device or increase the limit.',
                    code: 'DEVICE_LIMIT_REACHED',
                    details: { limit: 2, current: 2 },
                }),
            );

            try {
                await controller.review(
                    MINIMAL_BODY,
                    undefined,
                    BEARER_JWT,
                    TEAM_ID,
                    DEVICE_ID,
                    undefined,
                    'Kodus-CLI/1.0',
                );
                fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(UnauthorizedException);
                const response = error.getResponse();
                expect(response.code).toBe('DEVICE_LIMIT_REACHED');
                expect(response.details).toEqual({ limit: 2, current: 2 });
            }
        });

        it('device tracking works with team key auth too', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({
                deviceToken: 'team-key-device-token',
            });
            const res = makePassthroughRes();

            const result = await controller.review(
                MINIMAL_BODY,
                TEAM_KEY,
                undefined,
                undefined,
                DEVICE_ID,
                undefined,
                'Kodus-CLI/1.0',
                undefined, // asyncHeader
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
                'team-key-device-token',
            );
            expect(result).toEqual(
                expect.objectContaining({
                    deviceToken: 'team-key-device-token',
                }),
            );
        });
    });

    // =========================================================================
    // POST /cli/review – Email domain validation
    // =========================================================================

    describe('POST /cli/review – Email domain validation', () => {
        it('allows review when userEmail matches allowed domain', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue({
                ...TEAM_KEY_DATA,
                team: {
                    ...TEAM_KEY_DATA.team,
                    cliConfig: { allowedDomains: ['@kodus.io'] },
                },
            });

            const body: CliReviewRequestDto = {
                ...MINIMAL_BODY,
                userEmail: 'dev@kodus.io',
            };

            const result = await controller.review(body, TEAM_KEY);

            expect(mockEnqueueCliReview.execute).toHaveBeenCalled();
            expect(result).toEqual({ suggestions: [] });
        });

        it('throws 403 when userEmail does not match allowed domains', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue({
                ...TEAM_KEY_DATA,
                team: {
                    ...TEAM_KEY_DATA.team,
                    cliConfig: { allowedDomains: ['@kodus.io'] },
                },
            });

            const body: CliReviewRequestDto = {
                ...MINIMAL_BODY,
                userEmail: 'hacker@evil.com',
            };

            await expect(controller.review(body, TEAM_KEY)).rejects.toThrow(
                ForbiddenException,
            );
        });

        it('allows any email when allowedDomains is empty', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue({
                ...TEAM_KEY_DATA,
                team: {
                    ...TEAM_KEY_DATA.team,
                    cliConfig: { allowedDomains: [] },
                },
            });

            const body: CliReviewRequestDto = {
                ...MINIMAL_BODY,
                userEmail: 'anyone@anywhere.com',
            };

            const result = await controller.review(body, TEAM_KEY);

            expect(mockEnqueueCliReview.execute).toHaveBeenCalled();
            expect(result).toEqual({ suggestions: [] });
        });

        it('allows review when no userEmail is provided', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue({
                ...TEAM_KEY_DATA,
                team: {
                    ...TEAM_KEY_DATA.team,
                    cliConfig: { allowedDomains: ['@kodus.io'] },
                },
            });

            const result = await controller.review(MINIMAL_BODY, TEAM_KEY);

            expect(mockEnqueueCliReview.execute).toHaveBeenCalled();
            expect(result).toEqual({ suggestions: [] });
        });
    });

    // =========================================================================
    // POST /cli/review – Rate limiting with Team key auth
    // =========================================================================

    describe('POST /cli/review – Rate limiting with team key', () => {
        it('throws 429 when rate limit is exceeded with team key auth', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);
            mockRateLimiter.checkRateLimit.mockResolvedValue({
                allowed: false,
                remaining: 0,
                resetAt: new Date('2026-01-01T00:00:00Z'),
            });

            await expect(
                controller.review(MINIMAL_BODY, TEAM_KEY),
            ).rejects.toThrow(HttpException);

            try {
                await controller.review(MINIMAL_BODY, TEAM_KEY);
            } catch (error) {
                expect(error.getStatus()).toBe(429);
                const response = error.getResponse();
                expect(response.remaining).toBe(0);
                expect(response.resetAt).toBeDefined();
            }
        });

        it('passes rate limit check with the correct team uuid', async () => {
            mockTeamCliKeyService.validateKey.mockResolvedValue(TEAM_KEY_DATA);

            await controller.review(MINIMAL_BODY, TEAM_KEY);

            expect(mockRateLimiter.checkRateLimit).toHaveBeenCalledWith(
                TEAM_ID,
            );
        });
    });

    // =========================================================================
    // POST /cli/trial/review
    // =========================================================================

    describe('POST /cli/trial/review', () => {
        const TRIAL_BODY = {
            diff: 'diff --git a/x b/x\n+const x = 1;',
            fingerprint: 'fp-abc-123',
        };

        it('executes trial review and returns result with rate limit info', async () => {
            mockTrialRateLimiter.checkRateLimit.mockResolvedValue({
                allowed: true,
                remaining: 1,
                resetAt: new Date('2026-01-01T00:00:00Z'),
            });
            mockExecuteCliReview.execute.mockResolvedValue({
                suggestions: [{ id: 1 }],
            });

            const result = await controller.trialReview(TRIAL_BODY);

            expect(mockTrialRateLimiter.checkRateLimit).toHaveBeenCalledWith(
                'fp-abc-123',
            );
            expect(mockExecuteCliReview.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    organizationAndTeamData: {
                        organizationId: 'trial',
                        teamId: 'trial',
                    },
                    isTrialMode: true,
                }),
            );
            expect(result).toHaveProperty('suggestions');
            expect(result).toHaveProperty('rateLimit');
            expect(result.rateLimit.remaining).toBe(1);
            expect(result.rateLimit.limit).toBe(2);
        });

        it('throws 400 when fingerprint is missing', async () => {
            await expect(
                controller.trialReview({ diff: 'something' } as any),
            ).rejects.toThrow(HttpException);

            try {
                await controller.trialReview({ diff: 'x' } as any);
            } catch (error) {
                expect(error.getStatus()).toBe(400);
            }
        });

        it('throws 429 when trial rate limit is exceeded', async () => {
            mockTrialRateLimiter.checkRateLimit.mockResolvedValue({
                allowed: false,
                remaining: 0,
                resetAt: new Date('2026-01-01T00:00:00Z'),
            });

            await expect(controller.trialReview(TRIAL_BODY)).rejects.toThrow(
                HttpException,
            );

            try {
                await controller.trialReview(TRIAL_BODY);
            } catch (error) {
                expect(error.getStatus()).toBe(429);
                const response = error.getResponse();
                expect(response.remaining).toBe(0);
                expect(response.limit).toBe(2);
            }
        });

        it('passes diff and config to execute use case', async () => {
            mockTrialRateLimiter.checkRateLimit.mockResolvedValue({
                allowed: true,
                remaining: 1,
            });

            const body = {
                diff: 'my diff',
                fingerprint: 'fp-1',
                config: { language: 'typescript' },
            };

            await controller.trialReview(body as any);

            expect(mockExecuteCliReview.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    input: {
                        diff: 'my diff',
                        config: { language: 'typescript' },
                    },
                }),
            );
        });
    });

    // =========================================================================
    // GET /cli/trial/status
    // =========================================================================

    describe('GET /cli/trial/status', () => {
        it('returns trial status without incrementing counter', async () => {
            mockTrialRateLimiter.getRateLimitStatus.mockResolvedValue({
                allowed: true,
                remaining: 2,
                resetAt: new Date('2026-02-20T01:00:00Z'),
            });

            const result = await controller.trialStatus('fp-abc-123');

            expect(
                mockTrialRateLimiter.getRateLimitStatus,
            ).toHaveBeenCalledWith('fp-abc-123');
            expect(mockTrialRateLimiter.checkRateLimit).not.toHaveBeenCalled();
            expect(result).toEqual({
                fingerprint: 'fp-abc-123',
                reviewsUsed: 0,
                reviewsLimit: 2,
                filesLimit: 10,
                linesLimit: 500,
                resetsAt: '2026-02-20T01:00:00.000Z',
                isLimited: false,
            });
        });

        it('returns isLimited=true when limit is reached', async () => {
            mockTrialRateLimiter.getRateLimitStatus.mockResolvedValue({
                allowed: false,
                remaining: 0,
                resetAt: new Date('2026-02-20T01:00:00Z'),
            });

            const result = await controller.trialStatus('fp-abc-123');

            expect(result.isLimited).toBe(true);
            expect(result.reviewsUsed).toBe(2);
            expect(result.remaining).toBeUndefined();
        });

        it('throws 400 when fingerprint is missing', async () => {
            await expect(controller.trialStatus(undefined)).rejects.toThrow(
                HttpException,
            );

            try {
                await controller.trialStatus(undefined);
            } catch (error) {
                expect(error.getStatus()).toBe(400);
            }
        });

        it('returns fallback resetsAt when no resetAt from limiter', async () => {
            mockTrialRateLimiter.getRateLimitStatus.mockResolvedValue({
                allowed: true,
                remaining: 2,
                resetAt: undefined,
            });

            const result = await controller.trialStatus('fp-abc-123');

            expect(result.resetsAt).toBeDefined();
            // Should be roughly 1 hour from now
            const resetDate = new Date(result.resetsAt);
            expect(resetDate.getTime()).toBeGreaterThan(Date.now());
        });
    });

    // =========================================================================
    // POST /cli/public/review-pr  (anonymous public-demo enqueue)
    // =========================================================================

    describe('POST /cli/public/review-pr', () => {
        const PUBLIC_BODY = {
            prUrl: 'https://github.com/trpc/trpc/pull/7280',
            fingerprint: 'fp-public-1',
        } as any;

        it('returns 202 with the enqueue response on success', async () => {
            const res = { status: jest.fn() };
            mockPublicPrReview.execute.mockResolvedValue({
                ok: true,
                response: {
                    jobId: 'job-pub-1',
                    status: 'PENDING',
                    statusUrl: '/cli/public/review/jobs/job-pub-1',
                    pr: { owner: 'trpc', repo: 'trpc', prNumber: 7280 },
                    diff: 'diff --git a/x b/x',
                },
            });

            const result = await controller.publicPrReview(PUBLIC_BODY, res);

            expect(mockPublicPrReview.execute).toHaveBeenCalledWith({
                prUrl: PUBLIC_BODY.prUrl,
                fingerprint: PUBLIC_BODY.fingerprint,
            });
            expect(res.status).toHaveBeenCalledWith(202);
            expect(result).toHaveProperty('jobId', 'job-pub-1');
            expect(result).toHaveProperty('diff');
        });

        it('throws 400 when fingerprint is missing', async () => {
            await expect(
                controller.publicPrReview({ prUrl: 'x' } as any),
            ).rejects.toThrow(HttpException);
            expect(mockPublicPrReview.execute).not.toHaveBeenCalled();
        });

        it('throws a typed 400 (e.g. too_large) carrying code + message', async () => {
            mockPublicPrReview.execute.mockResolvedValue({
                ok: false,
                code: 'too_large',
                message: 'PR exceeds the free-demo cap',
                statusCode: 400,
            });

            try {
                await controller.publicPrReview(PUBLIC_BODY, { status: jest.fn() });
                throw new Error('expected publicPrReview to throw');
            } catch (error) {
                expect(error).toBeInstanceOf(HttpException);
                expect(error.getStatus()).toBe(400);
                const response = error.getResponse();
                expect(response.code).toBe('too_large');
                expect(response.message).toContain('cap');
            }
        });

        it('throws 429 with remaining/resetAt/limit when rate-limited', async () => {
            mockPublicPrReview.execute.mockResolvedValue({
                ok: false,
                code: 'rate_limited',
                message: "You've used your free reviews",
                statusCode: 429,
                rateLimit: {
                    remaining: 0,
                    resetAt: '2026-01-01T00:00:00.000Z',
                    limit: 2,
                },
            });

            try {
                await controller.publicPrReview(PUBLIC_BODY, { status: jest.fn() });
                throw new Error('expected publicPrReview to throw');
            } catch (error) {
                expect(error).toBeInstanceOf(HttpException);
                expect(error.getStatus()).toBe(429);
                const response = error.getResponse();
                expect(response.remaining).toBe(0);
                expect(response.resetAt).toBe('2026-01-01T00:00:00.000Z');
                expect(response.limit).toBe(2);
            }
        });
    });

    // =========================================================================
    // GET /cli/public/review/jobs/:jobId  (anonymous poll, scoped to 'trial')
    // =========================================================================

    describe('GET /cli/public/review/jobs/:jobId', () => {
        it("scopes the lookup to the 'trial' org and forwards omit=payload", async () => {
            mockGetCliReviewJobStatus.execute.mockResolvedValue({
                jobId: 'job-pub-1',
                status: 'COMPLETED',
            });

            await controller.getPublicReviewJob('job-pub-1', 'payload');

            expect(mockGetCliReviewJobStatus.execute).toHaveBeenCalledWith({
                jobId: 'job-pub-1',
                organizationId: 'trial',
                omitPayload: true,
            });
        });

        it('does not omit payload on the first poll', async () => {
            mockGetCliReviewJobStatus.execute.mockResolvedValue({
                jobId: 'job-pub-1',
                status: 'PENDING',
            });

            await controller.getPublicReviewJob('job-pub-1', undefined);

            expect(mockGetCliReviewJobStatus.execute).toHaveBeenCalledWith(
                expect.objectContaining({ omitPayload: false }),
            );
        });
    });

    // =========================================================================
    // GET /cli/public/featured-reviews  (cached marketing grid)
    // =========================================================================

    describe('GET /cli/public/featured-reviews', () => {
        it('returns the { items } envelope from the use case', async () => {
            const items = [
                { slug: 'react-fizz-resume-abort', issuesCount: 3 },
                { slug: 'trpc-error-handling-vm', issuesCount: 1 },
            ];
            mockListFeaturedReviews.execute.mockResolvedValue({ items });

            const result = await controller.listFeaturedReviews();

            expect(result).toEqual({ items });
        });
    });

    // =========================================================================
    // GET /cli/public/featured-reviews/:slug  (cached snapshot)
    // =========================================================================

    describe('GET /cli/public/featured-reviews/:slug', () => {
        it('returns the snapshot for a known slug', async () => {
            const review = {
                slug: 'react-fizz-resume-abort',
                pr: { prNumber: 36584 },
                diff: 'diff --git a/x b/x',
                result: { issues: [{ file: 'x', line: 1 }] },
            };
            mockGetFeaturedReview.execute.mockResolvedValue(review);

            const result = await controller.getFeaturedReview(
                'react-fizz-resume-abort',
            );

            expect(mockGetFeaturedReview.execute).toHaveBeenCalledWith({
                slug: 'react-fizz-resume-abort',
            });
            expect(result).toBe(review);
        });

        it('throws 404 when the slug is unknown / unpublished', async () => {
            mockGetFeaturedReview.execute.mockResolvedValue(null);

            await expect(
                controller.getFeaturedReview('does-not-exist'),
            ).rejects.toThrow(NotFoundException);
        });
    });
});
