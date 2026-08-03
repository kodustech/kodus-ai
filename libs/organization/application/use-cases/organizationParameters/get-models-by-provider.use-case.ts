import { BYOKProvider } from '@libs/llm/model-providers';
import { REGISTRY } from '@libs/llm/providers';
import type { CatalogModel } from '@libs/llm/providers/kernel/types';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ProviderService } from '@libs/core/infrastructure/services/providers/provider.service';
import { createLogger } from '@libs/core/log/logger';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import axios from 'axios';

import { resolveByokSlot } from './byok-credentials.util';
import { assertSafeOpenAICompatibleUrl } from './test-byok-connection.use-case';

/**
 * Providers whose model list is a CURATED static catalog (not fetched live), so
 * it isn't exhaustive — a model missing from it is NOT proof the model is
 * invalid. Callers must not treat a miss as a hard mismatch/failure for these.
 *
 * Derived from the registry (`modelListing.kind === 'static'`) so a new curated
 * provider is covered automatically — no second place to edit.
 */
export const CURATED_CATALOG_PROVIDERS: ReadonlySet<BYOKProvider> = new Set(
    REGISTRY.all()
        .filter((m) => m.modelListing?.(m.id)?.kind === 'static')
        .map((m) => m.id as BYOKProvider),
);

export interface ModelResponse {
    provider: BYOKProvider;
    models: CatalogModel[];
}

/**
 * Lists the models available for a BYOK provider — registry-driven. Each
 * provider module declares HOW to enumerate its models via a pure `modelListing`
 * descriptor (a static catalog, or a `/models` URL + headers + parse); this
 * use-case owns only the cross-cutting concerns the descriptor stays free of:
 * credential resolution, the SSRF gate, and the HTTP call.
 */
@Injectable()
export class GetModelsByProviderUseCase {
    private readonly logger = createLogger(GetModelsByProviderUseCase.name);

    constructor(
        private readonly providerService: ProviderService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async execute(
        provider: string,
        organizationAndTeamData?: OrganizationAndTeamData,
    ): Promise<ModelResponse> {
        if (!this.providerService.isProviderSupported(provider)) {
            throw new BadRequestException(`Unsupported provider: ${provider}`);
        }

        const byokProvider = provider as BYOKProvider;

        const providerModule = REGISTRY.has(provider)
            ? REGISTRY.get(provider)
            : null;
        const listing = providerModule?.modelListing?.(provider) ?? null;

        if (!listing || listing.kind === 'manual') {
            throw new BadRequestException(
                `Model listing is not available for ${provider} — enter the model ID manually.`,
            );
        }

        if (listing.kind === 'static') {
            return { provider: byokProvider, models: listing.models };
        }

        // Prefer the org's OWN saved BYOK credentials so the catalog reflects the
        // user's actual endpoint/key (e.g. an openai_compatible proxy like
        // Moonshot) rather than Kodus' bundled env keys. Falls back to the
        // descriptor's env vars when no saved slot matches (e.g. setup wizard).
        const creds = await resolveByokSlot(
            this.organizationParametersService,
            byokProvider,
            organizationAndTeamData,
        );

        const apiKey =
            creds?.apiKey ??
            (listing.apiKeyEnv ? process.env[listing.apiKeyEnv] : undefined);
        const baseURL =
            creds?.baseURL ??
            (listing.baseURLEnv
                ? process.env[listing.baseURLEnv] || undefined
                : undefined) ??
            listing.defaultBaseURL;

        if (listing.requiresBaseURL) {
            if (!baseURL) {
                throw new BadRequestException(
                    `baseURL is required for ${provider}.`,
                );
            }
            // SSRF guard: a stored baseURL is user-controlled, so reject
            // private/reserved IPs, the cloud metadata endpoint, and non-https
            // before the request — the same guard the connection probe uses.
            await assertSafeOpenAICompatibleUrl(baseURL);
        }

        try {
            const response = await axios.get(listing.url({ apiKey, baseURL }), {
                headers: listing.headers({ apiKey, baseURL }),
                // baseURL-driven providers: never follow redirects (a public URL
                // could 302 onto a private IP / metadata endpoint past the guard).
                ...(listing.requiresBaseURL ? { maxRedirects: 0 } : {}),
                ...(listing.timeoutMs ? { timeout: listing.timeoutMs } : {}),
            });

            return {
                provider: byokProvider,
                models: listing.parse(response.data),
            };
        } catch (error) {
            throw new BadRequestException(
                `Error fetching ${provider} models: ${(error as Error).message}`,
            );
        }
    }
}
