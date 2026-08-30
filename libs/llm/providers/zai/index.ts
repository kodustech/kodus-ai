/**
 * Z.ai (GLM) provider module — id `zai`, a first-class BRAND.
 *
 * Z.ai has its own API keys, endpoints (`api.z.ai/api/anthropic`, the Coding Plan's
 * `.../api/coding/paas/v4`), card, and curated catalog. GLM speaks the ANTHROPIC
 * wire protocol, so the module is built from the shared `anthropicBrandModule`
 * factory: it owns the brand identity + catalog, and every protocol behavior
 * delegates to the anthropic module over its `anthropic_compatible` transport. The
 * stored `credential.provider` is therefore the brand `zai`, not the transport — so
 * the connected view, "Add model", catalog, and routing all key on the brand with
 * zero transport-to-brand recovery.
 */
import { anthropicBrandModule } from '../anthropic/brand';
import { registerProvider } from '../kernel/registry';

export const zaiModule = anthropicBrandModule({
    id: 'zai',
    label: 'Z.ai',
    doc: 'https://docs.z.ai',
    defaultBaseURL: 'https://api.z.ai/api/anthropic',
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
            placeholder: 'https://api.z.ai/api/anthropic',
        },
    ],
});

registerProvider(zaiModule);
