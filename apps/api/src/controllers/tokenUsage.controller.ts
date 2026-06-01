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
    UsageByDeveloperResultContract,
    UsageByPrResultContract,
    UsageSummaryContract,
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
    UsageByDeveloperResponseDto,
    UsageByPrResponseDto,
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
    ) {}

    @Get('tokens/summary')
    @ApiOperation({
        summary: 'Get token usage summary',
        description: 'Return aggregated token usage for the selected period.',
    })
    @ApiOkResponse({ type: UsageSummaryResponseDto })
    async getSummary(
        @Query() query: TokenUsageQueryDto,
    ): Promise<UsageSummaryContract> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException('organizationId not found in request');
        }

        const mapped = this.mapDtoToContract(query, organizationId);
        return this.tokenUsageService.getSummary(mapped);
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
            models: query.models,
            byok: byokBoolean,
        };
    }
}
