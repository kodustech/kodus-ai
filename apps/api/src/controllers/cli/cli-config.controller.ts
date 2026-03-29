import {
    BadRequestException,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    Inject,
    Param,
    Patch,
    Post,
    Body,
    UnauthorizedException,
} from '@nestjs/common';
import {
    ApiCreatedResponse,
    ApiHeader,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import {
    TEAM_CLI_KEY_SERVICE_TOKEN,
    ITeamCliKeyService,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import { TEAM_CLI_KEY_CAPABILITIES } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    INTEGRATION_CONFIG_SERVICE_TOKEN,
    IIntegrationConfigService,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { CreateRepositoriesUseCase } from '@libs/platform/application/use-cases/codeManagement/create-repositories';
import { UpdateCodeReviewParameterRepositoriesUseCase } from '@libs/code-review/application/use-cases/configuration/update-code-review-parameter-repositories-use-case';
import { GetCliRepositorySettingsUseCase } from '@libs/code-review/application/use-cases/configuration/get-cli-repository-settings.use-case';
import { UpdateCliRepositorySettingsUseCase } from '@libs/code-review/application/use-cases/configuration/update-cli-repository-settings.use-case';
import { UpdateOrCreateCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/update-or-create-code-review-parameter-use-case';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import {
    CodeManagementRepositoriesCreateResponseDto,
    CodeManagementRepositoriesResponseDto,
} from '../../dtos/code-management.response.dto';

@ApiTags('CLI Config')
@ApiStandardResponses()
@Public()
@Controller('cli/config')
export class CliConfigController {
    constructor(
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamCliKeyService: ITeamCliKeyService,
        private readonly codeManagementService: CodeManagementService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private readonly createRepositoriesUseCase: CreateRepositoriesUseCase,
        private readonly updateCodeReviewParameterRepositoriesUseCase: UpdateCodeReviewParameterRepositoriesUseCase,
        private readonly updateOrCreateCodeReviewParameterUseCase: UpdateOrCreateCodeReviewParameterUseCase,
        private readonly getCliRepositorySettingsUseCase: GetCliRepositorySettingsUseCase,
        private readonly updateCliRepositorySettingsUseCase: UpdateCliRepositorySettingsUseCase,
    ) {}

    @Get('/repositories/available')
    @ApiOperation({
        summary: 'List repositories available for CLI configuration',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiOkResponse({ type: CodeManagementRepositoriesResponseDto })
    async getAvailableRepositories(
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);
        const context = this.toOrganizationAndTeamData(authContext);
        await this.ensureCodeManagementIntegration(context);

        return this.codeManagementService.getRepositories({
            organizationAndTeamData: context,
        });
    }

    @Get('/repositories/selected')
    @ApiOperation({
        summary: 'List selected repositories for CLI configuration',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiOkResponse({ type: CodeManagementRepositoriesResponseDto })
    async getSelectedRepositories(
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);
        const context = this.toOrganizationAndTeamData(authContext);

        return (
            (await this.integrationConfigService.findIntegrationConfigFormatted<
                Repositories[]
            >(IntegrationConfigKey.REPOSITORIES, context)) ?? []
        );
    }

    @Post('/repositories')
    @ApiOperation({
        summary: 'Add repositories to CLI review configuration',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiCreatedResponse({ type: CodeManagementRepositoriesCreateResponseDto })
    async addRepositories(
        @Body() body: { repositoryIds: string[] },
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);
        const context = this.toOrganizationAndTeamData(authContext);

        const repositoryIds = Array.from(new Set(body?.repositoryIds ?? []));

        if (repositoryIds.length === 0) {
            throw new BadRequestException('repositoryIds must not be empty');
        }

        await this.ensureCodeManagementIntegration(context);

        const [availableRepositories, selectedRepositories] = await Promise.all(
            [
                this.codeManagementService.getRepositories({
                    organizationAndTeamData: context,
                }),
                this.integrationConfigService.findIntegrationConfigFormatted<
                    Repositories[]
                >(IntegrationConfigKey.REPOSITORIES, context),
            ],
        );

        const availableById = new Map(
            (availableRepositories ?? []).map((repository) => [
                String(repository.id),
                repository,
            ]),
        );

        const missingRepositoryIds = repositoryIds.filter(
            (repositoryId) => !availableById.has(repositoryId),
        );

        if (missingRepositoryIds.length > 0) {
            throw new BadRequestException(
                `Repositories not found: ${missingRepositoryIds.join(', ')}`,
            );
        }

        const selectedRepositoryIds = new Set(
            (selectedRepositories ?? []).map((repository) =>
                String(repository.id),
            ),
        );

        const addedRepositoryIds = repositoryIds.filter(
            (repositoryId) => !selectedRepositoryIds.has(repositoryId),
        );
        const alreadyAddedRepositoryIds = repositoryIds.filter((repositoryId) =>
            selectedRepositoryIds.has(repositoryId),
        );

        if (addedRepositoryIds.length === 0) {
            await this.updateCodeReviewParameterRepositoriesUseCase.execute({
                actor: {
                    organizationId: context.organizationId,
                    source: 'cli',
                },
                organizationAndTeamData: context,
            });
            await this.ensureRepositorySettings(repositoryIds, context);

            return {
                status: true,
                addedRepositoryIds: [],
                alreadyAddedRepositoryIds,
                totalSelected: selectedRepositoryIds.size,
                message: 'Repositories already added',
            };
        }

        const mergedRepositoryIds = new Set([
            ...selectedRepositoryIds,
            ...repositoryIds,
        ]);

        const mergedRepositories = (availableRepositories ?? [])
            .filter((repository) =>
                mergedRepositoryIds.has(String(repository.id)),
            )
            .map((repository) => ({
                ...repository,
                selected: true,
            }));

        await this.createRepositoriesUseCase.execute({
            organizationId: context.organizationId,
            repositories: mergedRepositories,
            teamId: context.teamId,
            type: 'replace',
        });

        await this.updateCodeReviewParameterRepositoriesUseCase.execute({
            actor: {
                organizationId: context.organizationId,
                source: 'cli',
            },
            organizationAndTeamData: context,
        });
        await this.ensureRepositorySettings(repositoryIds, context);

        return {
            status: true,
            addedRepositoryIds,
            alreadyAddedRepositoryIds,
            totalSelected: mergedRepositories.length,
        };
    }

    @Get('/repositories/:repositoryId/settings')
    @ApiOperation({
        summary: 'Get repository settings for CLI configuration',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    async getRepositorySettings(
        @Param('repositoryId') repositoryId: string,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);
        const context = this.toOrganizationAndTeamData(authContext);

        const settings = await this.getCliRepositorySettingsUseCase.execute({
            repositoryId,
            organizationAndTeamData: context,
        });

        if (!settings) {
            throw new BadRequestException(
                'Repository settings are not available for this repository',
            );
        }

        return settings;
    }

    @Patch('/repositories/:repositoryId/settings')
    @ApiOperation({
        summary: 'Update repository settings for CLI configuration',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    async updateRepositorySettings(
        @Param('repositoryId') repositoryId: string,
        @Body()
        body: {
            reviewEnabled: boolean;
            autoApproveEnabled: boolean;
            requestChangesMinSeverity: 'low' | 'medium' | 'high' | 'critical';
            ignoredFilePatterns: string[];
            baseBranchPatterns: string[];
            ignoredTitlePatterns: string[];
        },
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        this.ensureRepositoryConfigCapability(authContext);
        const context = this.toOrganizationAndTeamData(authContext);

        return this.updateCliRepositorySettingsUseCase.execute({
            repositoryId,
            organizationAndTeamData: context,
            settings: body,
        });
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

    private async ensureRepositorySettings(
        repositoryIds: string[],
        context: {
            organizationId: string;
            teamId: string;
        },
    ) {
        for (const repositoryId of repositoryIds) {
            await this.updateOrCreateCodeReviewParameterUseCase.execute({
                actor: {
                    source: 'cli',
                },
                configValue: {},
                organizationAndTeamData: context,
                repositoryId,
                skipAuthorization: true,
            });
        }
    }
}
