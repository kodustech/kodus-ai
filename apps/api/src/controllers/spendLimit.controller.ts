import { ConfigureSpendLimitUseCase } from '@libs/analytics/application/spend-limit/configure-spend-limit.use-case';
import { GetOrgByokModelsUseCase } from '@libs/analytics/application/spend-limit/get-org-byok-models.use-case';
import { GetSpendLimitConfigUseCase } from '@libs/analytics/application/spend-limit/get-spend-limit-config.use-case';
import { SpendLimitConfigService } from '@libs/analytics/application/spend-limit/spend-limit-config.service';
import {
    SpendLimitConfigError,
    SpendLimitPriceabilityError,
} from '@libs/analytics/domain/spend-limit/spend-limit.errors';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Inject,
    Post,
    Query,
    Scope,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { UpdateSpendLimitDto } from '../dtos/spend-limit.dto';

@ApiTags('Spend Limit')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@UseGuards(PolicyGuard)
@Controller({ path: 'spend-limit', scope: Scope.REQUEST })
export class SpendLimitController {
    constructor(
        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly getSpendLimitConfigUseCase: GetSpendLimitConfigUseCase,
        private readonly configureSpendLimitUseCase: ConfigureSpendLimitUseCase,
        private readonly getOrgByokModelsUseCase: GetOrgByokModelsUseCase,
        private readonly spendLimitConfigService: SpendLimitConfigService,
    ) {}

    @Get('status')
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.TokenUsage,
        }),
    )
    @ApiOperation({
        summary: 'Month-to-date BYOK spend vs the configured limit',
        description:
            'Returns the current evaluation (spent / limit / pct / over) for ' +
            'the usage page, or null when no enabled limit is configured.',
    })
    async status() {
        return this.spendLimitConfigService.evaluate(this.resolveOrg());
    }

    @Get()
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get the monthly spend-limit config and resolved model prices',
        description:
            'Returns the current spend-limit config plus the resolved price ' +
            '(catalog/manual/none) for every BYOK model the org could run, so ' +
            'the UI can show found prices and warn about unpriceable models.',
    })
    async get(@Query('teamId') teamId?: string) {
        return this.getSpendLimitConfigUseCase.execute(
            this.resolveOrg(teamId),
        );
    }

    @Post()
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Create or update the monthly spend-limit config',
        description:
            'Enabling is rejected (400) unless every configured BYOK model is ' +
            'priceable (catalog or manual override).',
    })
    async update(@Body() dto: UpdateSpendLimitDto) {
        const organizationAndTeamData = this.resolveOrg(dto.teamId);
        const models = await this.getOrgByokModelsUseCase.execute(
            organizationAndTeamData,
        );

        try {
            return await this.configureSpendLimitUseCase.execute({
                organizationAndTeamData,
                enabled: dto.enabled,
                monthlyLimitUsd: dto.monthlyLimitUsd,
                modelPricing: dto.modelPricing,
                models,
            });
        } catch (error) {
            if (error instanceof SpendLimitPriceabilityError) {
                throw new BadRequestException({
                    message: error.message,
                    unpriceableModels: error.unpriceableModels,
                });
            }
            if (error instanceof SpendLimitConfigError) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }
    }

    private resolveOrg(teamId?: string): OrganizationAndTeamData {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException(
                'organizationId not found in request',
            );
        }
        return { organizationId, teamId };
    }
}
