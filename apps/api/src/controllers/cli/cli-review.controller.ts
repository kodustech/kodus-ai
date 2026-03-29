import { ExecuteCliReviewUseCase } from '@libs/cli-review/application/use-cases/execute-cli-review.use-case';
import { IngestSessionEventUseCase } from '@libs/cli-review/application/use-cases/ingest-session-event.use-case';
import { SubmitCliSessionCaptureUseCase } from '@libs/cli-review/application/use-cases/submit-cli-session-capture.use-case';
import { AuthenticatedRateLimiterService } from '@libs/cli-review/infrastructure/services/authenticated-rate-limiter.service';
import { TrialRateLimiterService } from '@libs/cli-review/infrastructure/services/trial-rate-limiter.service';
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
        private readonly ingestSessionEventUseCase: IngestSessionEventUseCase,
        private readonly submitCliSessionCaptureUseCase: SubmitCliSessionCaptureUseCase,
        private readonly trialRateLimiter: TrialRateLimiterService,
        private readonly authenticatedRateLimiter: AuthenticatedRateLimiterService,
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
        const payload = await this.validateKeyInternal(
            teamKey,
            authHeader,
            queryTeamId,
        );

        // Device tracking (opt-in)
        if (deviceId && payload.valid && payload.organizationId) {
            try {
                const deviceResult =
                    await this.cliDeviceService.validateOrRegisterDevice({
                        deviceId,
                        deviceToken,
                        organizationId: payload.organizationId,
                        userAgent,
                    });
                if (deviceResult.deviceToken) {
                    res.setHeader(
                        'x-kodus-device-token',
                        deviceResult.deviceToken,
                    );
                    payload.deviceToken = deviceResult.deviceToken;
                    if (payload.data) {
                        payload.data.deviceToken = deviceResult.deviceToken;
                    }
                }
            } catch (error) {
                return res.status(error.getStatus?.() ?? 401).json({
                    ...payload,
                    valid: false,
                    error: error.message,
                    ...(error.getResponse?.()?.code
                        ? { code: error.getResponse().code }
                        : {}),
                    ...(error.getResponse?.()?.details
                        ? { details: error.getResponse().details }
                        : {}),
                });
            }
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
        const payload = await this.validateKeyInternal(
            teamKey,
            authHeader,
            queryTeamId,
        );

        // Device tracking (opt-in)
        if (deviceId && payload.valid && payload.organizationId) {
            try {
                const deviceResult =
                    await this.cliDeviceService.validateOrRegisterDevice({
                        deviceId,
                        deviceToken,
                        organizationId: payload.organizationId,
                        userAgent,
                    });
                if (deviceResult.deviceToken) {
                    res.setHeader(
                        'x-kodus-device-token',
                        deviceResult.deviceToken,
                    );
                    payload.deviceToken = deviceResult.deviceToken;
                    if (payload.data) {
                        payload.data.deviceToken = deviceResult.deviceToken;
                    }
                }
            } catch (error) {
                return res.status(error.getStatus?.() ?? 401).json({
                    ...payload,
                    valid: false,
                    error: error.message,
                    ...(error.getResponse?.()?.code
                        ? { code: error.getResponse().code }
                        : {}),
                    ...(error.getResponse?.()?.details
                        ? { details: error.getResponse().details }
                        : {}),
                });
            }
        }

        return res.status(payload.valid ? 200 : 401).json(payload);
    }

    private async validateKeyInternal(
        teamKey?: string,
        authHeader?: string,
        queryTeamId?: string,
    ) {
        const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');

        const buildPayload = (base: any) => ({
            ...base,
            data: {
                ...base,
            },
        });

        const buildInvalidPayload = (error: string) =>
            buildPayload({
                valid: false,
                error,
                team: {
                    id: null,
                    name: '',
                },
                organization: {
                    id: null,
                    name: '',
                },
                user: {
                    email: '',
                    name: '',
                },
            });

        // Route 1: Team CLI key (via X-Team-Key or Bearer with kodus_ prefix)
        if (teamKey || bearerToken?.startsWith('kodus_')) {
            const key = teamKey || bearerToken;

            if (!key) {
                return buildInvalidPayload(
                    'Team API key required. Provide via X-Team-Key or Authorization: Bearer header.',
                );
            }

            const teamData = await this.teamCliKeyService.validateKey(key);

            if (!teamData) {
                return buildInvalidPayload('Invalid or revoked team API key');
            }

            const { team, organization } = teamData;

            const safeTeam: any = team ?? {};
            const safeOrg: any = organization ?? {};
            const safeTeamName =
                typeof safeTeam.name === 'string' ? safeTeam.name : '';
            const safeOrgName =
                typeof safeOrg.name === 'string' ? safeOrg.name : '';

            const result = {
                valid: !!(safeTeam.uuid && safeOrg.uuid),
                teamId: safeTeam.uuid ?? null,
                organizationId: safeOrg.uuid ?? null,
                teamName: safeTeamName,
                organizationName: safeOrgName,
                team: {
                    id: safeTeam.uuid ?? null,
                    name: safeTeamName,
                },
                organization: {
                    id: safeOrg.uuid ?? null,
                    name: safeOrgName,
                },
                user: {
                    email: '',
                    name: '',
                },
                email: '',
                userEmail: '',
            };

            if (!result.valid) {
                result['error'] = 'Invalid or incomplete team API key';
            }

            return buildPayload(result);
        }

        // Route 2: JWT Bearer token
        if (bearerToken) {
            let jwtPayload: any;
            try {
                jwtPayload = this.jwtService.verify(bearerToken, {
                    secret: this.jwtConfig.secret,
                });
            } catch {
                return buildInvalidPayload('Invalid or expired JWT token');
            }

            const user = await this.authService.validateUser({
                email: jwtPayload.email,
            });

            if (
                !user ||
                user.role !== jwtPayload.role ||
                user.status !== jwtPayload.status ||
                user.status === STATUS.REMOVED
            ) {
                return buildInvalidPayload(
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
                queryTeamId !== jwtPayload.organizationId
            ) {
                return buildInvalidPayload(
                    `Team not found for the provided teamId: ${queryTeamId}`,
                );
            }

            if (!team) {
                team = await this.teamService.findFirstCreatedTeam(
                    jwtPayload.organizationId,
                );
            }

            if (!team) {
                return buildInvalidPayload(
                    'No active team found for the authenticated user',
                );
            }

            if (team.organization?.uuid !== jwtPayload.organizationId) {
                return buildInvalidPayload(
                    'Team does not belong to the authenticated organization',
                );
            }

            const safeTeamName = typeof team.name === 'string' ? team.name : '';
            const safeOrgName =
                typeof team.organization?.name === 'string'
                    ? team.organization.name
                    : '';

            return buildPayload({
                valid: true,
                teamId: team.uuid,
                organizationId: jwtPayload.organizationId,
                teamName: safeTeamName,
                organizationName: safeOrgName,
                team: {
                    id: team.uuid,
                    name: safeTeamName,
                },
                organization: {
                    id: jwtPayload.organizationId,
                    name: safeOrgName,
                },
                user: {
                    email: jwtPayload.email ?? '',
                    name: '',
                },
                email: jwtPayload.email ?? '',
                userEmail: jwtPayload.email ?? '',
            });
        }

        // No auth provided
        return buildInvalidPayload(
            'Authentication required. Provide a team API key via X-Team-Key header, or a JWT via Authorization: Bearer header.',
        );
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
        const auth = await this.validateKeyInternal(
            teamKey,
            authHeader,
            queryTeamId,
        );

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
        @Res({ passthrough: true }) res?: any,
    ) {
        const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');

        let organizationAndTeamData: {
            organizationId: string;
            teamId: string;
        };
        let teamForRateLimit: { uuid: string; cliConfig?: any };

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

            const { team, organization } = teamData;

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

        // 6. Execute review
        const reviewResult = await this.executeCliReviewUseCase.execute({
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
                inferredPlatform: body.inferredPlatform,
                cliVersion: body.cliVersion,
            },
        });

        return {
            ...reviewResult,
            ...(deviceResult?.deviceToken
                ? { deviceToken: deviceResult.deviceToken }
                : {}),
        };
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
        const auth = await this.validateKeyInternal(
            teamKey,
            authHeader,
            queryTeamId,
        );

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
        const auth = await this.validateKeyInternal(
            teamKey,
            authHeader,
            queryTeamId,
        );

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

        // Execute review with trial defaults (no auth required)
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
}
