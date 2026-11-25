import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    Inject,
    Post,
    Query,
    Res,
    UnauthorizedException,
} from '@nestjs/common';
import {
    ApiCreatedResponse,
    ApiHeader,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { connectionDownloadScope } from '@libs/centralized-config/utils/connection-download-scope';
import { Response } from 'express';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { finished } from 'stream/promises';

import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import {
    TEAM_CLI_KEY_SERVICE_TOKEN,
    ITeamCliKeyService,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import { TEAM_CLI_KEY_CAPABILITIES } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';
import {
    INTEGRATION_CONFIG_SERVICE_TOKEN,
    IIntegrationConfigService,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { ParametersKey } from '@libs/core/domain/enums';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { CentralizedConfigInitUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-init.use-case';
import { CentralizedConfigSyncUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-sync.use-case';
import { CentralizedConfigDownloadZipUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-download-zip.use-case';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';

@ApiTags('CLI Centralized Config')
@ApiStandardResponses()
@Public()
@Controller('cli/config/centralized')
export class CliCentralizedConfigController {
    constructor(
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamCliKeyService: ITeamCliKeyService,
        private readonly codeManagementService: CodeManagementService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly centralizedConfigInitUseCase: CentralizedConfigInitUseCase,
        private readonly centralizedConfigSyncUseCase: CentralizedConfigSyncUseCase,
        private readonly centralizedConfigDownloadZipUseCase: CentralizedConfigDownloadZipUseCase,
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
    ) {}

    @Get('/status')
    @ApiOperation({
        summary: 'Get centralized config status',
        description:
            'Returns whether centralized config is enabled and which repository is selected.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiHeader({
        name: 'authorization',
        required: false,
        description: 'Bearer Team CLI key (alternative to x-team-key)',
    })
    @ApiOkResponse({
        schema: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean', example: false },
                repository: {
                    nullable: true,
                    oneOf: [
                        {
                            type: 'object',
                            properties: {
                                id: { type: 'string', example: '123' },
                                name: {
                                    type: 'string',
                                    example: 'kodus-config',
                                },
                            },
                        },
                        { type: 'null' },
                    ],
                },
            },
        },
    })
    async getStatus(
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Query('connectionId') connectionId?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);

        const workspace = this.toOrganizationAndTeamData(authContext);
        const connections = await this.connectionsOf(workspace);

        const statusOf = async (context: OrganizationAndTeamData) => {
            const parameter = await this.parametersService.findByKey(
                ParametersKey.CENTRALIZED_CONFIG,
                context,
            );
            return {
                enabled: parameter?.configValue?.enabled === true,
                repository: parameter?.configValue?.repository ?? null,
            };
        };

        if (connectionId || connections.length < 2) {
            return statusOf(this.scopeTo(workspace, connections, connectionId));
        }

        return {
            ...(await statusOf(workspace)),
            connections: await Promise.all(
                connections.map(async (connection) => ({
                    connectionId: connection.integrationId,
                    ...(await statusOf({
                        ...workspace,
                        integrationId: connection.integrationId,
                    })),
                })),
            ),
        };
    }

    @Post('/init')
    @ApiOperation({
        summary: 'Initialize centralized config',
        description:
            'Enables centralized config for a selected repository and optionally creates the initial PR.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiHeader({
        name: 'authorization',
        required: false,
        description: 'Bearer Team CLI key (alternative to x-team-key)',
    })
    @ApiCreatedResponse({
        schema: {
            type: 'object',
            properties: {
                success: { type: 'boolean', example: true },
                message: {
                    type: 'string',
                    example: 'Centralized config initialized successfully',
                },
                prUrl: {
                    type: 'string',
                    nullable: true,
                    example: 'https://github.com/foo/bar/pull/123',
                },
            },
        },
    })
    async initialize(
        @Body()
        body: {
            repositoryId: string;
            syncOption?: 'pr' | 'manual';
            connectionId?: string;
        },
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);

        const workspace = this.toOrganizationAndTeamData(authContext);

        if (!body?.repositoryId) {
            throw new BadRequestException('repositoryId is required');
        }

        const connections = await this.connectionsOf(workspace);
        const context = this.scopeTo(
            workspace,
            connections,
            body.connectionId ??
                this.connectionListing(connections, body.repositoryId),
        );
        await this.ensureCodeManagementIntegration(context);

        const repository = await this.getSelectedRepository(
            context,
            body.repositoryId,
        );

        const syncOption = body?.syncOption ?? 'pr';

        if (syncOption !== 'pr' && syncOption !== 'manual') {
            throw new BadRequestException(
                'syncOption must be either pr or manual',
            );
        }

        return this.centralizedConfigInitUseCase.execute({
            user: this.buildCliUser(authContext),
            organizationAndTeamData: context,
            repository: {
                id: repository.id,
                name: repository.name,
            },
            syncOption,
            skipAuthorizationForDownload: true,
        });
    }

    @Post('/sync')
    @ApiOperation({
        summary: 'Run centralized config sync',
        description: 'Runs an on-demand centralized config sync for the team.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiHeader({
        name: 'authorization',
        required: false,
        description: 'Bearer Team CLI key (alternative to x-team-key)',
    })
    @ApiCreatedResponse({
        schema: {
            type: 'object',
            properties: {
                success: { type: 'boolean', example: true },
                message: {
                    type: 'string',
                    example: 'Centralized config sync completed successfully',
                },
            },
        },
    })
    async sync(
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Query('connectionId') connectionId?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);

        const workspace = this.toOrganizationAndTeamData(authContext);
        const context = this.scopeTo(
            workspace,
            await this.connectionsOf(workspace),
            connectionId,
        );
        await this.ensureCodeManagementIntegration(context);

        return this.centralizedConfigSyncUseCase.execute({
            organizationAndTeamData: context,
        });
    }

    @Post('/disable')
    @ApiOperation({
        summary: 'Disable centralized config',
        description:
            'Disables centralized config and clears the selected repository.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiHeader({
        name: 'authorization',
        required: false,
        description: 'Bearer Team CLI key (alternative to x-team-key)',
    })
    @ApiCreatedResponse({
        schema: {
            type: 'object',
            properties: {
                success: { type: 'boolean', example: true },
                message: {
                    type: 'string',
                    example: 'Centralized config disabled successfully',
                },
            },
        },
    })
    async disable(
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Query('connectionId') connectionId?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);

        const workspace = this.toOrganizationAndTeamData(authContext);
        const context = this.scopeTo(
            workspace,
            await this.connectionsOf(workspace),
            connectionId,
        );

        await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                enabled: false,
                repository: null,
                activePullRequest: null,
            },
            context,
        );

        return {
            success: true,
            message: 'Centralized config disabled successfully',
        };
    }

    @Get('/download')
    @ApiOperation({
        summary: 'Download centralized config ZIP',
        description:
            'Downloads a ZIP containing global/repository/directory kodus-config.yml files for centralized config setup.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiHeader({
        name: 'authorization',
        required: false,
        description: 'Bearer Team CLI key (alternative to x-team-key)',
    })
    @ApiOkResponse({ content: { 'application/zip': {} } })
    async download(
        @Res() response: Response,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Query('connectionId') connectionId?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);

        const workspace = this.toOrganizationAndTeamData(authContext);
        const connections = await this.connectionsOf(workspace);
        const context = this.scopeTo(workspace, connections, connectionId);

        const archive = await this.centralizedConfigDownloadZipUseCase.execute(
            this.buildCliUser(authContext),
            context.teamId,
            {
                skipAuthorization: true,
                organizationId: context.organizationId,
                ...(await this.downloadScope(context, connections)),
            },
        );

        response.set({
            'Content-Type': 'application/zip',
            'Content-Disposition':
                'attachment; filename=centralized-config.zip',
        });

        archive.on('error', (err) => {
            response.destroy(err);
        });

        archive.pipe(response);

        if (typeof (response as any).on === 'function') {
            await finished(response as any);
        }
        return;
    }

    private async resolveCliContext(teamKey?: string, authHeader?: string) {
        const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');
        const resolvedTeamKey = teamKey || bearerToken;

        if (!resolvedTeamKey || !resolvedTeamKey.startsWith('kodus_')) {
            throw new UnauthorizedException('Team API key required');
        }

        const teamData =
            await this.teamCliKeyService.validateKey(resolvedTeamKey);

        if (!teamData?.team?.uuid || !teamData?.organization?.uuid) {
            throw new UnauthorizedException('Invalid or revoked team API key');
        }

        return {
            organizationId: teamData.organization.uuid,
            teamId: teamData.team.uuid,
            config: teamData.config,
        };
    }

    private ensureRepositoryConfigCapability(context: {
        organizationId: string;
        teamId: string;
        config?: {
            capabilities?: string[];
        };
    }) {
        const hasCapability =
            context.config?.capabilities?.includes(
                TEAM_CLI_KEY_CAPABILITIES.CONFIG_REPO_MANAGE,
            ) ?? false;

        if (!hasCapability) {
            throw new ForbiddenException(
                'This CLI key is not allowed to configure repositories',
            );
        }
    }

    private toOrganizationAndTeamData(context: {
        organizationId: string;
        teamId: string;
    }) {
        return {
            organizationId: context.organizationId,
            teamId: context.teamId,
        };
    }

    private async ensureCodeManagementIntegration(
        context: OrganizationAndTeamData,
    ) {
        const integrationType =
            await this.codeManagementService.getTypeIntegration(context);

        if (!integrationType) {
            throw new BadRequestException(
                'Code management integration is not configured for this team',
            );
        }

        return integrationType;
    }

    private async getSelectedRepository(
        context: OrganizationAndTeamData,
        repositoryId: string,
    ) {
        const selectedRepositories =
            (await this.integrationConfigService.findIntegrationConfigFormatted<
                Repositories[]
            >(IntegrationConfigKey.REPOSITORIES, context)) ?? [];

        const repository = selectedRepositories.find(
            (repo) =>
                String(repo.id) === String(repositoryId) &&
                repo.selected !== false,
        );

        if (!repository) {
            throw new BadRequestException(
                'Repository must be selected in Kodus before enabling centralized config',
            );
        }

        return repository;
    }

    /** The workspace's Git connections, each with the repository ids it lists. */
    private async connectionsOf(
        context: OrganizationAndTeamData,
    ): Promise<Array<{ integrationId: string; repositoryIds: string[] }>> {
        // Every active connection counts, saved repositories or not.
        const [connections, configs] = await Promise.all([
            this.integrationService.find({
                organization: { uuid: context.organizationId },
                team: { uuid: context.teamId },
                integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                status: true,
            }),
            this.integrationConfigService.findAllOfTeamByConfigKey(
                IntegrationConfigKey.REPOSITORIES,
                context,
            ),
        ]);
        const repositoriesOf = new Map(
            (configs ?? [])
                .filter((config) => config?.integration?.uuid)
                .map((config) => [
                    config.integration.uuid,
                    (Array.isArray(config.configValue)
                        ? (config.configValue as Repositories[])
                        : []
                    ).map((repository) => String(repository.id)),
                ]),
        );
        return (connections ?? []).map((connection) => ({
            integrationId: connection.uuid,
            repositoryIds: repositoriesOf.get(connection.uuid) ?? [],
        }));
    }

    /**
     * Scopes a call to one Git connection: the one named, or the only one.
     * A workspace with several has to name it.
     */
    private scopeTo(
        workspace: OrganizationAndTeamData,
        connections: Array<{ integrationId: string }>,
        connectionId?: string,
    ): OrganizationAndTeamData {
        if (connectionId) {
            if (!connections.some((c) => c.integrationId === connectionId)) {
                throw new BadRequestException(
                    'This Git connection is not in the workspace.',
                );
            }
            return { ...workspace, integrationId: connectionId };
        }
        if (connections.length > 1) {
            throw new BadRequestException(
                `This workspace has several Git connections. Pass connectionId, one of: ${connections
                    .map((c) => c.integrationId)
                    .join(', ')}.`,
            );
        }
        return workspace;
    }

    /** The one connection that lists a repository; ambiguous or unknown answers none. */
    private connectionListing(
        connections: Array<{ integrationId: string; repositoryIds: string[] }>,
        repositoryId: string,
    ): string | undefined {
        if (connections.length < 2) return undefined;
        const listing = connections.filter((c) =>
            c.repositoryIds.includes(String(repositoryId)),
        );
        return listing.length === 1 ? listing[0].integrationId : undefined;
    }

    /**
     * A connection other than the one the workspace's centralized config is
     * on exports only its own repositories, without the workspace defaults.
     */
    private async downloadScope(
        context: OrganizationAndTeamData,
        connections: Array<{ integrationId: string; repositoryIds: string[] }>,
    ): Promise<{
        repositoryIds?: string[];
        includeWorkspaceDefaults?: boolean;
    }> {
        if (!context.integrationId) return {};
        const parameter = await this.parametersService.findByKey(
            ParametersKey.CENTRALIZED_CONFIG,
            context,
        );
        return connectionDownloadScope(
            context.integrationId,
            connections.find((c) => c.integrationId === context.integrationId)
                ?.repositoryIds ?? [],
            parameter?.configValue,
        );
    }

    private buildCliUser(context: {
        organizationId: string;
        teamId: string;
    }): Partial<IUser> {
        return {
            uuid: 'kody',
            email: 'kody@kodus.io',
            organization: {
                uuid: context.organizationId,
            },
        };
    }
}
