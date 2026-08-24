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

import { isCustomEndpoint } from '@libs/llm/providers/provider-ui-descriptor';

import { resolveByokSlot } from './byok-credentials.util';
import { assertSafeOpenAICompatibleUrl } from './test-byok-connection.use-case';

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
        // A just-typed, UNSAVED credential from the connect form. Takes precedence
        // over the org's saved slot and env keys so the picker can live-list the
        // real models before the credential is persisted. When an apiKey is
        // supplied here, the http path is STRICT — a failed live call surfaces the
        // error instead of degrading to the curated placeholder (the user asked
        // for the real list, not a stand-in).
        candidate?: { apiKey?: string; baseURL?: string },
    ): Promise<ModelResponse> {
        if (!this.providerService.isProviderSupported(provider)) {
            throw new BadRequestException(`Unsupported provider: ${provider}`);
        }

        const byokProvider = provider as BYOKProvider;
        const candidateKey = candidate?.apiKey?.trim() || undefined;
        const candidateBaseURL = candidate?.baseURL?.trim() || undefined;

        const providerModule = REGISTRY.has(provider)
            ? REGISTRY.get(provider)
            : null;
        const listing = providerModule?.modelListing?.(provider) ?? null;

        // The provider module's curated catalog (the well-known models a brand
        // ships), mapped to the response shape. It's the fallback whenever a live
        // `/models` call can't run — no listing / a `manual` listing, no key yet,
        // or the fetch failed — so the picker lists a curated brand's models
        // instead of forcing hand-entry. The live list takes over once possible.
        const curatedFallback = (): ModelResponse | null => {
            // A `*_compatible` custom endpoint points at the USER's own proxy —
            // it is NOT the brand, so the brand's curated catalog (reached via the
            // module alias) must not stand in for the user's real model list.
            if (isCustomEndpoint(provider)) return null;
            const curated = providerModule?.catalog;
            if (!curated?.length) return null;
            return {
                provider: byokProvider,
                models: curated.map((m) => ({ id: m.id, name: m.displayName })),
            };
        };

        if (!listing || listing.kind === 'manual') {
            // A curated brand with a manual listing (e.g. Z.ai/GLM over the
            // Anthropic protocol) still enumerates its curated models.
            const curated = curatedFallback();
            if (curated) return curated;
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

        // A just-typed connect-form key wins over the saved slot and env keys, so
        // the picker lists the models THAT key can actually reach before it's saved.
        const apiKey =
            candidateKey ??
            creds?.apiKey ??
            (listing.apiKeyEnv ? process.env[listing.apiKeyEnv] : undefined);
        const baseURL =
            candidateBaseURL ??
            creds?.baseURL ??
            (listing.baseURLEnv
                ? process.env[listing.baseURLEnv] || undefined
                : undefined) ??
            listing.defaultBaseURL;

        // No key yet — e.g. a NEW connect where the user hasn't typed or saved a
        // key, so nothing resolves. The live `/models` call would 401, so fall
        // back to the curated catalog: the big providers (OpenAI, …) still list
        // their known models keyless, and the live list takes over once a key is
        // supplied. Skipped when the caller passed a candidate key (strict live).
        if (!apiKey) {
            const curated = curatedFallback();
            if (curated) return curated;
        }

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
            // Live fetch failed (bad/expired key, provider down, parse error).
            // STRICT when the caller supplied a candidate key: the user is trying
            // that specific key, so surface the failure (→ the UI's "type the
            // model id" fallback) rather than masking a bad key behind the curated
            // list. Only the keyless/saved path degrades to the curated catalog.
            if (!candidateKey) {
                const curated = curatedFallback();
                if (curated) return curated;
            }
            throw new BadRequestException(
                `Error fetching ${provider} models: ${(error as Error).message}`,
            );
        }
    }
}
