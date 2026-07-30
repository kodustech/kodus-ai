import { Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import {
    SpendLimitConfigError,
    SpendLimitPriceabilityError,
} from '@libs/analytics/domain/spend-limit/spend-limit.errors';
import { SpendLimitConfig } from '@libs/analytics/domain/spend-limit/spend-limit.types';
import { ManualPricingOverrides } from '@libs/analytics/domain/token-usage/types/pricing.types';

import { SpendLimitConfigService } from './spend-limit-config.service';

export interface ConfigureSpendLimitInput {
    organizationAndTeamData: OrganizationAndTeamData;
    enabled: boolean;
    monthlyLimitUsd: number;
    /** Org-entered per-model price overrides (per-token US$). */
    modelPricing?: ManualPricingOverrides;
    /**
     * Models to price-check before enabling — typically BYOK main + fallback
     * plus per-repo/directory overrides (see `collectByokModels`). Ignored
     * when disabling.
     */
    models?: string[];
}

/**
 * Configure an organization's monthly spend limit.
 *
 * Enabling is gated on priceability: every configured model must resolve to a
 * price (catalog or manual override), because a limit can't be enforced for
 * spend it can't measure. Per-period alert state is preserved across edits so
 * a limit change doesn't replay already-sent notifications.
 */
@Injectable()
export class ConfigureSpendLimitUseCase {
    constructor(private readonly configService: SpendLimitConfigService) {}

    async execute(input: ConfigureSpendLimitInput): Promise<SpendLimitConfig> {
        if (input.enabled) {
            if (!(input.monthlyLimitUsd > 0)) {
                throw new SpendLimitConfigError(
                    'A positive monthly limit is required to enable spend alerts.',
                );
            }

            const { priceable, unpriceable } =
                await this.configService.checkPriceability(
                    input.models ?? [],
                    input.modelPricing,
                );
            if (!priceable) {
                throw new SpendLimitPriceabilityError(unpriceable);
            }
        }

        const existing = await this.configService.getConfig(
            input.organizationAndTeamData,
        );

        const config: SpendLimitConfig = {
            enabled: input.enabled,
            monthlyLimitUsd: input.monthlyLimitUsd,
            modelPricing: input.modelPricing ?? existing?.modelPricing,
            thresholdsSent: existing?.thresholdsSent,
            finalNoticeSent: existing?.finalNoticeSent,
        };

        await this.configService.saveConfig(
            input.organizationAndTeamData,
            config,
        );

        return config;
    }
}
