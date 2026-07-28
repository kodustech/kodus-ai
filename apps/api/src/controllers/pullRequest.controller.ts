import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { JWT } from '@libs/core/infrastructure/config/types/jwt/jwt';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import { BackfillHistoricalPRsUseCase } from '@libs/platformData/application/use-cases/pullRequests/backfill-historical-prs.use-case';
import { GetEnrichedPullRequestsUseCase } from '@libs/code-review/application/use-cases/dashboard/get-enriched-pull-requests.use-case';
import {
    GetPullRequestsDailyDigestUseCase,
    PullRequestsDailyDigest,
} from '@libs/code-review/application/use-cases/dashboard/get-pull-requests-daily-digest.use-case';
import {
    GetPullRequestsFacetsUseCase,
    PullRequestsFacets,
} from '@libs/code-review/application/use-cases/dashboard/get-pull-requests-facets.use-case';
import {
    GetPullRequestAuthorsUseCase,
    PullRequestAuthorSuggestion,
} from '@libs/code-review/application/use-cases/dashboard/get-pull-request-authors.use-case';
import {
    GetAwaitingPullRequestsUseCase,
    AwaitingPullRequest,
} from '@libs/code-review/application/use-cases/dashboard/get-awaiting-pull-requests.use-case';
import { GetPullRequestFilesUseCase } from '@libs/code-review/application/use-cases/pullRequests/get-pull-request-files.use-case';
import { GetPullRequestSuggestionsUseCase } from '@libs/code-review/application/use-cases/pullRequests/get-pull-request-suggestions.use-case';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Headers,
    Inject,
    NotFoundException,
    OnApplicationShutdown,
    Post,
    Query,
    Res,
    Sse,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { fromEvent, interval, merge, Subject } from 'rxjs';
import { filter, map, takeUntil } from 'rxjs/operators';
import { PR_EXECUTION_UPDATED_EVENT } from '@libs/automation/infrastructure/adapters/services/automationExecution.service';
import { BackfillPRsDto } from '../dtos/backfill-prs.dto';
import { EnrichedPullRequestsQueryDto } from '@libs/code-review/dtos/dashboard/enriched-pull-requests-query.dto';
import { PaginatedEnrichedPullRequestsResponse } from '@libs/code-review/dtos/dashboard/paginated-enriched-pull-requests.dto';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiHeader,
    ApiOkResponse,
    ApiOperation,
    ApiProduces,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import {
    CLI_DEVICE_SERVICE_TOKEN,
    ICliDeviceService,
} from '@libs/organization/domain/cli-device/contracts/cli-device.service.contract';
import {
    IAutomationExecutionService,
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { PullRequestSuggestionsResponseDto } from '../dtos/pull-request-suggestions-response.dto';
import {
    PullRequestBackfillResponseDto,
    PullRequestExecutionsResponseDto,
} from '../dtos/pull-request-executions-response.dto';

@ApiTags('Pull Requests')
@ApiStandardResponses()
@Controller('pull-requests')
export class PullRequestController implements OnApplicationShutdown {
    private readonly jwtConfig: JWT;
    private readonly shutdown$ = new Subject<void>();

    constructor(
        private readonly getEnrichedPullRequestsUseCase: GetEnrichedPullRequestsUseCase,
        private readonly getPullRequestsDailyDigestUseCase: GetPullRequestsDailyDigestUseCase,
        private readonly getPullRequestsFacetsUseCase: GetPullRequestsFacetsUseCase,
        private readonly getAwaitingPullRequestsUseCase: GetAwaitingPullRequestsUseCase,
        private readonly getPullRequestAuthorsUseCase: GetPullRequestAuthorsUseCase,
        private readonly getPullRequestSuggestionsUseCase: GetPullRequestSuggestionsUseCase,
        private readonly getPullRequestFilesUseCase: GetPullRequestFilesUseCase,
        private readonly codeManagementService: CodeManagementService,
        private readonly backfillHistoricalPRsUseCase: BackfillHistoricalPRsUseCase,
        @Inject(REQUEST)
        private readonly request: UserRequest,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamCliKeyService: ITeamCliKeyService,
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        @Inject(CLI_DEVICE_SERVICE_TOKEN)
        private readonly cliDeviceService: ICliDeviceService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
        private readonly eventEmitter: EventEmitter2,
    ) {
        this.jwtConfig = this.configService.get<JWT>('jwtConfig');
    }

    onApplicationShutdown() {
        this.shutdown$.next();
        this.shutdown$.complete();
    }

    @Get('/executions')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    @ApiOperation({
        summary: 'List PR executions',
        description: 'Return pull request execution history with pagination.',
    })
    @ApiOkResponse({ type: PullRequestExecutionsResponseDto })
    public async getPullRequestExecutions(
        @Query() query: EnrichedPullRequestsQueryDto,
    ): Promise<PaginatedEnrichedPullRequestsResponse> {
        return await this.getEnrichedPullRequestsUseCase.execute(query);
    }

    @Get('/executions/summary')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    @ApiOperation({
        summary: 'Daily PR digest',
        description:
            "Today's counts: reviewed, needs attention, errored, awaiting review.",
    })
    public async getPullRequestsDailyDigest(
        @Query('teamId') teamId?: string,
    ): Promise<PullRequestsDailyDigest> {
        return await this.getPullRequestsDailyDigestUseCase.execute({ teamId });
    }

    @Get('/executions/facets')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    @ApiOperation({
        summary: 'PR segment facet counts',
        description:
            'All-time counts per segment (all, needs attention, errored, awaiting, mine).',
    })
    public async getPullRequestsFacets(
        @Query('teamId') teamId?: string,
        // 'mine' narrows the actionable facet to the caller's own PRs (the dev
        // "Minha fila" view); default 'team' counts the whole team scope.
        @Query('scope') scope?: 'mine' | 'team',
    ): Promise<PullRequestsFacets> {
        return await this.getPullRequestsFacetsUseCase.execute({
            teamId,
            scope: scope === 'mine' ? 'mine' : 'team',
        });
    }

    @Get('/awaiting')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    @ApiOperation({
        summary: 'Awaiting-review PRs',
        description: 'Open pull requests with no Kody review yet.',
    })
    public async getAwaitingPullRequests(
        @Query('teamId') teamId?: string,
    ): Promise<AwaitingPullRequest[]> {
        return await this.getAwaitingPullRequestsUseCase.execute({ teamId });
    }

    @Get('/authors')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    @ApiOperation({
        summary: 'PR author suggestions',
        description:
            'Distinct PR authors (by display name) for the Author-search autocomplete, ordered by PR count.',
    })
    public async getPullRequestAuthors(
        @Query('teamId') teamId?: string,
        @Query('q') q?: string,
        @Query('limit') limit?: string,
    ): Promise<PullRequestAuthorSuggestion[]> {
        const parsedLimit = limit ? Number(limit) : undefined;
        return await this.getPullRequestAuthorsUseCase.execute({
            teamId,
            search: q,
            limit:
                parsedLimit != null && Number.isFinite(parsedLimit)
                    ? parsedLimit
                    : undefined,
        });
    }

    @Sse('/executions/events')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    @ApiOperation({
        summary: 'Stream PR execution events',
        description:
            'Server-sent events for real-time updates when PR review executions change status.',
    })
    @ApiProduces('text/event-stream')
    executionEvents() {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException(
                'Organization UUID is missing in the request',
            );
        }

        const events$ = fromEvent(
            this.eventEmitter,
            PR_EXECUTION_UPDATED_EVENT,
        ).pipe(
            filter((event: any) => event?.organizationId === organizationId),
            map((event: any) => ({
                data: {
                    type: 'execution_updated',
                    executionUuid: event.executionUuid,
                    status: event.status,
                    timestamp: event.timestamp,
                },
            })),
        );

        const heartbeat$ = interval(15000).pipe(
            map(() => ({ data: { type: 'ping' } })),
        );

        return merge(events$, heartbeat$).pipe(takeUntil(this.shutdown$));
    }

    @Get('/suggestions')
    @Public()
    @ApiOperation({
        summary: 'Get PR suggestions',
        description:
            'Returns suggestions for a PR. Requires `x-team-key` when not authenticated. `format=markdown` returns `{ markdown }`.',
    })
    @ApiOkResponse({ type: PullRequestSuggestionsResponseDto })
    @ApiUnauthorizedResponse({ description: 'Device limit reached' })
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
    public async getSuggestionsByPullRequest(
        @Query('prUrl') prUrl?: string,
        @Query('repositoryId') repositoryId?: string,
        @Query('prNumber') prNumber?: string,
        @Query('format') format: 'json' | 'markdown' = 'json',
        @Query('severity') severity?: string,
        @Query('category') category?: string,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Headers('x-kodus-device-id') deviceId?: string,
        @Headers('x-kodus-device-token') deviceToken?: string,
        @Headers('user-agent') userAgent?: string,
        @Res({ passthrough: true }) res?: any,
    ) {
        return this.getSuggestionsWithTeamKey({
            prUrl,
            repositoryId,
            prNumber,
            format,
            severity,
            category,
            teamKey,
            authHeader,
            deviceId,
            deviceToken,
            userAgent,
            res,
        });
    }

    @Post('/cli/suggestions')
    @Public()
    @ApiOperation({
        summary: 'Get PR suggestions (CLI)',
        description:
            'Returns suggestions for a PR via CLI key. `format=markdown` returns `{ markdown }`.',
    })
    @ApiCreatedResponse({ type: PullRequestSuggestionsResponseDto })
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
    public async getSuggestionsByPullRequestWithKey(
        @Body('prUrl') prUrl?: string,
        @Body('repositoryId') repositoryId?: string,
        @Body('prNumber') prNumber?: string,
        @Body('format') format: 'json' | 'markdown' = 'json',
        @Body('severity') severity?: string,
        @Body('category') category?: string,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Headers('x-kodus-device-id') deviceId?: string,
        @Headers('x-kodus-device-token') deviceToken?: string,
        @Headers('user-agent') userAgent?: string,
        @Res({ passthrough: true }) res?: any,
    ) {
        return this.getSuggestionsWithTeamKey({
            prUrl,
            repositoryId,
            prNumber,
            format,
            severity,
            category,
            teamKey,
            authHeader,
            deviceId,
            deviceToken,
            userAgent,
            res,
        });
    }

    @Get('/cli/suggestions')
    @Public()
    @ApiOperation({
        summary: 'Get PR suggestions (CLI) via GET',
        description:
            'Returns suggestions for a PR via CLI key. `format=markdown` returns `{ markdown }`.',
    })
    @ApiOkResponse({ type: PullRequestSuggestionsResponseDto })
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
    public async getSuggestionsByPullRequestWithKeyGet(
        @Query('prUrl') prUrl?: string,
        @Query('repositoryId') repositoryId?: string,
        @Query('prNumber') prNumber?: string,
        @Query('format') format: 'json' | 'markdown' = 'json',
        @Query('severity') severity?: string,
        @Query('category') category?: string,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Headers('x-kodus-device-id') deviceId?: string,
        @Headers('x-kodus-device-token') deviceToken?: string,
        @Headers('user-agent') userAgent?: string,
        @Res({ passthrough: true }) res?: any,
    ) {
        return this.getSuggestionsWithTeamKey({
            prUrl,
            repositoryId,
            prNumber,
            format,
            severity,
            category,
            teamKey,
            authHeader,
            deviceId,
            deviceToken,
            userAgent,
            res,
        });
    }

    private async getSuggestionsWithTeamKey(params: {
        prUrl?: string;
        repositoryId?: string;
        prNumber?: string;
        format?: 'json' | 'markdown';
        severity?: string;
        category?: string;
        teamKey?: string;
        authHeader?: string;
        deviceId?: string;
        deviceToken?: string;
        userAgent?: string;
        res?: any;
    }) {
        const {
            prUrl,
            repositoryId,
            prNumber,
            format = 'json',
            severity,
            category,
            teamKey,
            authHeader,
            deviceId,
            deviceToken,
            userAgent,
            res,
        } = params;

        const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');
        let organizationId: string | undefined;

        // Route 1: Team CLI key (via x-team-key or Bearer kodus_...)
        if (teamKey || bearerToken?.startsWith('kodus_')) {
            const key = teamKey || bearerToken;
            const teamData = await this.teamCliKeyService.validateKey(key);
            if (!teamData?.organization?.uuid) {
                throw new UnauthorizedException(
                    'Invalid or revoked team API key',
                );
            }
            organizationId = teamData.organization.uuid;
        }
        // Route 2: JWT Bearer token
        else if (bearerToken) {
            let jwtPayload: any;
            try {
                jwtPayload = this.jwtService.verify(bearerToken, {
                    secret: this.jwtConfig.secret,
                });
            } catch {
                throw new UnauthorizedException('Invalid or expired JWT token');
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
                throw new UnauthorizedException(
                    'User account is inactive or removed',
                );
            }

            organizationId = jwtPayload.organizationId;
            if (!organizationId) {
                throw new UnauthorizedException('Invalid JWT payload');
            }
        } else {
            throw new UnauthorizedException('Team API key or JWT required');
        }

        // Device tracking (opt-in)
        let deviceResult: { deviceToken?: string } | undefined;
        if (deviceId && organizationId) {
            deviceResult = await this.cliDeviceService.validateOrRegisterDevice(
                {
                    deviceId,
                    deviceToken,
                    organizationId,
                    userAgent,
                },
            );
            if (deviceResult?.deviceToken && res) {
                res.setHeader('x-kodus-device-token', deviceResult.deviceToken);
            }
        }

        const prEntity = await this.findPrEntity({
            prUrl,
            repositoryId,
            prNumber,
            organizationId,
        });

        if (!prEntity) {
            throw new NotFoundException('Pull request not found');
        }

        const pr = prEntity.toObject();
        const { response, suggestionsCount } =
            await this.getPullRequestSuggestionsUseCase.execute({
                organizationId,
                pr,
                format,
                severity,
                category,
            });

        this.trackSuggestionsFetch({
            organizationId,
            prNumber: pr.number,
            repositoryFullName: pr.repository?.fullName,
            format,
            suggestionsCount,
            filters: severity || category ? { severity, category } : undefined,
        });

        if (deviceResult?.deviceToken) {
            return { ...response, deviceToken: deviceResult.deviceToken };
        }

        return response;
    }

    private async findPrEntity(params: {
        prUrl?: string;
        repositoryId?: string;
        prNumber?: string;
        organizationId: string;
    }) {
        const { prUrl, repositoryId, prNumber, organizationId } = params;

        // Try by URL first
        if (prUrl) {
            const direct = await this.pullRequestsService.findOne({
                url: prUrl,
                organizationId,
            });
            if (direct) return direct;

            // Fallback: parse PR number and repo from URL
            const match = prUrl.match(
                /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i,
            );
            if (match) {
                const repoFullName = `${match[1]}/${match[2]}`;
                const parsedNumber = Number(match[3]);
                const byFullName = await this.pullRequestsService.findOne({
                    'number': parsedNumber,
                    organizationId,
                    'repository.fullName': repoFullName,
                } as any);
                if (byFullName) return byFullName;
            }

            // If we got a PR URL but couldn't resolve, return null (404 later)
            return null;
        }

        const parsedPrNumber = prNumber ? parseInt(prNumber, 10) : NaN;
        if (!repositoryId || Number.isNaN(parsedPrNumber)) {
            return null;
        }

        // Try by repo.id
        const byId = await this.pullRequestsService.findOne({
            'number': parsedPrNumber,
            organizationId,
            'repository.id': repositoryId,
        } as any);
        if (byId) return byId;

        // Fallback: try repo fullName if caller passed that in repositoryId
        const byFullNameId = await this.pullRequestsService.findOne({
            'number': parsedPrNumber,
            organizationId,
            'repository.fullName': repositoryId,
        } as any);
        if (byFullNameId) return byFullNameId;

        return null;
    }

    private trackSuggestionsFetch(params: {
        organizationId: string;
        prNumber: number;
        repositoryFullName?: string;
        format: string;
        suggestionsCount: number;
        filters?: { severity?: string; category?: string };
    }): void {
        this.automationExecutionService
            .create({
                status: AutomationStatus.SUCCESS,
                origin: 'cli-suggestions',
                dataExecution: {
                    type: 'CLI_PR_SUGGESTIONS',
                    ...params,
                },
            })
            .catch(() => {}); // fire-and-forget
    }

    @Get('/files')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    @ApiOperation({
        summary: 'Get PR changed files with patches',
        description:
            'Returns changed files with unified diff patches from the Git provider.',
    })
    public async getPullRequestFiles(
        @Query('repositoryId') repositoryId: string,
        @Query('prNumber') prNumber: string,
        @Query('teamId') teamId: string,
        @Query('repositoryName') repositoryName?: string,
    ) {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId || !repositoryId || !prNumber || !teamId) {
            throw new NotFoundException('Missing required parameters');
        }

        return this.getPullRequestFilesUseCase.execute({
            organizationId,
            teamId,
            repositoryId,
            repositoryName,
            prNumber: parseInt(prNumber, 10),
        });
    }

    // NOT USED IN WEB - INTERNAL USE ONLY
    @Post('/backfill')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.PullRequests,
        }),
    )
    @ApiOperation({
        summary: 'Backfill PRs',
        description: 'Trigger historical pull request backfill in background.',
    })
    @ApiCreatedResponse({ type: PullRequestBackfillResponseDto })
    public async backfillHistoricalPRs(@Body() body: BackfillPRsDto) {
        const { teamId, repositoryIds, startDate, endDate } = body;
        const organizationId = this.request.user?.organization?.uuid;

        const organizationAndTeamData = {
            organizationId,
            teamId,
        };

        let repositories = await this.codeManagementService.getRepositories({
            organizationAndTeamData,
        });

        if (!repositories || repositories.length === 0) {
            return {
                success: false,
                message: 'No repositories found',
            };
        }

        repositories = repositories.filter(
            (r: any) => r && (r.selected === true || r.isSelected === true),
        );

        if (repositoryIds && repositoryIds.length > 0) {
            repositories = repositories.filter(
                (r: any) =>
                    repositoryIds.includes(r.id) ||
                    repositoryIds.includes(String(r.id)),
            );
        }

        if (repositories.length === 0) {
            return {
                success: false,
                message: 'No selected repositories found',
            };
        }

        setImmediate(() => {
            this.backfillHistoricalPRsUseCase
                .execute({
                    organizationAndTeamData,
                    repositories: repositories.map((r: any) => ({
                        id: String(r.id),
                        name: r.name,
                        fullName:
                            r.fullName ||
                            r.full_name ||
                            `${r.organizationName || ''}/${r.name}`,
                        url: r.http_url || '',
                    })),
                    startDate,
                    endDate,
                })
                .catch((error) => {
                    console.error('Error during manual PR backfill:', error);
                });
        });

        return {
            success: true,
            message: 'PR backfill started in background',
            repositoriesCount: repositories.length,
        };
    }
}
