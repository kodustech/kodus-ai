import { BYOKProvider } from '@kodus/kodus-common/llm';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { Inject, Injectable } from '@nestjs/common';

import {
    CURATED_CATALOG_PROVIDERS,
    GetModelsByProviderUseCase,
} from './get-models-by-provider.use-case';
import {
    collectModelOverrides,
    type CollectedModelOverride,
} from './model-overrides.util';

export interface ModelOverrideEntry extends CollectedModelOverride {
    /** True/false only when the current provider's catalog is available and
     *  non-empty; null when we can't judge (no catalog / listing unsupported)
     *  — so an unlistable provider never raises false alarms. */
    inCurrentProviderCatalog: boolean | null;
}

export interface ListModelOverridesResult {
    /** Current main BYOK provider, if configured. */
    provider?: string;
    overrides: ModelOverrideEntry[];
    /** Overrides we can confidently say don't match the current provider. */
    mismatchedCount: number;
}

/**
 * Enumerate every per-repo/dir `byokModel` override and flag which ones don't
 * match the org's CURRENT main BYOK provider's model catalog. Powers the
 * "these repos have overrides for your old provider" banner after a provider
 * change. Best-effort: an unavailable catalog yields `inCurrentProviderCatalog:
 * null` (no false alarms) rather than flagging everything.
 */
@Injectable()
export class ListModelOverridesUseCase {
    private readonly logger = createLogger(ListModelOverridesUseCase.name);

    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly getModelsByProviderUseCase: GetModelsByProviderUseCase,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ListModelOverridesResult> {
        const codeReviewConfig = await this.parametersService
            .findByKey(ParametersKey.CODE_REVIEW_CONFIG, organizationAndTeamData)
            .then((p) => p?.configValue ?? null)
            .catch(() => null);

        const overrides = collectModelOverrides(codeReviewConfig);
        if (overrides.length === 0) {
            return { overrides: [], mismatchedCount: 0 };
        }

        const provider = await this.resolveMainProvider(
            organizationAndTeamData,
        );

        const catalogIds = provider
            ? await this.loadCatalogIds(provider, organizationAndTeamData)
            : null;

        // Bedrock/Vertex catalogs are curated (not exhaustive), so a miss there
        // can't be judged a mismatch — leave those as null rather than flagging
        // a valid-but-unlisted override for clearing.
        const isCurated =
            !!provider &&
            CURATED_CATALOG_PROVIDERS.has(provider as BYOKProvider);

        const entries: ModelOverrideEntry[] = overrides.map((o) => ({
            ...o,
            inCurrentProviderCatalog: catalogIds
                ? catalogIds.has(o.model)
                    ? true
                    : isCurated
                      ? null
                      : false
                : null,
        }));

        return {
            provider,
            overrides: entries,
            mismatchedCount: entries.filter(
                (e) => e.inCurrentProviderCatalog === false,
            ).length,
        };
    }

    private async resolveMainProvider(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string | undefined> {
        const byok = await this.organizationParametersService
            .findByKey(
                OrganizationParametersKey.BYOK_CONFIG,
                organizationAndTeamData,
            )
            .then((p) => p?.configValue as { main?: { provider?: string } })
            .catch(() => undefined);
        return byok?.main?.provider;
    }

    /** Catalog ids for the provider, or null when listing is unavailable
     *  (unsupported provider, network error, empty list) — never throw. */
    private async loadCatalogIds(
        provider: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<Set<string> | null> {
        try {
            const res = await this.getModelsByProviderUseCase.execute(
                provider,
                organizationAndTeamData,
            );
            if (!res.models?.length) return null;
            return new Set(res.models.map((m) => m.id));
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not load provider model catalog for override validation',
                context: ListModelOverridesUseCase.name,
                error: error as Error,
                metadata: { provider },
            });
            return null;
        }
    }
}
