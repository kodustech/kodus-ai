import { SpendLimitConfigService } from '@libs/analytics/application/spend-limit/spend-limit-config.service';
import { BuildUsageSummaryUseCase } from '@libs/analytics/application/use-cases/usage/build-usage-summary.use-case';
import { CostEstimateUseCase } from '@libs/analytics/application/use-cases/usage/cost-estimate.use-case';
import { TokenPricingUseCase } from '@libs/analytics/application/use-cases/usage/token-pricing.use-case';
import { TokensByDeveloperUseCase } from '@libs/analytics/application/use-cases/usage/tokens-developer.use-case';
import {
    ITokenUsageService,
    TOKEN_USAGE_SERVICE_TOKEN,
} from '@libs/analytics/domain/token-usage/contracts/tokenUsage.service.contract';
import {
    CostEstimateContract,
    DailyUsageByDeveloperResultContract,
    DailyUsageByPrResultContract,
    DailyUsageResultContract,
    TokenUsageQueryContract,
    UsageByAreaResultContract,
    UsageByDeveloperResultContract,
    UsageByPrResultContract,
    UsageByReviewResultContract,
    UsageSummaryReportContract,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    BadRequestException,
    Controller,
    Get,
    Inject,
    Query,
    Scope,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
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
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    TokenPricingQueryDto,
    TokenUsageQueryDto,
} from '../dtos/token-usage.dto';
import { ApiObjectResponseDto } from '../dtos/api-response.dto';
import {
    CostEstimateResponseDto,
    DailyUsageByDeveloperResponseDto,
    DailyUsageByPrResponseDto,
    DailyUsageResponseDto,
    UsageByAreaResponseDto,
    UsageByDeveloperResponseDto,
    UsageByPrResponseDto,
    UsageByReviewResponseDto,
    UsageSummaryResponseDto,
} from '../dtos/token-usage-response.dto';

@ApiTags('Token Usage')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@UseGuards(PolicyGuard)
@CheckPolicies(
    checkPermissions({
        action: Action.Read,
        resource: ResourceType.TokenUsage,
    }),
)
@Controller({ path: 'usage', scope: Scope.REQUEST })
export class TokenUsageController {
    constructor(
        @Inject(TOKEN_USAGE_SERVICE_TOKEN)
        private readonly tokenUsageService: ITokenUsageService,

        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly tokensByDeveloperUseCase: TokensByDeveloperUseCase,
        private readonly tokenPricingUseCase: TokenPricingUseCase,
        private readonly costEstimateUseCase: CostEstimateUseCase,
        private readonly buildUsageSummaryUseCase: BuildUsageSummaryUseCase,
        private readonly spendLimitConfigService: SpendLimitConfigService,
    ) {}

    @Get('tokens/summary')
    @ApiOperation({
        summary: 'Get token usage summary',
        description:
            'Return totals + total cost + per-model breakdown (with byTier and pricing source) for the selected period.',
    })
    @ApiOkResponse({ type: UsageSummaryResponseDto })
    async getSummary(
        @Query() query: TokenUsageQueryDto,
    ): Promise<UsageSummaryReportContract> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        const mapped = this.mapDtoToContract(query, organizationId);
        // Load the org's manual pricing overrides so the summary's totalCost
        // reconciles with the spend-limit widget, which also honors them.
        const config = await this.spendLimitConfigService.getConfig({
            organizationId,
            teamId: '',
        });
        return this.buildUsageSummaryUseCase.execute(
            mapped,
            config?.modelPricing,
        );
    }

    @Get('tokens/overview')
    @ApiOperation({
        summary: 'Get token usage overview (single request)',
        description:
            'Return summary (totals + cost + per-model) plus daily and by-PR series in ONE covered aggregation. Replaces the separate summary/daily/by-pr calls the screen used to fire.',
    })
    @ApiOkResponse({ type: UsageSummaryResponseDto })
    async getOverview(@Query() query: TokenUsageQueryDto) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        const mapped = this.mapDtoToContract(query, organizationId);
        const config = await this.spendLimitConfigService.getConfig({
            organizationId,
            teamId: '',
        });
        return this.buildUsageSummaryUseCase.executeOverview(
            mapped,
            config?.modelPricing,
        );
    }

    @Get('tokens/daily')
    @ApiOperation({
        summary: 'Get daily token usage',
        description: 'Return daily token usage for the selected period.',
    })
    @ApiOkResponse({ type: DailyUsageResponseDto })
    async getDaily(
        @Query() query: TokenUsageQueryDto,
    ): Promise<DailyUsageResultContract[]> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        const mapped = this.mapDtoToContract(query, organizationId);
        return this.tokenUsageService.getDailyUsage(mapped);
    }

    @Get('tokens/by-pr')
    @ApiOperation({
        summary: 'Get token usage by PR',
        description: 'Return token usage aggregated by pull request.',
    })
    @ApiOkResponse({ type: UsageByPrResponseDto })
    async getUsageByPr(
        @Query() query: TokenUsageQueryDto,
    ): Promise<UsageByPrResultContract[]> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        const mapped = this.mapDtoToContract(query, organizationId);
        return await this.tokenUsageService.getUsageByPr(mapped);
    }

    @Get('tokens/daily-by-pr')
    @ApiOperation({
        summary: 'Get daily token usage by PR',
        description: 'Return daily token usage aggregated by pull request.',
    })
    @ApiOkResponse({ type: DailyUsageByPrResponseDto })
    async getDailyUsageByPr(
        @Query() query: TokenUsageQueryDto,
    ): Promise<DailyUsageByPrResultContract[]> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        const mapped = this.mapDtoToContract(query, organizationId);
        return await this.tokenUsageService.getDailyUsageByPr(mapped);
    }

    @Get('tokens/by-review')
    @ApiOperation({
        summary: 'Get token usage by review run',
        description:
            'Return token usage aggregated per individual review run (correlationId). A PR reviewed more than once yields one row per run.',
    })
    @ApiOkResponse({ type: UsageByReviewResponseDto })
    async getUsageByReview(
        @Query() query: TokenUsageQueryDto,
    ): Promise<UsageByReviewResultContract[]> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        const mapped = this.mapDtoToContract(query, organizationId);
        return await this.tokenUsageService.getUsageByReview(mapped);
    }

    @Get('tokens/by-area')
    @ApiOperation({
        summary: 'Get token usage by process area',
        description:
            'Return token usage aggregated by the area of the review process that spent it (review, kody_rules, cross_file, …).',
    })
    @ApiOkResponse({ type: UsageByAreaResponseDto })
    async getUsageByArea(
        @Query() query: TokenUsageQueryDto,
    ): Promise<UsageByAreaResultContract[]> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        const mapped = this.mapDtoToContract(query, organizationId);
        return await this.tokenUsageService.getUsageByArea(mapped);
    }

    @Get('tokens/by-developer')
    @ApiOperation({
        summary: 'Get token usage by developer',
        description: 'Return token usage aggregated by developer.',
    })
    @ApiOkResponse({ type: UsageByDeveloperResponseDto })
    async getUsageByDeveloper(
        @Query() query: TokenUsageQueryDto,
    ): Promise<UsageByDeveloperResultContract[]> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        const mapped = this.mapDtoToContract(query, organizationId);
        return await this.tokensByDeveloperUseCase.execute(mapped, false);
    }

    @Get('tokens/daily-by-developer')
    @ApiOperation({
        summary: 'Get daily token usage by developer',
        description: 'Return daily token usage aggregated by developer.',
    })
    @ApiOkResponse({ type: DailyUsageByDeveloperResponseDto })
    async getDailyByDeveloper(
        @Query() query: TokenUsageQueryDto,
    ): Promise<DailyUsageByDeveloperResultContract[]> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        const mapped = this.mapDtoToContract(query, organizationId);
        return await this.tokensByDeveloperUseCase.execute(mapped, true);
    }

    @Get('tokens/pricing')
    @ApiOperation({
        summary: 'Get token pricing',
        description: 'Return token pricing for model/provider.',
    })
    @ApiOkResponse({ type: ApiObjectResponseDto })
    async getPricing(@Query() query: TokenPricingQueryDto) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        return await this.tokenPricingUseCase.execute(
            query.model,
            query.provider,
        );
    }

    @Get('tokens/pricing/batch')
    @ApiOperation({
        summary: 'Get token pricing for many models (single request)',
        description:
            'Resolve pricing for a comma-separated list of models in ONE request (LiteLLM catalog is fetched once). Replaces the per-model pricing N+1 the screen used to fire.',
    })
    @ApiOkResponse({ type: ApiObjectResponseDto })
    async getPricingBatch(
        @Query('models') models?: string,
        @Query('provider') provider?: string,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        const list = (models ?? '')
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean);
        // Cap the batch: an authenticated caller could otherwise send a huge
        // list and force an unbounded number of catalog lookups per request
        // (DoS). The screen only ever asks for the models in its breakdown.
        const MAX_BATCH_MODELS = 100;
        if (list.length > MAX_BATCH_MODELS) {
            throw new BadRequestException(
                `Too many models (max ${MAX_BATCH_MODELS} per request)`,
            );
        }
        return this.tokenPricingUseCase.executeMany(list, provider);
    }

    @Get('cost-estimate')
    @ApiOperation({
        summary: 'Get cost estimate',
        description: 'Return estimated token costs for the organization.',
    })
    @ApiOkResponse({ type: CostEstimateResponseDto })
    async getCostEstimate(): Promise<CostEstimateContract> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        return await this.costEstimateUseCase.execute(organizationId);
    }

    private mapDtoToContract(
        query: TokenUsageQueryDto,
        organizationId: string,
    ): TokenUsageQueryContract {
        const start = new Date(query.startDate);
        const end = new Date(query.endDate);

        // Detect if the original strings include an explicit time component
        const startDateHasTime =
            query.startDate?.includes('T') || query.startDate?.includes(':');
        const endDateHasTime =
            query.endDate?.includes('T') || query.endDate?.includes(':');

        // Normalize date-only inputs to UTC day boundaries
        if (!Number.isNaN(start.getTime()) && !startDateHasTime) {
            start.setUTCHours(0, 0, 0, 0);
        }
        if (!Number.isNaN(end.getTime()) && !endDateHasTime) {
            end.setUTCHours(23, 59, 59, 999);
        }

        const normalized = query.byok.trim().toLowerCase();
        if (normalized !== 'true' && normalized !== 'false') {
            throw new BadRequestException(
                `byok must be a 'true' or 'false' string`,
            );
        }
        const byokBoolean = normalized === 'true';

        return {
            organizationId,
            prNumber: query.prNumber,
            start,
            end,
            timezone: query.timezone || 'UTC',
            developer: query.developer,
            repositoryId: query.repositoryId,
            models: query.models,
            byok: byokBoolean,
        };
    }
}
