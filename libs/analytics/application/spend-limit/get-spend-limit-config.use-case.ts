import { Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import {
    ManualPricingOverrides,
    ResolvedModelPricing,
} from '@libs/analytics/domain/token-usage/types/pricing.types';

import { GetOrgByokModelsUseCase } from './get-org-byok-models.use-case';
import { PricingResolver } from '../use-cases/usage/pricing-resolver';
import { SpendLimitConfigService } from './spend-limit-config.service';

export interface SpendLimitConfigView {
    enabled: boolean;
    monthlyLimitUsd: number;
    /** Org-entered per-model price overrides (per-token US$). */
    modelPricing: ManualPricingOverrides;
    /** Resolved pricing per configured model — feeds the config UI's price
     *  display and the "no price found" warnings. */
    models: ResolvedModelPricing[];
    /** True when every configured model is priceable (the enablement gate). */
    priceable: boolean;
}

/**
 * Read model for the spend-limit config screen: the current config plus the
 * resolved price (catalog/manual/none) for every model the org could run, so
 * the UI can show the prices it found and warn about any it couldn't.
 */
@Injectable()
export class GetSpendLimitConfigUseCase {
    constructor(
        private readonly configService: SpendLimitConfigService,
        private readonly getOrgByokModels: GetOrgByokModelsUseCase,
        private readonly pricingResolver: PricingResolver,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<SpendLimitConfigView> {
        const config = await this.configService.getConfig(
            organizationAndTeamData,
        );
        const models = await this.getOrgByokModels.execute(
            organizationAndTeamData,
        );
        const resolved = await this.pricingResolver.resolveMany(
            models,
            config?.modelPricing,
        );
        // Resolve again against the catalog only, so each model carries its
        // catalog rates even when a manual override is currently active —
        // the UI uses these to revert an override back to catalog pricing.
        const catalogResolved = await this.pricingResolver.resolveMany(models);
        const catalogByModel = new Map(
            catalogResolved.map((r) => [r.model, r]),
        );

        const modelsWithCatalog = resolved.map((r) => {
            const catalog = catalogByModel.get(r.model);
            return {
                ...r,
                catalogRates: catalog?.priced ? catalog.rates : undefined,
            };
        });

        return {
            enabled: config?.enabled ?? false,
            monthlyLimitUsd: config?.monthlyLimitUsd ?? 0,
            modelPricing: config?.modelPricing ?? {},
            models: modelsWithCatalog,
            priceable: resolved.every((r) => r.priced),
        };
    }
}
