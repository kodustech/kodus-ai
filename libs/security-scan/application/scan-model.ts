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

import type { SecurityScanModel } from './security-scan-engine';

export interface ResolvedScanModel {
    model: SecurityScanModel;
    /** Null when the model has no known price: then the scan is capped in tokens. */
    rates: ModelTokenRates | null;
}

/**
 * The model a scan runs on and what it costs, resolved the way a review
 * resolves its model: the organization's `securityScan` route (the model it
 * routes the deep scan to, else its default BYOK model, else the managed
 * default), priced by the catalog or the organization's own
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

    const priceKey = byokConfig?.model ?? main.modelName.split(':').pop();
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
            slot: byokConfig
                ? { ...byokConfig, fallback: undefined }
                : byokConfig,
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
        rates: pricing?.priced ? pricing.rates : null,
    };
}
