/**
 * Moonshot (Kimi) provider module — id `moonshot`, a first-class BRAND.
 *
 * Moonshot has its own API keys, endpoints (`api.moonshot.ai/anthropic`, the Kimi
 * Code Plan's `api.kimi.com/coding`), card, and curated catalog. Kimi speaks the
 * ANTHROPIC wire protocol, so the module is built from the shared
 * `anthropicBrandModule` factory: it owns the brand identity + catalog, and every
 * protocol behavior delegates to the anthropic module over its `anthropic_compatible`
 * transport. The stored `credential.provider` is therefore the brand `moonshot`,
 * not the transport — so the connected view, "Add model", catalog, and routing all
 * key on the brand with zero transport-to-brand recovery.
 *
 * (Kimi served over the OpenAI protocol — a manually-typed `api.moonshot.ai/v1`
 * endpoint on the generic OpenAI-compatible custom provider — still routes through
 * the openai module, which keeps the never-downgrade json_schema policy for that
 * path. This brand module is specifically Kimi-over-Anthropic.)
 */
import { anthropicBrandModule } from '../anthropic/brand';
import { registerProvider } from '../kernel/registry';
import { moonshotModelListing } from './listing';

export const moonshotModule = {
    ...anthropicBrandModule({
        id: 'moonshot',
        label: 'Moonshot',
        // Moonshot/Kimi developer docs — key setup + the Anthropic-compatible
        // endpoint (api.moonshot.ai/anthropic) this brand builds over.
        doc: 'https://platform.moonshot.ai/docs',
        defaultBaseURL: 'https://api.moonshot.ai/anthropic',
        uiFields: [
            {
                key: 'apiKey',
                label: 'API key',
                type: 'password',
                required: true,
                scope: 'top',
            },
            {
                key: 'baseURL',
                label: 'Base URL',
                type: 'url',
                required: false,
                scope: 'top',
                placeholder: 'https://api.moonshot.ai/anthropic',
            },
        ],
    }),
    // Override the factory's manual default: Moonshot's model list IS enumerable
    // at a fixed OpenAI-protocol endpoint (see ./listing), so "Browse all models"
    // can live-list with the stored key alongside the curated picks.
    modelListing: moonshotModelListing,
};

registerProvider(moonshotModule);
