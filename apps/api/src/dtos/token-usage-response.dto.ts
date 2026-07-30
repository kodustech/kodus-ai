import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

export class TierUsageDto {
    @ApiProperty() input: number;
    @ApiProperty() output: number;
    @ApiProperty() total: number;
    @ApiProperty() outputReasoning: number;
    @ApiProperty() cacheRead: number;
    @ApiProperty() cacheWrite: number;
}

export class ByTierUsageDto {
    @ApiProperty({ type: TierUsageDto, description: 'Calls at or below the model threshold.' })
    le: TierUsageDto;

    @ApiProperty({ type: TierUsageDto, description: 'Calls above the model threshold.' })
    gt: TierUsageDto;
}

export class TokenUsageBaseDto {
    @ApiProperty()
    input: number;

    @ApiProperty()
    output: number;

    @ApiProperty()
    total: number;

    @ApiProperty()
    outputReasoning: number;

    @ApiPropertyOptional({
        description: 'Input tokens served from provider prompt cache.',
    })
    cacheRead?: number;

    @ApiPropertyOptional({
        description:
            'Input tokens that created cache entries on this call (Anthropic).',
    })
    cacheWrite?: number;

    @ApiProperty()
    model: string;

    @ApiPropertyOptional({
        type: ByTierUsageDto,
        description:
            'Per-tier breakdown. Present only for tier-aware models (e.g. Gemini Pro >200K). Flat-priced models omit it.',
    })
    byTier?: ByTierUsageDto;
}

export class CostBreakdownDto {
    @ApiProperty({ description: 'USD spent on uncached input tokens.' })
    input: number;

    @ApiProperty({ description: 'USD spent on output tokens (includes reasoning).' })
    output: number;

    @ApiProperty({ description: 'USD spent on cache-read tokens (discounted).' })
    cacheRead: number;

    @ApiProperty({ description: 'USD spent on cache-write tokens (Anthropic).' })
    cacheWrite: number;

    @ApiProperty({ description: 'Sum of input + output + cacheRead + cacheWrite.' })
    total: number;
}

export class CostByTierDto {
    @ApiProperty({ type: CostBreakdownDto }) le: CostBreakdownDto;
    @ApiProperty({ type: CostBreakdownDto }) gt: CostBreakdownDto;
}

export class EnrichedModelUsageDto extends TokenUsageBaseDto {
    @ApiProperty({ type: CostBreakdownDto })
    cost: CostBreakdownDto;

    @ApiPropertyOptional({
        type: CostByTierDto,
        description:
            'Cost split by tier. Present only when this row has a byTier breakdown.',
    })
    costByTier?: CostByTierDto;

    @ApiProperty({
        enum: ['manual', 'catalog', 'missing'],
        description:
            '`missing` means we could not price this model — the UI should surface a warning and exclude it from totals.',
    })
    pricingSource: 'manual' | 'catalog' | 'missing';
}

export class UsageSummaryDataDto {
    @ApiProperty({
        type: TokenUsageBaseDto,
        description: 'Flat totals across every model and tier in the period.',
    })
    totals: TokenUsageBaseDto;

    @ApiProperty({
        type: CostBreakdownDto,
        description: 'Aggregated cost across every model.',
    })
    totalCost: CostBreakdownDto;

    @ApiProperty({
        type: EnrichedModelUsageDto,
        isArray: true,
        description: 'One row per model, with its byTier and cost.',
    })
    byModel: EnrichedModelUsageDto[];
}

export class UsageSummaryResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: UsageSummaryDataDto })
    data: UsageSummaryDataDto;
}

export class DailyUsageDto extends TokenUsageBaseDto {
    @ApiProperty()
    date: string;
}

export class DailyUsageResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: DailyUsageDto, isArray: true })
    data: DailyUsageDto[];
}

export class UsageByPrDto extends TokenUsageBaseDto {
    @ApiProperty()
    prNumber: number;
}

export class UsageByPrResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: UsageByPrDto, isArray: true })
    data: UsageByPrDto[];
}

export class DailyUsageByPrDto extends UsageByPrDto {
    @ApiProperty()
    date: string;
}

export class DailyUsageByPrResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: DailyUsageByPrDto, isArray: true })
    data: DailyUsageByPrDto[];
}

export class UsageByReviewDto extends TokenUsageBaseDto {
    @ApiProperty({ description: "The review run's correlation id" })
    review: string;

    @ApiProperty({ required: false })
    prNumber?: number;

    @ApiProperty({ required: false })
    startedAt?: string;
}

export class UsageByReviewResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: UsageByReviewDto, isArray: true })
    data: UsageByReviewDto[];
}

export class UsageByAreaDto extends TokenUsageBaseDto {
    @ApiProperty({ description: 'Process area (review, kody_rules, …)' })
    area: string;
}

export class UsageByAreaResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: UsageByAreaDto, isArray: true })
    data: UsageByAreaDto[];
}

export class UsageByDeveloperDto extends TokenUsageBaseDto {
    @ApiProperty()
    developer: string;
}

export class UsageByDeveloperResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: UsageByDeveloperDto, isArray: true })
    data: UsageByDeveloperDto[];
}

export class DailyUsageByDeveloperDto extends UsageByDeveloperDto {
    @ApiProperty()
    date: string;
}

export class DailyUsageByDeveloperResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: DailyUsageByDeveloperDto, isArray: true })
    data: DailyUsageByDeveloperDto[];
}

export class TokenUsageTotalsDto {
    @ApiProperty()
    inputTokens: number;

    @ApiProperty()
    outputTokens: number;

    @ApiProperty()
    reasoningTokens: number;

    @ApiProperty()
    totalTokens: number;

    @ApiProperty({
        required: false,
        description: 'Input tokens served from provider prompt cache.',
    })
    cacheReadTokens?: number;

    @ApiProperty({
        required: false,
        description:
            'Input tokens that created cache entries on this call (Anthropic).',
    })
    cacheWriteTokens?: number;
}

export class CostEstimateDataDto {
    @ApiProperty()
    estimatedMonthlyCost: number;

    @ApiProperty()
    costPerDeveloper: number;

    @ApiProperty()
    developerCount: number;

    @ApiProperty({ type: TokenUsageTotalsDto })
    tokenUsage: TokenUsageTotalsDto;

    @ApiProperty()
    periodDays: number;

    @ApiProperty()
    projectionDays: number;
}

export class CostEstimateResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: CostEstimateDataDto })
    data: CostEstimateDataDto;
}
