import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    Inject,
    Post,
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
import { Response } from 'express';
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
import { CentralizedConfigDownloadUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-download.use-case';
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
        private readonly centralizedConfigDownloadUseCase: CentralizedConfigDownloadUseCase,
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
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);

        const context = this.toOrganizationAndTeamData(authContext);

        const parameter = await this.parametersService.findByKey(
            ParametersKey.CENTRALIZED_CONFIG,
            context,
        );

        const configValue = parameter?.configValue ?? {
            enabled: false,
            repository: null,
        };

        return {
            enabled: configValue?.enabled === true,
            repository: configValue?.repository ?? null,
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
        },
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);

        const context = this.toOrganizationAndTeamData(authContext);
        await this.ensureCodeManagementIntegration(context);

        if (!body?.repositoryId) {
            throw new BadRequestException('repositoryId is required');
        }

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
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);

        const context = this.toOrganizationAndTeamData(authContext);
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
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);

        const context = this.toOrganizationAndTeamData(authContext);

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
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);

        const context = this.toOrganizationAndTeamData(authContext);

        const entries = await this.centralizedConfigDownloadUseCase.execute(
            this.buildCliUser(authContext),
            context.teamId,
            {
                skipAuthorization: true,
                organizationId: context.organizationId,
            },
        );

        response.set({
            'Content-Type': 'application/zip',
            'Content-Disposition':
                'attachment; filename=centralized-config.zip',
        });

        const { default: archiver } = await import('archiver');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', (err) => {
            response.destroy(err);
        });

        archive.pipe(response);

        for (const entry of entries) {
            archive.append(entry.content, { name: entry.path });
        }

        await archive.finalize();
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

    private async ensureCodeManagementIntegration(context: {
        organizationId: string;
        teamId: string;
    }) {
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
        context: {
            organizationId: string;
            teamId: string;
        },
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
