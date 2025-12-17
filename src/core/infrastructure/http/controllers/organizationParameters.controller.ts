import { CreateOrUpdateOrganizationParametersUseCase } from '@/core/application/use-cases/organizationParameters/create-or-update.use-case';
import { FindByKeyOrganizationParametersUseCase } from '@/core/application/use-cases/organizationParameters/find-by-key.use-case';
import {
    GetModelsByProviderUseCase,
    ModelResponse,
} from '@/core/application/use-cases/organizationParameters/get-models-by-provider.use-case';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import { ProviderService } from '@/core/infrastructure/adapters/services/providers/provider.service';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';

import { UserRequest } from '@/config/types/http/user-request.type';
import { DeleteByokConfigUseCase } from '@/core/application/use-cases/organizationParameters/delete-byok-config.use-case';
import {
    GET_COCKPIT_METRICS_VISIBILITY_USE_CASE_TOKEN,
    GetCockpitMetricsVisibilityUseCase,
} from '@/core/application/use-cases/organizationParameters/get-cockpit-metrics-visibility.use-case';
import { IgnoreBotsUseCase } from '@/core/application/use-cases/organizationParameters/ignore-bots.use-case';
import { UpdateAutoLicenseAllowedUsersUseCase } from '@/core/application/use-cases/organizationParameters/update-auto-license-allowed-users.use-case';
import { ICockpitMetricsVisibility } from '@/core/domain/organizationParameters/interfaces/cockpit-metrics-visibility.interface';
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
    CheckPolicies,
    PolicyGuard,
} from '../../adapters/services/permissions/policy.guard';
import { checkPermissions } from '../../adapters/services/permissions/policy.handlers';

@Controller('organization-parameters')
export class OrgnizationParametersController {
    constructor(
        private readonly createOrUpdateOrganizationParametersUseCase: CreateOrUpdateOrganizationParametersUseCase,
        private readonly findByKeyOrganizationParametersUseCase: FindByKeyOrganizationParametersUseCase,
        private readonly getModelsByProviderUseCase: GetModelsByProviderUseCase,
        private readonly providerService: ProviderService,
        private readonly deleteByokConfigUseCase: DeleteByokConfigUseCase,
        @Inject(GET_COCKPIT_METRICS_VISIBILITY_USE_CASE_TOKEN)
        private readonly getCockpitMetricsVisibilityUseCase: GetCockpitMetricsVisibilityUseCase,
        private readonly ignoreBotsUseCase: IgnoreBotsUseCase,
        private readonly updateAutoLicenseAllowedUsersUseCase: UpdateAutoLicenseAllowedUsersUseCase,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Post('/create-or-update')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.OrganizationSettings,
        }),
    )
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
    public async listModels(
        @Query('provider') provider: string,
    ): Promise<ModelResponse> {
        return await this.getModelsByProviderUseCase.execute(provider);
    }

    @Delete('/delete-byok-config')
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

    @Get('/cockpit-metrics-visibility')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.OrganizationSettings,
        }),
    )
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
            resource: ResourceType.OrganizationSettings,
        }),
    )
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
            resource: ResourceType.OrganizationSettings
        }),
    )
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
