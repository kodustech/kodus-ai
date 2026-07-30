import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsObject, IsOptional, IsString, Min } from 'class-validator';

import { ManualPricingOverrides } from '@libs/analytics/domain/token-usage/types/pricing.types';

export class UpdateSpendLimitDto {
    @IsBoolean()
    @ApiProperty({ description: 'Whether monthly spend alerts are enabled.' })
    enabled: boolean;

    @IsNumber()
    @Min(0)
    @ApiProperty({ description: 'Monthly spend limit in US$.' })
    monthlyLimitUsd: number;

    @IsOptional()
    @IsObject()
    @ApiPropertyOptional({
        description:
            'Per-model manual price overrides, keyed by model id. Each entry has per-token US$ rates: { input, output, cacheRead, cacheWrite }.',
    })
    modelPricing?: ManualPricingOverrides;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        description:
            'Team whose code-review config is swept for per-repo/directory model overrides during the priceability check.',
    })
    teamId?: string;
}
