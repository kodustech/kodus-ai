import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsIn,
    IsNumber,
    IsObject,
    IsOptional,
    IsString,
    Min,
} from 'class-validator';

import { ManualPricingOverrides } from '@libs/analytics/domain/token-usage/types/pricing.types';
import { SpendLimitScope } from '@libs/analytics/domain/spend-limit/spend-limit.types';

/**
 * Request contract for the "Budget & alerts" config on the BYOK screen. The
 * budget is ALERT-ONLY — enabling it never blocks a review, it only turns on the
 * monthly spend notifications. The persisted org-parameter key
 * (`SPEND_LIMIT_CONFIG`) and this request shape are unchanged; the rename is
 * copy/vocabulary only.
 */
export class UpdateSpendLimitDto {
    @IsBoolean()
    @ApiProperty({
        description:
            'Whether the monthly budget alerts are enabled. Alert-only — this ' +
            'never blocks a review.',
    })
    enabled: boolean;

    @IsNumber()
    @Min(0)
    @ApiProperty({ description: 'Monthly budget in US$ (the alert threshold base).' })
    monthlyLimitUsd: number;

    @IsOptional()
    @IsIn(['total', 'per-model', 'per-credential'])
    @ApiPropertyOptional({
        description:
            'Preferred budget readout scope: total (default), per-model, or ' +
            'per-credential. Readout only — no scope introduces blocking; the ' +
            'budget stays alert-only.',
        enum: ['total', 'per-model', 'per-credential'],
    })
    scope?: SpendLimitScope;

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

/** Spend attributed to a single BYOK model (per-model scope readout). */
export class ModelSpendDto {
    @ApiProperty({ description: 'Model id the spend is attributed to.' })
    model: string;

    @ApiProperty({ description: 'Spend for this model over the period, US$.' })
    spentUsd: number;
}

/**
 * Spend attributed to a single BYOK credential (per-credential scope readout).
 * Derived in-app from the v2 config (model-name → credentialId); APPROXIMATE
 * when two credentials configure the same model-name (spend lands on one).
 * Unmatched spend uses the `unattributed` credentialId.
 */
export class CredentialSpendDto {
    @ApiProperty({
        description:
            'Credential id the spend is attributed to, or "unattributed" for ' +
            'spend whose model-name matches no configured model.',
    })
    credentialId: string;

    @ApiProperty({ description: 'Spend for this credential over the period, US$.' })
    spentUsd: number;
}

/** "At this pace ~$X/month" projection of month-to-date spend. Readout only. */
export class RunRateProjectionDto {
    @ApiProperty({
        description:
            'Extrapolated full-month spend at the current month-to-date pace, US$.',
    })
    projectedMonthlyUsd: number;

    @ApiProperty({
        description: 'Fraction of the calendar month elapsed (0..1).',
    })
    elapsedFraction: number;
}

/**
 * "Budget & alerts" status response: the month-to-date budget evaluation plus
 * the per-model / per-credential / total scope readouts and the run-rate
 * projection. Every figure is a readout — nothing here blocks a review.
 */
export class SpendLimitStatusResponseDto {
    @ApiProperty({ description: 'Total scope: month-to-date spend, US$.' })
    spentUsd: number;

    @ApiProperty({ description: 'Configured monthly budget, US$.' })
    limitUsd: number;

    @ApiProperty({ description: 'spentUsd / limitUsd as a percentage.' })
    pct: number;

    @ApiProperty({
        description: 'True once spend reaches the budget (alert-only, non-blocking).',
    })
    isOverLimit: boolean;

    @ApiProperty({
        description: 'Alert thresholds (%) the spend has reached, ascending.',
        type: [Number],
    })
    crossedThresholds: number[];

    @ApiProperty({ description: 'Calendar month the spend covers — YYYY-MM (UTC).' })
    periodKey: string;

    @ApiProperty({ description: 'Per-model scope readout.', type: [ModelSpendDto] })
    byModel: ModelSpendDto[];

    @ApiProperty({
        description: 'Per-credential scope readout (in-app derived; approximate on collision).',
        type: [CredentialSpendDto],
    })
    byCredential: CredentialSpendDto[];

    @ApiProperty({ description: 'Run-rate projection of the total to a full month.' })
    runRate: RunRateProjectionDto;
}
