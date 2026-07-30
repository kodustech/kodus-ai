import { EnqueueCliReviewUseCase } from '@libs/cli-review/application/use-cases/enqueue-cli-review.use-case';
import { ExecuteCliReviewUseCase } from '@libs/cli-review/application/use-cases/execute-cli-review.use-case';
import { PublicPrReviewUseCase } from '@libs/cli-review/application/use-cases/public-pr-review.use-case';
import { GetCliReviewJobStatusUseCase } from '@libs/cli-review/application/use-cases/get-cli-review-job-status.use-case';
import { IngestSessionEventUseCase } from '@libs/cli-review/application/use-cases/ingest-session-event.use-case';
import { SubmitCliSessionCaptureUseCase } from '@libs/cli-review/application/use-cases/submit-cli-session-capture.use-case';
import { WaitForCliReviewJobUseCase } from '@libs/cli-review/application/use-cases/wait-for-cli-review-job.use-case';
import { ListFeaturedPublicReviewsUseCase } from '@libs/cli-review/application/use-cases/list-featured-public-reviews.use-case';
import { GetFeaturedPublicReviewUseCase } from '@libs/cli-review/application/use-cases/get-featured-public-review.use-case';
import { ValidateCliKeyUseCase } from '@libs/cli-review/application/use-cases/validate-cli-key.use-case';
import {
    ITrialRateLimiterService,
    TRIAL_RATE_LIMITER_SERVICE_TOKEN,
} from '@libs/cli-review/domain/contracts/trial-rate-limiter.service.contract';
import {
    IAuthenticatedRateLimiterService,
    AUTHENTICATED_RATE_LIMITER_SERVICE_TOKEN,
} from '@libs/cli-review/domain/contracts/authenticated-rate-limiter.service.contract';
import {
    IGitHubPublicPrService,
    GITHUB_PUBLIC_PR_SERVICE_TOKEN,
} from '@libs/cli-review/domain/contracts/github-public-pr.service.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    HttpException,
    HttpStatus,
    Inject,
    NotFoundException,
    Param,
    Post,
    Query,
    Req,
    Res,
    UnauthorizedException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JWT } from '@libs/core/infrastructure/config/types/jwt/jwt';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import { TriggerBusinessValidationUseCase } from '@libs/platform/application/use-cases/codeManagement/trigger-business-validation.use-case';
import {
    ApiBadRequestResponse,
    ApiCreatedResponse,
    ApiHeader,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
    ApiTooManyRequestsResponse,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
    CLI_DEVICE_SERVICE_TOKEN,
    ICliDeviceService,
} from '@libs/organization/domain/cli-device/contracts/cli-device.service.contract';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import { ApiErrorDto } from '../../dtos/api-error.dto';
import {
    CliBusinessValidationRequestDto,
    CliReviewRequestDto,
    PublicPrReviewRequestDto,
    TrialCliReviewRequestDto,
} from '../../dtos/cli-review.dto';
import { CliSessionCaptureRequestDto } from '../../dtos/cli-session-capture.dto';
import { CliSessionCaptureResponseDto } from '../../dtos/cli-session-capture.response.dto';
import { SessionEventRequestDto } from '../../dtos/session-event.dto';
import {
    CliBusinessValidationResponseDto,
    CliReviewRateLimitErrorDto,
    CliReviewResponseDto,
    CliValidateKeyResponseDto,
    TrialCliReviewResponseDto,
} from '../../dtos/cli-review.response.dto';

/**
 * Controller for CLI code review endpoints
 * Provides both authenticated and trial review capabilities
 */
@ApiTags('CLI Review')
@ApiStandardResponses()
@Public()
@Controller('cli')
export class CliReviewController {
    private readonly jwtConfig: JWT;

    constructor(
        private readonly executeCliReviewUseCase: ExecuteCliReviewUseCase,
        private readonly enqueueCliReviewUseCase: EnqueueCliReviewUseCase,
        private readonly getCliReviewJobStatusUseCase: GetCliReviewJobStatusUseCase,
        private readonly waitForCliReviewJobUseCase: WaitForCliReviewJobUseCase,
        private readonly ingestSessionEventUseCase: IngestSessionEventUseCase,
        private readonly submitCliSessionCaptureUseCase: SubmitCliSessionCaptureUseCase,
        @Inject(TRIAL_RATE_LIMITER_SERVICE_TOKEN)
        private readonly trialRateLimiter: ITrialRateLimiterService,
        @Inject(AUTHENTICATED_RATE_LIMITER_SERVICE_TOKEN)
        private readonly authenticatedRateLimiter: IAuthenticatedRateLimiterService,
        @Inject(GITHUB_PUBLIC_PR_SERVICE_TOKEN)
        private readonly githubPublicPrService: IGitHubPublicPrService,
        private readonly publicPrReviewUseCase: PublicPrReviewUseCase,
        private readonly listFeaturedPublicReviewsUseCase: ListFeaturedPublicReviewsUseCase,
        private readonly getFeaturedPublicReviewUseCase: GetFeaturedPublicReviewUseCase,
        private readonly validateCliKeyUseCase: ValidateCliKeyUseCase,
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamCliKeyService: ITeamCliKeyService,
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        @Inject(CLI_DEVICE_SERVICE_TOKEN)
        private readonly cliDeviceService: ICliDeviceService,
        private readonly triggerBusinessValidationUseCase: TriggerBusinessValidationUseCase,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
    ) {
        this.jwtConfig = this.configService.get<JWT>('jwtConfig');
    }

    /**
     * Validate a Team CLI key (health check for CLI)
     */
    @Get('validate-key')
    @ApiOperation({
        summary: 'Validate team CLI key',
        description:
            'Validates a Team CLI key sent via `x-team-key` or `Authorization: Bearer <team-key>`.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiOkResponse({ type: CliValidateKeyResponseDto })
    @ApiUnauthorizedResponse({
        description: 'Invalid or missing team CLI key',
        type: CliValidateKeyResponseDto,
    })
    @ApiHeader({
        name: 'x-kodus-device-id',
        required: false,
        description: 'Unique device identifier for device tracking',
    })
    @ApiHeader({
        name: 'x-kodus-device-token',
        required: false,
        description: 'Device token returned on first registration',
    })
    async validateKey(
        @Headers('x-team-key') teamKey: string,
        @Headers('authorization') authHeader: string,
        @Query('teamId') queryTeamId: string,
        @Headers('x-kodus-device-id') deviceId: string,
        @Headers('x-kodus-device-token') deviceToken: string,
        @Headers('user-agent') userAgent: string,
        @Res() res,
    ) {
        const payload = await this.validateCliKeyUseCase.execute({
            teamKey,
            authHeader,
            queryTeamId,
            deviceId,
            deviceToken,
            userAgent,
        });
        if (payload.deviceToken) {
            res.setHeader('x-kodus-device-token', payload.deviceToken);
        }
        return res.status(payload.valid ? 200 : 401).json(payload);
    }

    /**
     * POST alias for clients that send POST
     */
    @Post('validate-key')
    @ApiOperation({
        summary: 'Validate team CLI key (POST)',
        description:
            'POST alias for validate-key. Accepts `x-team-key` or `Authorization: Bearer <team-key>`.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiOkResponse({ type: CliValidateKeyResponseDto })
    @ApiUnauthorizedResponse({
        description: 'Invalid or missing team CLI key',
        type: CliValidateKeyResponseDto,
    })
    @ApiHeader({
        name: 'x-kodus-device-id',
        required: false,
        description: 'Unique device identifier for device tracking',
    })
    @ApiHeader({
        name: 'x-kodus-device-token',
        required: false,
        description: 'Device token returned on first registration',
    })
    async validateKeyPost(
        @Headers('x-team-key') teamKey: string,
        @Headers('authorization') authHeader: string,
        @Query('teamId') queryTeamId: string,
        @Headers('x-kodus-device-id') deviceId: string,
        @Headers('x-kodus-device-token') deviceToken: string,
        @Headers('user-agent') userAgent: string,
        @Res() res,
    ) {
        const payload = await this.validateCliKeyUseCase.execute({
            teamKey,
            authHeader,
            queryTeamId,
            deviceId,
            deviceToken,
            userAgent,
        });
        if (payload.deviceToken) {
            res.setHeader('x-kodus-device-token', payload.deviceToken);
        }
        return res.status(payload.valid ? 200 : 401).json(payload);
    }

    @Post('business-validation')
    @ApiOperation({
        summary: 'Trigger business validation',
        description:
            'Executes business rules validation directly through the business validation provider using pull request context or local diff context.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiCreatedResponse({ type: CliBusinessValidationResponseDto })
    @ApiBadRequestResponse({
        description: 'Invalid input or PR/repository not found',
        type: ApiErrorDto,
    })
    @ApiUnauthorizedResponse({
        description: 'Invalid or missing authentication',
        type: ApiErrorDto,
    })
    @ApiTooManyRequestsResponse({
        description: 'Rate limit exceeded',
        type: CliReviewRateLimitErrorDto,
    })
    async businessValidation(
        @Body() body: CliBusinessValidationRequestDto,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Query('teamId') queryTeamId?: string,
    ) {
        const auth = await this.validateCliKeyUseCase.execute({
            teamKey,
            authHeader,
            queryTeamId,
        });

        if (!auth.valid || !auth.organizationId || !auth.teamId) {
            throw new UnauthorizedException(
                auth.error ||
                    'Authentication required. Provide a team API key via X-Team-Key header, or a JWT via Authorization: Bearer header.',
            );
        }

        const rateLimitResult =
            await this.authenticatedRateLimiter.checkRateLimit(auth.teamId);

        if (!rateLimitResult.allowed) {
            throw new HttpException(
                {
                    message:
                        'Rate limit exceeded for this team. Please try again later.',
                    remaining: rateLimitResult.remaining,
                    resetAt: rateLimitResult.resetAt?.toISOString(),
                    limit: 1000,
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        return this.triggerBusinessValidationUseCase.execute({
            organizationAndTeamData: {
                organizationId: auth.organizationId,
                teamId: auth.teamId,
            },
            input: {
                prUrl: body.prUrl,
                prNumber: body.prNumber,
                repositoryId: body.repositoryId,
                repository: body.repository,
                taskUrl: body.taskUrl,
                taskId: body.taskId,
                diff: body.diff,
            },
        });
    }

    /**
     * Polls a CLI review job's status. Used by the CLI when it opted into
     * the async path via `x-kodus-async: 1`.
     */
    @Get('review/jobs/:jobId')
    @ApiOperation({
        summary: 'Get CLI review job status',
        description:
            'Returns status, result (when COMPLETED) and error (when FAILED) for a CLI review job enqueued via POST /cli/review with `x-kodus-async: 1`.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    async getReviewJob(
        @Param('jobId') jobId: string,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Query('teamId') queryTeamId?: string,
    ) {
        // Reuse the same auth resolution path as POST /cli/review so the
        // organization the caller belongs to is the only one allowed to
        // read its own jobs.
        const { organizationAndTeamData } =
            await this.resolveOrgAndTeamForReview(
                teamKey,
                authHeader,
                queryTeamId,
            );

        return this.getCliReviewJobStatusUseCase.execute({
            jobId,
            organizationId: organizationAndTeamData.organizationId,
        });
    }

    /**
     * Shared auth resolution (Team CLI key or JWT) used by both POST /cli/review
     * and GET /cli/review/jobs/:jobId. Mirrors the inline logic in `review()`
     * minus device tracking / rate limiting (those only apply to enqueue).
     */
    private async resolveOrgAndTeamForReview(
        teamKey?: string,
        authHeader?: string,
        queryTeamId?: string,
    ): Promise<{
        organizationAndTeamData: { organizationId: string; teamId: string };
    }> {
        const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');

        if (teamKey || bearerToken?.startsWith('kodus_')) {
            const key = teamKey || bearerToken;
            if (!key) {
                throw new UnauthorizedException(
                    'Team API key required. Provide via X-Team-Key header or Authorization: Bearer header.',
                );
            }
            const teamData = await this.teamCliKeyService.validateKey(key);
            if (!teamData?.team?.uuid || !teamData?.organization?.uuid) {
                throw new UnauthorizedException(
                    'Invalid or revoked team API key',
                );
            }
            return {
                organizationAndTeamData: {
                    organizationId: teamData.organization.uuid,
                    teamId: teamData.team.uuid,
                },
            };
        }

        if (bearerToken) {
            let payload: any;
            try {
                payload = this.jwtService.verify(bearerToken, {
                    secret: this.jwtConfig.secret,
                });
            } catch {
                throw new UnauthorizedException('Invalid or expired JWT token');
            }
            const team = queryTeamId
                ? await this.teamService.findById(queryTeamId)
                : await this.teamService.findFirstCreatedTeam(
                      payload.organizationId,
                  );
            if (!team) {
                throw new UnauthorizedException(
                    'No active team found for the authenticated user',
                );
            }
            return {
                organizationAndTeamData: {
                    organizationId: payload.organizationId,
                    teamId: team.uuid,
                },
            };
        }

        throw new UnauthorizedException(
            'Authentication required. Provide a team API key via X-Team-Key header, or a JWT via Authorization: Bearer header.',
        );
    }

    /**
     * CLI code review endpoint with Team API Key authentication
     * No user authentication required - uses team key instead
     */
    @Post('review')
    @ApiOperation({
        summary: 'Run CLI code review',
        description:
            'Runs a code review using a Team CLI key passed via `x-team-key` or `Authorization: Bearer <team-key>`.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiOkResponse({ type: CliReviewResponseDto })
    @ApiTooManyRequestsResponse({
        description: 'Rate limit exceeded',
        type: CliReviewRateLimitErrorDto,
    })
    @ApiUnauthorizedResponse({
        description: 'Device limit reached',
    })
    @ApiHeader({
        name: 'x-kodus-device-id',
        required: false,
        description: 'Unique device identifier for device tracking',
    })
    @ApiHeader({
        name: 'x-kodus-device-token',
        required: false,
        description: 'Device token returned on first registration',
    })
    async review(
        @Body() body: CliReviewRequestDto,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Query('teamId') queryTeamId?: string,
        @Headers('x-kodus-device-id') deviceId?: string,
        @Headers('x-kodus-device-token') deviceToken?: string,
        @Headers('user-agent') userAgent?: string,
        @Headers('x-kodus-async') asyncHeader?: string,
        @Res({ passthrough: true }) res?: any,
    ) {
        const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');

        let organizationAndTeamData: {
            organizationId: string;
            teamId: string;
        };
        let teamForRateLimit: { uuid: string; cliConfig?: any };
        // Provenance of the auth method that succeeded — propagated to the
        // pipeline so the dashboard can show "Team: <name>" or "Personal"
        // without ever holding onto the secret.
        let cliAuth: {
            mode: 'team-key' | 'personal';
            teamKeyId?: string;
            teamKeyName?: string;
            userId?: string;
            userEmail?: string;
        };

        // Route 1: Team CLI key (via X-Team-Key header or Bearer with kodus_ prefix)
        if (teamKey || bearerToken?.startsWith('kodus_')) {
            const key = teamKey || bearerToken;

            if (!key) {
                throw new UnauthorizedException(
                    'Team API key required. Provide via X-Team-Key header or Authorization: Bearer header.',
                );
            }

            const teamData = await this.teamCliKeyService.validateKey(key);

            if (!teamData) {
                throw new UnauthorizedException(
                    'Invalid or revoked team API key',
                );
            }

            const { team, organization, keyId, keyName } = teamData;

            if (!team?.uuid || !organization?.uuid) {
                throw new UnauthorizedException(
                    'Invalid or incomplete team API key',
                );
            }

            organizationAndTeamData = {
                organizationId: organization.uuid,
                teamId: team.uuid,
            };
            teamForRateLimit = {
                uuid: team.uuid,
                cliConfig: team.cliConfig,
            };
            cliAuth = {
                mode: 'team-key',
                teamKeyId: keyId,
                teamKeyName: keyName,
            };
        }
        // Route 2: JWT Bearer token
        else if (bearerToken) {
            let payload: any;
            try {
                payload = this.jwtService.verify(bearerToken, {
                    secret: this.jwtConfig.secret,
                });
            } catch {
                throw new UnauthorizedException('Invalid or expired JWT token');
            }

            const user = await this.authService.validateUser({
                email: payload.email,
            });

            if (!user) {
                throw new UnauthorizedException('User not found');
            }

            if (user.role !== payload.role) {
                throw new UnauthorizedException('User role has changed');
            }

            if (
                user.status !== payload.status ||
                user.status === STATUS.REMOVED
            ) {
                throw new UnauthorizedException(
                    'User account is inactive or removed',
                );
            }

            // Resolve team: prefer queryTeamId lookup, fall back to first team
            // for the organization (handles CLI sending organizationId as teamId)
            let team = queryTeamId
                ? await this.teamService.findById(queryTeamId)
                : null;

            // queryTeamId was explicitly provided but is not a valid team
            // and is not the orgId (CLI compat: CLI sends orgId as teamId)
            if (
                !team &&
                queryTeamId &&
                queryTeamId !== payload.organizationId
            ) {
                throw new UnauthorizedException(
                    `Team not found for the provided teamId: ${queryTeamId}`,
                );
            }

            if (!team) {
                team = await this.teamService.findFirstCreatedTeam(
                    payload.organizationId,
                );
            }

            if (!team) {
                throw new UnauthorizedException(
                    'No active team found for the authenticated user',
                );
            }

            if (team.organization?.uuid !== payload.organizationId) {
                throw new ForbiddenException(
                    'Team does not belong to the authenticated organization',
                );
            }

            organizationAndTeamData = {
                organizationId: payload.organizationId,
                teamId: team.uuid,
            };
            teamForRateLimit = {
                uuid: team.uuid,
                cliConfig: team.cliConfig,
            };
            cliAuth = {
                mode: 'personal',
                userId: user.uuid,
                userEmail: user.email,
            };
        }
        // No auth provided
        else {
            throw new UnauthorizedException(
                'Authentication required. Provide a team API key via X-Team-Key header, or a JWT via Authorization: Bearer header.',
            );
        }

        // 3. Device tracking (opt-in)
        let deviceResult: { deviceToken?: string } | undefined;
        if (deviceId) {
            deviceResult = await this.cliDeviceService.validateOrRegisterDevice(
                {
                    deviceId,
                    deviceToken,
                    organizationId: organizationAndTeamData.organizationId,
                    userAgent,
                },
            );
            if (deviceResult?.deviceToken && res) {
                res.setHeader('x-kodus-device-token', deviceResult.deviceToken);
            }
        }

        // 4. Check rate limit for authenticated team
        const rateLimitResult =
            await this.authenticatedRateLimiter.checkRateLimit(
                teamForRateLimit.uuid,
            );

        if (!rateLimitResult.allowed) {
            throw new HttpException(
                {
                    message:
                        'Rate limit exceeded for this team. Please try again later.',
                    remaining: rateLimitResult.remaining,
                    resetAt: rateLimitResult.resetAt?.toISOString(),
                    limit: 1000,
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        // 5. Validate domain of email (if configured)
        if (body.userEmail) {
            const allowedDomains =
                teamForRateLimit.cliConfig?.allowedDomains || [];

            if (allowedDomains.length > 0) {
                const isValidDomain = allowedDomains.some((domain: string) =>
                    body.userEmail.endsWith(domain),
                );

                if (!isValidDomain) {
                    throw new ForbiddenException(
                        `Email must be from allowed domains: ${allowedDomains.join(', ')}`,
                    );
                }
            }
        }

        // 6. Enqueue the review (always — runs on the worker, not the API process)
        const { jobId } = await this.enqueueCliReviewUseCase.execute({
            organizationAndTeamData,
            input: {
                diff: body.diff,
                config: body.config,
            },
            isTrialMode: false,
            userEmail: body.userEmail,
            gitContext: {
                remote: body.gitRemote,
                branch: body.branch,
                commitSha: body.commitSha,
                mergeBaseSha: body.mergeBaseSha,
                inferredPlatform: body.inferredPlatform,
                cliVersion: body.cliVersion,
            },
            cliAuth,
        });

        const wantsAsync = this.parseAsyncHeader(asyncHeader);

        // 7a. Async (new CLI): return 202 immediately so the client polls.
        if (wantsAsync) {
            if (res) {
                res.status(HttpStatus.ACCEPTED);
            }
            return {
                jobId,
                status: JobStatus.PENDING,
                statusUrl: `/cli/review/jobs/${jobId}`,
                ...(deviceResult?.deviceToken
                    ? { deviceToken: deviceResult.deviceToken }
                    : {}),
            };
        }

        // 7b. Sync (legacy CLI): wait for the worker to finish and return
        //     the same shape the old endpoint returned. The worker still
        //     does the heavy lifting; we just block the request here.
        const reviewResult = await this.waitForCliReviewJobUseCase.execute({
            jobId,
        });

        return {
            ...reviewResult,
            ...(deviceResult?.deviceToken
                ? { deviceToken: deviceResult.deviceToken }
                : {}),
        };
    }

    private parseAsyncHeader(value?: string): boolean {
        if (!value) return false;
        const normalized = value.trim().toLowerCase();
        return normalized === '1' || normalized === 'true' || normalized === 'yes';
    }

    /**
     * CLI memory capture ingestion endpoint
     * Accepts fire-and-forget capture payloads generated by coding agents
     */
    @Post('memory/captures')
    @ApiOperation({
        summary: 'Submit CLI memory capture',
        description:
            'Receives a memory capture and enqueues async classification. Accepts Team API key via `x-team-key` or JWT via `Authorization: Bearer`.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiCreatedResponse({ type: CliSessionCaptureResponseDto })
    @ApiUnauthorizedResponse({
        description: 'Invalid or missing authentication',
        type: ApiErrorDto,
    })
    @ApiBadRequestResponse({
        description: 'Invalid payload',
        type: ApiErrorDto,
    })
    async submitSessionCapture(
        @Body() body: CliSessionCaptureRequestDto,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Query('teamId') queryTeamId?: string,
        @Res({ passthrough: true }) res?: any,
    ) {
        const auth = await this.validateCliKeyUseCase.execute({
            teamKey,
            authHeader,
            queryTeamId,
        });

        if (!auth.valid || !auth.organizationId || !auth.teamId) {
            throw new UnauthorizedException(
                auth.error ||
                    'Authentication required. Provide a team API key via X-Team-Key header, or a JWT via Authorization: Bearer header.',
            );
        }

        const result = await this.submitCliSessionCaptureUseCase.execute({
            organizationAndTeamData: {
                organizationId: auth.organizationId,
                teamId: auth.teamId,
            },
            input: {
                branch: body.branch,
                sha: body.sha,
                orgRepo: body.orgRepo,
                agent: body.agent,
                event: body.event,
                signals: {
                    sessionId: body.signals.sessionId,
                    turnId: body.signals.turnId,
                    prompt: body.signals.prompt,
                    assistantMessage: body.signals.assistantMessage,
                    modifiedFiles: body.signals.modifiedFiles || [],
                    toolUses: body.signals.toolUses || [],
                },
                summary: body.summary,
                capturedAt: body.capturedAt,
            },
        });

        if (!result.accepted && res) {
            res.status(HttpStatus.OK);
        }

        return result;
    }

    /**
     * Ingest a session lifecycle event from the CLI
     */
    @Post('sessions/events')
    @ApiOperation({
        summary: 'Ingest CLI session event',
        description:
            'Receives session lifecycle events (session_start, turn_start, turn_end, subagent_start, subagent_end, session_end) from the CLI agent.',
    })
    @ApiHeader({
        name: 'authorization',
        required: false,
        description: 'Bearer token (JWT or kodus_* team key)',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiCreatedResponse({
        description: 'Event accepted',
        schema: {
            type: 'object',
            properties: {
                accepted: { type: 'boolean', example: true },
            },
        },
    })
    @ApiUnauthorizedResponse({
        description: 'Invalid or missing authentication',
        type: ApiErrorDto,
    })
    async ingestSessionEvent(
        @Req() req: { body: Record<string, unknown> },
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Query('teamId') queryTeamId?: string,
    ) {
        const auth = await this.validateCliKeyUseCase.execute({
            teamKey,
            authHeader,
            queryTeamId,
        });

        if (!auth.valid || !auth.organizationId || !auth.teamId) {
            throw new UnauthorizedException(
                auth.error ||
                    'Authentication required. Provide a team API key via X-Team-Key header, or a JWT via Authorization: Bearer header.',
            );
        }

        const rateLimitResult =
            await this.authenticatedRateLimiter.checkRateLimit(auth.teamId);

        if (!rateLimitResult.allowed) {
            throw new HttpException(
                {
                    message:
                        'Rate limit exceeded for this team. Please try again later.',
                    remaining: rateLimitResult.remaining,
                    resetAt: rateLimitResult.resetAt?.toISOString(),
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        const body = req.body;
        const dto = new SessionEventRequestDto();
        Object.assign(dto, body);
        const errors = await validate(dto);
        if (errors.length > 0) {
            const messages = errors.flatMap((e) =>
                Object.values(e.constraints || {}),
            );
            throw new BadRequestException(messages);
        }

        const { sessionId, type, branch, timestamp, ...rest } = body as any;

        return this.ingestSessionEventUseCase.execute({
            organizationAndTeamData: {
                organizationId: auth.organizationId,
                teamId: auth.teamId,
            },
            event: {
                sessionId,
                type,
                branch,
                timestamp,
                ...rest,
            },
        });
    }

    /**
     * Trial status endpoint — returns current rate limit info without incrementing
     */
    @Get('trial/status')
    @ApiOperation({
        summary: 'Get trial rate limit status',
        description:
            'Returns current trial usage for the given fingerprint without consuming a review.',
    })
    @ApiOkResponse({
        description: 'Trial status',
        schema: {
            type: 'object',
            properties: {
                fingerprint: { type: 'string' },
                reviewsUsed: { type: 'number' },
                reviewsLimit: { type: 'number' },
                filesLimit: { type: 'number' },
                linesLimit: { type: 'number' },
                resetsAt: { type: 'string' },
                isLimited: { type: 'boolean' },
            },
        },
    })
    async trialStatus(@Query('fingerprint') fingerprint: string) {
        if (!fingerprint) {
            throw new HttpException(
                'fingerprint query parameter is required',
                HttpStatus.BAD_REQUEST,
            );
        }

        const status =
            await this.trialRateLimiter.getRateLimitStatus(fingerprint);

        const reviewsLimit = 2;
        const reviewsUsed = reviewsLimit - status.remaining;

        return {
            fingerprint,
            reviewsUsed,
            reviewsLimit,
            filesLimit: 10,
            linesLimit: 500,
            resetsAt:
                status.resetAt?.toISOString() ??
                new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            isLimited: !status.allowed,
        };
    }

    /**
     * Trial CLI code review endpoint (no authentication required)
     * Rate limited by device fingerprint
     */
    @Post('trial/review')
    @ApiOperation({
        summary: 'Run trial CLI code review',
        description:
            'Runs a trial code review (no auth). Requires `fingerprint` and is rate-limited by device.',
    })
    @ApiOkResponse({ type: TrialCliReviewResponseDto })
    @ApiBadRequestResponse({
        description: 'Missing device fingerprint',
        type: ApiErrorDto,
    })
    @ApiTooManyRequestsResponse({
        description: 'Rate limit exceeded',
        type: CliReviewRateLimitErrorDto,
    })
    async trialReview(@Body() body: TrialCliReviewRequestDto) {
        if (!body.fingerprint) {
            throw new HttpException(
                'Device fingerprint is required for trial reviews',
                HttpStatus.BAD_REQUEST,
            );
        }

        // Check rate limit
        const rateLimitResult = await this.trialRateLimiter.checkRateLimit(
            body.fingerprint,
        );

        if (!rateLimitResult.allowed) {
            throw new HttpException(
                {
                    message: 'Rate limit exceeded. Please try again later.',
                    remaining: rateLimitResult.remaining,
                    resetAt: rateLimitResult.resetAt?.toISOString(),
                    limit: 2,
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        // Execute review with trial defaults (no auth required).
        // gitContext carries only what's needed to clone+apply the diff in
        // the sandbox; mergeBaseSha lets us skip the user's branch ref
        // (likely not pushed yet for trial users) and githubPat — if the
        // user provided one — unlocks private repos. Neither is persisted
        // to automation_execution.dataExecution.
        const result = await this.executeCliReviewUseCase.execute({
            organizationAndTeamData: {
                organizationId: 'trial',
                teamId: 'trial',
            },
            input: {
                diff: body.diff,
                config: body.config,
            },
            isTrialMode: true,
            gitContext: {
                remote: body.gitRemote,
                branch: body.branch,
                commitSha: body.commitSha,
                mergeBaseSha: body.mergeBaseSha,
                githubPat: body.githubPat,
                inferredPlatform: body.inferredPlatform,
                cliVersion: body.cliVersion,
            },
        });

        // Add rate limit info to response
        return {
            ...result,
            rateLimit: {
                remaining: rateLimitResult.remaining,
                limit: 2,
                resetAt: rateLimitResult.resetAt?.toISOString(),
            },
        };
    }

    /**
     * Public PR review endpoint (no auth).
     *
     * Accepts a public GitHub PR URL, fetches metadata + diff from GitHub,
     * and enqueues a trial-mode review. Returns a jobId the client can poll
     * via GET /cli/public/review/jobs/:jobId.
     *
     * Rate-limited by device fingerprint (same bucket as /cli/trial/review).
     * Repos that return 404/403 surface as 403 { code: 'requires_auth' } so
     * the frontend can redirect to signup.
     *
     * NOTE on DoS protection. The fingerprint check here is a soft
     * per-browser dedup, not the abuse defense. An attacker can rotate
     * the fingerprint trivially. The real per-IP rate limit lives in
     * the AWS WAF rule attached to the ALB in front of this service
     * (rate-based, scoped to `/cli/public/*`) where the source IP is
     * trusted and not spoofable. We deliberately don't read req.ip
     * here because without a tightly scoped `trust proxy` config it's
     * either useless (ALB IP for everyone) or spoofable
     * (X-Forwarded-For). See the deployment runbook for the WAF rule.
     */
    @Post('public/review-pr')
    @ApiOperation({
        summary: 'Run a code review on a public GitHub PR URL',
        description:
            'Fetches the PR diff from GitHub and enqueues a trial-mode review. Anonymous, rate-limited by device fingerprint.',
    })
    @ApiOkResponse({
        description: 'Review enqueued',
        schema: {
            type: 'object',
            properties: {
                jobId: { type: 'string' },
                status: { type: 'string', example: 'pending' },
                statusUrl: { type: 'string' },
                pr: {
                    type: 'object',
                    properties: {
                        owner: { type: 'string' },
                        repo: { type: 'string' },
                        prNumber: { type: 'number' },
                        title: { type: 'string' },
                        headSha: { type: 'string' },
                        baseSha: { type: 'string' },
                        additions: { type: 'number' },
                        deletions: { type: 'number' },
                        changedFiles: { type: 'number' },
                        htmlUrl: { type: 'string' },
                    },
                },
            },
        },
    })
    @ApiBadRequestResponse({ type: ApiErrorDto })
    @ApiTooManyRequestsResponse({ type: CliReviewRateLimitErrorDto })
    async publicPrReview(
        @Body() body: PublicPrReviewRequestDto,
        @Res({ passthrough: true }) res?: any,
    ) {
        if (!body.fingerprint) {
            throw new BadRequestException(
                'Device fingerprint is required for public reviews',
            );
        }

        const result = await this.publicPrReviewUseCase.execute({
            prUrl: body.prUrl,
            fingerprint: body.fingerprint,
        });

        if (result.ok === false) {
            if (result.code === 'rate_limited') {
                throw new HttpException(
                    {
                        message: result.message,
                        remaining: result.rateLimit?.remaining,
                        resetAt: result.rateLimit?.resetAt,
                        limit: result.rateLimit?.limit,
                    },
                    result.statusCode,
                );
            }
            throw new HttpException(
                { code: result.code, message: result.message },
                result.statusCode,
            );
        }

        if (res) {
            res.status(HttpStatus.ACCEPTED);
        }
        return result.response;
    }

    /**
     * Public job status endpoint (no auth).
     *
     * Mirrors GET /cli/review/jobs/:jobId but scopes lookup to the 'trial'
     * organization so callers can poll public-demo jobs without a session.
     * Cross-tenant lookups still fail because the use case validates
     * organizationId match.
     */
    @Get('public/review/jobs/:jobId')
    @ApiOperation({
        summary: 'Get status of a public PR review job',
        description:
            'Poll for the result of a job enqueued via POST /cli/public/review-pr. No auth required.',
    })
    async getPublicReviewJob(
        @Param('jobId') jobId: string,
        @Query('omit') omit?: string,
    ) {
        // The frontend caches publicPr/publicDiff in sessionStorage
        // after the first poll, so subsequent polls pass `?omit=payload`
        // to skip re-downloading ~15 KB every 3 seconds.
        const omitPayload = omit === 'payload';
        return this.getCliReviewJobStatusUseCase.execute({
            jobId,
            organizationId: 'trial',
            omitPayload,
        });
    }

    /**
     * Featured public reviews — pre-curated snapshots of real PRs the
     * Kodus team picked because they expose interesting bugs. Used by
     * the home grid on try.kodus.io and embedded on the kodus.io
     * WordPress site so visitors can explore a real review without
     * waiting for one to run.
     */
    @Get('public/featured-reviews')
    @ApiOperation({
        summary: 'List featured public PR reviews',
        description:
            'Lightweight metadata for the public-demo home grid. Each item links to /cli/public/featured-reviews/:slug for the full snapshot.',
    })
    async listFeaturedReviews() {
        return this.listFeaturedPublicReviewsUseCase.execute();
    }

    @Get('public/featured-reviews/:slug')
    @ApiOperation({
        summary: 'Get a featured public PR review snapshot',
        description:
            'Returns the full review (PR metadata, raw diff, issues). Slug is the URL-safe identifier assigned at curation time (e.g. "vercel-nextjs-93759").',
    })
    async getFeaturedReview(@Param('slug') slug: string) {
        const review = await this.getFeaturedPublicReviewUseCase.execute({
            slug,
        });
        if (!review) {
            throw new NotFoundException(
                `Featured review "${slug}" not found`,
            );
        }
        return review;
    }
}
