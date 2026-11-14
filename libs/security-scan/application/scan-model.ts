import type {
    ModelTokenRates,
    ManualPricingOverrides,
} from '@libs/analytics/domain/token-usage/types/pricing.types';
import type { PricingResolver } from '@libs/analytics/application/use-cases/usage/pricing-resolver';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { resolveReviewAgentModel } from '@libs/code-review/infrastructure/agents/collaborators/model-factory';
import { resolveContextWindow } from '@libs/llm/model-context-window';
import { LLM_TASK } from '@libs/llm/byok-config';
import { BYOKProvider } from '@libs/llm/model-providers';
import { asServedSlot } from '@libs/llm/served-slot';

import type { SecurityScanModel } from './security-scan-engine';

/**
 * The deep scan runs only on a model with the organization's own key (BYOK):
 * never on the managed model, nor on the Kodus provider, whose platform key
 * draws prepaid credits the scan does not check. A whole-repository scan is
 * the organization's own spend.
 */
export const SCAN_NEEDS_BYOK_MESSAGE =
    'Deep scan runs only on a model with your own API key, not on the Kodus provider. Connect one in AI providers to run it; you can route the Deep scan to a model of its own there.';

export interface ResolvedScanModel {
    model: SecurityScanModel;
    /** Null when the model has no known price: then the scan is capped in tokens. */
    rates: ModelTokenRates | null;
}

/**
 * The model a scan runs on and what it costs, resolved the way a review
 * resolves its model: the organization's `securityScan` route (the model it
 * routes the deep scan to, else its default BYOK model; without one the
 * slot is empty and the scan refuses to run, SCAN_NEEDS_BYOK_MESSAGE),
 * priced by the catalog or the organization's own
 * price for it. Shared by the API (to validate the cap), the job and the eval.
 */
export async function resolveScanModel(params: {
    organizationAndTeamData: OrganizationAndTeamData;
    permissionValidationService: PermissionValidationService;
    pricingResolver: Pick<PricingResolver, 'resolve'>;
    pricingOverrides?: ManualPricingOverrides;
}): Promise<ResolvedScanModel> {
    const { byokConfig, main } = await resolveReviewAgentModel(
        { organizationAndTeamData: params.organizationAndTeamData },
        params.permissionValidationService,
        LLM_TASK.securityScan,
    );

    const priceKey = byokConfig
        ? asServedSlot(byokConfig).model
        : main.modelName.split(':').pop();
    const pricing = priceKey
        ? await params.pricingResolver
              .resolve(priceKey, params.pricingOverrides)
              .catch(() => null)
        : null;

    return {
        model: {
            // No failover to the organization's backup model: the spend cap
            // prices every request at this model's rates, and a pricier
            // fallback would spend past it uncounted.
            // Empty unless the organization's own key runs it: the start and
            // the job refuse to scan on anything else.
            slot:
                byokConfig && byokConfig.provider !== BYOKProvider.KODUS
                    ? { ...byokConfig, fallback: undefined }
                    : undefined,
            modelName: main.modelName,
            contextWindowTokens: resolveContextWindow({
                byokMaxInputTokens: main.maxInputTokens,
                modelName: main.modelName,
            }),
            reasoningEffort: main.reasoningEffort,
            reasoningConfigOverride: main.reasoningConfigOverride,
            byokProvider: main.byokProvider,
            openrouterProviderOrder: main.openrouterProviderOrder,
            openrouterAllowFallbacks: main.openrouterAllowFallbacks,
        },
        // A price with a rate missing, negative or not a number prices
        // every request at NaN, which no cap ever crosses: no price at all.
        rates:
            pricing?.priced && usableRates(pricing.rates)
                ? pricing.rates
                : null,
    };
}

function usableRates(rates: ModelTokenRates | undefined): boolean {
    const usable = (n: unknown) =>
        typeof n === 'number' && Number.isFinite(n) && n >= 0;
    return (
        !!rates &&
        [rates.input, rates.output, rates.cacheRead, rates.cacheWrite].every(
            (rate) =>
                !!rate &&
                usable(rate.default) &&
                (rate.tiers ?? []).every(
                    (t) => usable(t.rate) && usable(t.threshold),
                ),
        )
    );
}
