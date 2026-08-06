import { Injectable } from '@nestjs/common';
// The provider REGISTRY (libs/llm/providers) is the SINGLE source of truth for
// which providers are connectable — the folder where validated providers are
// added. This service is a thin projection of it for the web (list + validate);
// it must never re-declare a parallel provider list (that would silently shadow
// a registered provider, e.g. Moonshot, from the picker + the model listing).
// The UI flags come from the shared describeAllProviderIds derivation so there
// is exactly ONE place that decides key/base-URL/listing behavior.
import { REGISTRY } from '@libs/llm/providers';
import { describeAllProviderIds } from '@libs/llm/providers/provider-ui-descriptor';

export interface ProviderInfo {
    id: string;
    name: string;
    description?: string;
    supported: boolean;
    requiresApiKey: boolean;
    requiresBaseUrl: boolean;
    /**
     * Whether the model list can be auto-fetched (show a dropdown) vs. typed by
     * hand. True for a static catalog or an HTTP listing with a resolvable base
     * URL (a default, or none required); false for custom-endpoint providers
     * whose URL is only known once the user types it, and for `manual` listings.
     */
    autoListModels: boolean;
}

@Injectable()
export class ProviderService {
    // Built once from the registry. Each connectable id (module id + its aliases)
    // becomes one ProviderInfo via the shared descriptor — no hand-kept list.
    private readonly providers: Record<string, ProviderInfo> =
        ProviderService.buildFromRegistry();

    private static buildFromRegistry(): Record<string, ProviderInfo> {
        const out: Record<string, ProviderInfo> = {};
        for (const d of describeAllProviderIds(REGISTRY.all())) {
            out[d.id] = {
                id: d.id,
                name: d.label,
                supported: true,
                requiresApiKey: d.requiresApiKey,
                requiresBaseUrl: d.requiresBaseUrl,
                autoListModels: d.autoListModels,
            };
        }
        return out;
    }

    /**
     * Get all available providers
     */
    getAllProviders(): ProviderInfo[] {
        return Object.values(this.providers).filter(
            (provider) => provider.supported,
        );
    }

    /**
     * Get provider by ID
     */
    getProvider(providerId: string): ProviderInfo | null {
        return this.providers[providerId] || null;
    }

    /**
     * Check if provider is supported
     */
    isProviderSupported(providerId: string): boolean {
        const provider = this.providers[providerId];
        return provider ? provider.supported : false;
    }

    /**
     * Get provider display name
     */
    getProviderDisplayName(providerId: string): string {
        const provider = this.providers[providerId];
        return provider ? provider.name : providerId;
    }

    /**
     * Validate provider configuration requirements
     */
    validateProviderConfig(
        providerId: string,
        config: { apiKey?: string; baseURL?: string },
    ): { isValid: boolean; errors: string[] } {
        const provider = this.providers[providerId];
        const errors: string[] = [];

        if (!provider) {
            errors.push(`Provider '${providerId}' is not supported`);
            return { isValid: false, errors };
        }

        if (provider.requiresApiKey && !config.apiKey) {
            errors.push(`API key is required for ${provider.name}`);
        }

        if (provider.requiresBaseUrl && !config.baseURL) {
            errors.push(`Base URL is required for ${provider.name}`);
        }

        return {
            isValid: errors.length === 0,
            errors,
        };
    }
}
