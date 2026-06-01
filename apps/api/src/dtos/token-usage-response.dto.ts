import { ApiProperty } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

export class TokenUsageBaseDto {
    @ApiProperty()
    input: number;

    @ApiProperty()
    output: number;

    @ApiProperty()
    total: number;

    @ApiProperty()
    outputReasoning: number;

    @ApiProperty({
        required: false,
        description: 'Input tokens served from provider prompt cache.',
    })
    cacheRead?: number;

    @ApiProperty({
        required: false,
        description:
            'Input tokens that created cache entries on this call (Anthropic).',
    })
    cacheWrite?: number;

    @ApiProperty()
    model: string;
}

export class UsageSummaryResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: TokenUsageBaseDto })
    data: TokenUsageBaseDto;
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
