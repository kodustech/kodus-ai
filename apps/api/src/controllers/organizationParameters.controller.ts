import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import {
    checkAnyPermission,
    checkPermissions,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { IgnoreBotsUseCase } from '@libs/organization/application/use-cases/organizationParameters/ignore-bots.use-case';
import { CreateOrUpdateOrganizationParametersUseCase } from '@libs/organization/application/use-cases/organizationParameters/create-or-update.use-case';
import { FindByKeyOrganizationParametersUseCase } from '@libs/organization/application/use-cases/organizationParameters/find-by-key.use-case';
import {
    GetModelsByProviderUseCase,
    ModelResponse,
} from '@libs/organization/application/use-cases/organizationParameters/get-models-by-provider.use-case';
import { DeleteByokConfigUseCase } from '@libs/organization/application/use-cases/organizationParameters/delete-byok-config.use-case';
import {
    GetLLMConfigStatusUseCase,
    LLMConfigStatus,
} from '@libs/organization/application/use-cases/organizationParameters/get-llm-config-status.use-case';
import {
    TestByokConnectionUseCase,
    TestByokResult,
} from '@libs/organization/application/use-cases/organizationParameters/test-byok-connection.use-case';
import { TestByokModelUseCase } from '@libs/organization/application/use-cases/organizationParameters/test-byok-model.use-case';
import {
    ListModelOverridesUseCase,
    ListModelOverridesResult,
} from '@libs/organization/application/use-cases/organizationParameters/list-model-overrides.use-case';
import { ClearModelOverridesUseCase } from '@libs/organization/application/use-cases/organizationParameters/clear-model-overrides.use-case';
import {
    GetCockpitMetricsVisibilityUseCase,
    GET_COCKPIT_METRICS_VISIBILITY_USE_CASE_TOKEN,
} from '@libs/organization/application/use-cases/organizationParameters/get-cockpit-metrics-visibility.use-case';
import { UpdateAutoLicenseAllowedUsersUseCase } from '@libs/platform/application/use-cases/codeManagement/update-auto-license-allowed-users.use-case';
import { ICockpitMetricsVisibility } from '@libs/organization/domain/organizationParameters/interfaces/cockpit-metrics-visibility.interface';

import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Inject,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ApiBody,
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiNoContentResponse,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { ProviderService } from '@libs/core/infrastructure/services/providers/provider.service';
import {
    OrganizationMetricsVisibilityResponseDto,
    OrganizationParameterStoredResponseDto,
    OrganizationProviderModelsResponseDto,
    OrganizationProvidersResponseDto,
} from '../dtos/organization-parameters-response.dto';
import { ApiBooleanResponseDto } from '../dtos/api-response.dto';

@ApiTags('Organization Parameters')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('organization-parameters')
export class OrganizationParametersController {
    constructor(
        private readonly createOrUpdateOrganizationParametersUseCase: CreateOrUpdateOrganizationParametersUseCase,
        private readonly findByKeyOrganizationParametersUseCase: FindByKeyOrganizationParametersUseCase,
        private readonly getModelsByProviderUseCase: GetModelsByProviderUseCase,
        private readonly providerService: ProviderService,
        private readonly deleteByokConfigUseCase: DeleteByokConfigUseCase,
        private readonly getLLMConfigStatusUseCase: GetLLMConfigStatusUseCase,
        private readonly testByokConnectionUseCase: TestByokConnectionUseCase,
        private readonly testByokModelUseCase: TestByokModelUseCase,
        private readonly listModelOverridesUseCase: ListModelOverridesUseCase,
        private readonly clearModelOverridesUseCase: ClearModelOverridesUseCase,
        @Inject(GET_COCKPIT_METRICS_VISIBILITY_USE_CASE_TOKEN)
        private readonly getCockpitMetricsVisibilityUseCase: GetCockpitMetricsVisibilityUseCase,
        private readonly ignoreBotsUseCase: IgnoreBotsUseCase,
        private readonly updateAutoLicenseAllowedUsersUseCase: UpdateAutoLicenseAllowedUsersUseCase,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Post('/create-or-update')
    @ApiBody({
        schema: {
            type: 'object',
            required: ['key', 'configValue'],
            properties: {
                key: {
                    type: 'string',
                    enum: Object.values(OrganizationParametersKey),
                },
                configValue: {
                    type: 'object',
                },
            },
            example: {
                key: OrganizationParametersKey.REVIEW_MODE_CONFIG,
                configValue: {
                    mode: 'comment',
                    threshold: 'medium',
                },
            },
        },
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'Create or update organization parameter',
        description: 'Create or update an organization parameter key/value.',
    })
    @ApiOkResponse({ type: OrganizationParameterStoredResponseDto })
    public async createOrUpdate(
        @Body()
        body: {
            key: OrganizationParametersKey;
            configValue: any;
        },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return await this.createOrUpdateOrganizationParametersUseCase.execute(
            body.key,
            body.configValue,
            {
                organizationId,
            },
        );
    }

    @Get('/find-by-key')
    @ApiQuery({
        name: 'key',
        enum: OrganizationParametersKey,
        type: String,
        required: true,
    })
    @ApiOperation({
        summary: 'Find org parameter by key',
        description: 'Return an organization parameter configuration by key.',
    })
    @ApiOkResponse({ type: OrganizationParameterStoredResponseDto })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    public async findByKey(@Query('key') key: OrganizationParametersKey) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return await this.findByKeyOrganizationParametersUseCase.execute(key, {
            organizationId,
        });
    }

    @Get('/list-providers')
    @ApiOperation({
        summary: 'List providers',
        description: 'Return supported model providers.',
    })
    @ApiOkResponse({ type: OrganizationProvidersResponseDto })
    public async listProviders() {
        const providers = this.providerService.getAllProviders();
        return {
            providers: providers.map((provider) => ({
                id: provider.id,
                name: provider.name,
                description: provider.description,
                requiresApiKey: provider.requiresApiKey,
                requiresBaseUrl: provider.requiresBaseUrl,
            })),
        };
    }

    @Get('/list-models')
    @ApiOperation({
        summary: 'List models',
        description: 'Return supported models for a provider.',
    })
    @ApiOkResponse({ type: OrganizationProviderModelsResponseDto })
    public async listModels(
        @Query('provider') provider: string,
    ): Promise<ModelResponse> {
        const organizationId = this.request?.user?.organization?.uuid;
        return await this.getModelsByProviderUseCase.execute(
            provider,
            organizationId ? { organizationId } : undefined,
        );
    }

    @Delete('/delete-byok-config')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Delete,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'Delete BYOK config',
        description: 'Delete main or fallback BYOK configuration.',
    })
    @ApiQuery({
        name: 'configType',
        required: true,
        schema: { type: 'string', enum: ['main', 'fallback'] },
    })
    @ApiOkResponse({ type: ApiBooleanResponseDto })
    public async deleteByokConfig(
        @Query('configType') configType: 'main' | 'fallback',
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return await this.deleteByokConfigUseCase.execute(
            organizationId,
            configType,
        );
    }

    @Post('/test-byok')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiBody({
        schema: {
            type: 'object',
            required: ['provider'],
            properties: {
                provider: { type: 'string' },
                apiKey: { type: 'string' },
                baseURL: { type: 'string' },
                model: { type: 'string' },
                vertexLocation: { type: 'string' },
                awsBearerToken: { type: 'string' },
                awsAccessKeyId: { type: 'string' },
                awsSecretAccessKey: { type: 'string' },
                awsRegion: { type: 'string' },
                awsSessionToken: { type: 'string' },
            },
        },
    })
    @ApiOperation({
        summary: 'Test BYOK connection',
        description:
            'Probe the provider with the supplied credentials to verify they work. Uses cheap metadata / identity calls (list-models for most providers, GoogleAuth token exchange for Vertex, STS GetCallerIdentity for Bedrock) — no LLM inference is performed.',
    })
    public async testByokConnection(
        @Body()
        body: {
            provider: string;
            apiKey?: string;
            baseURL?: string;
            model?: string;
            vertexLocation?: string;
            awsBearerToken?: string;
            awsAccessKeyId?: string;
            awsSecretAccessKey?: string;
            awsRegion?: string;
            awsSessionToken?: string;
        },
    ): Promise<TestByokResult> {
        return await this.testByokConnectionUseCase.execute(body);
    }

    @Post('/test-byok-model')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiBody({
        schema: {
            type: 'object',
            required: ['provider', 'model'],
            properties: {
                provider: { type: 'string' },
                model: { type: 'string' },
            },
        },
    })
    @ApiOperation({
        summary: 'Test a BYOK model id',
        description:
            "Validate a model id against the org's SAVED BYOK provider (credentials resolved server-side). Surfaces the provider's real error (e.g. model-not-found) at config time instead of at review time.",
    })
    public async testByokModel(
        @Body() body: { provider: string; model: string },
    ): Promise<TestByokResult> {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException(
                'Organization ID is missing from request',
            );
        }
        return await this.testByokModelUseCase.execute({
            provider: body.provider,
            model: body.model,
            organizationAndTeamData: { organizationId },
        });
    }

    @Get('/model-overrides')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'List per-repo/dir BYOK model overrides',
        description:
            "Enumerate every code-review byokModel override and flag which don't match the org's current main BYOK provider — powers the provider-change banner.",
    })
    public async listModelOverrides(
        @Query('teamId') teamId?: string,
    ): Promise<ListModelOverridesResult> {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException(
                'Organization ID is missing from request',
            );
        }
        return await this.listModelOverridesUseCase.execute({
            organizationId,
            teamId,
        });
    }

    @Post('/model-overrides/clear')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiBody({
        schema: {
            type: 'object',
            required: ['targets'],
            properties: {
                teamId: { type: 'string' },
                targets: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            repositoryId: { type: 'string' },
                            directoryId: { type: 'string' },
                        },
                    },
                },
            },
        },
    })
    @ApiOperation({
        summary: 'Bulk-clear BYOK model overrides',
        description:
            'Reset byokModel to inherit ("") at the given repo/dir targets (no repositoryId = global). Only the byokModel field is touched.',
    })
    public async clearModelOverrides(
        @Body()
        body: {
            teamId?: string;
            targets?: Array<{ repositoryId?: string; directoryId?: string }>;
        },
    ): Promise<{ clearedCount: number }> {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException(
                'Organization ID is missing from request',
            );
        }
        return await this.clearModelOverridesUseCase.execute(
            { organizationId, teamId: body?.teamId },
            body?.targets ?? [],
        );
    }

    @Get('/llm-config/status')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        // Non-sensitive descriptor (never the API key). Code review settings
        // editors need the BYOK provider/model to render the model selector,
        // so allow either organization-settings or code-review-settings read.
        checkAnyPermission([
            {
                action: Action.Read,
                resource: ResourceType.OrganizationSettings,
            },
            {
                action: Action.Read,
                resource: ResourceType.CodeReviewSettings,
            },
        ]),
    )
    @ApiOperation({
        summary: 'Get LLM provider configuration status',
        description:
            'Return which LLM configuration source is active (BYOK, env, or none) and a non-sensitive descriptor of each source. Never returns the API key itself.',
    })
    public async getLLMConfigStatus(): Promise<LLMConfigStatus> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('Missing organizationId in request');
        }

        return await this.getLLMConfigStatusUseCase.execute({
            organizationId,
        });
    }

    @Get('/cockpit-metrics-visibility')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.Cockpit,
        }),
    )
    @ApiOperation({
        summary: 'Get cockpit metrics visibility',
        description: 'Return cockpit metrics visibility configuration.',
    })
    @ApiOkResponse({ type: OrganizationMetricsVisibilityResponseDto })
    public async getCockpitMetricsVisibility(): Promise<ICockpitMetricsVisibility> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return await this.getCockpitMetricsVisibilityUseCase.execute({
            organizationId,
        });
    }

    @Post('/cockpit-metrics-visibility')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.Cockpit,
        }),
    )
    @ApiOperation({
        summary: 'Update cockpit metrics visibility',
        description: 'Persist cockpit metrics visibility configuration.',
    })
    @ApiCreatedResponse({ type: OrganizationParameterStoredResponseDto })
    public async updateCockpitMetricsVisibility(
        @Body()
        body: {
            teamId?: string;
            config: ICockpitMetricsVisibility;
        },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return await this.createOrUpdateOrganizationParametersUseCase.execute(
            OrganizationParametersKey.COCKPIT_METRICS_VISIBILITY,
            body.config,
            {
                organizationId,
                teamId: body.teamId,
            },
        );
    }

    @Post('/ignore-bots')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'Ignore bot users',
        description: 'Mark bot users to be ignored in auto-licensing.',
    })
    @ApiNoContentResponse({ description: 'Bots ignored successfully' })
    public async ignoreBots(
        @Body()
        body: {
            teamId: string;
        },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('Missing organizationId in request');
        }

        return await this.ignoreBotsUseCase.execute({
            organizationId,
            teamId: body.teamId,
        });
    }

    @Post('/auto-license/allowed-users')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'Update auto-license allowed users',
        description:
            'Ensure allowed users include the current user when requested.',
    })
    @ApiCreatedResponse({ type: ApiBooleanResponseDto })
    public async updateAutoLicenseAllowedUsers(
        @Body()
        body: {
            teamId?: string;
            includeCurrentUser?: boolean;
            organizationId?: string;
        },
    ) {
        const organizationId =
            body.organizationId || this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('Missing organizationId in request');
        }

        return await this.updateAutoLicenseAllowedUsersUseCase.execute({
            organizationAndTeamData: {
                organizationId,
                teamId: body.teamId,
            },
            includeCurrentUser: body.includeCurrentUser,
        });
    }
}
