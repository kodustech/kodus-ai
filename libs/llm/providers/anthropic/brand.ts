/**
 * Anthropic-protocol BRAND module factory.
 *
 * A brand like Moonshot (Kimi) or Z.ai (GLM) is its OWN first-class provider — its
 * own id, label, API keys, endpoints, and curated catalog — that happens to speak
 * the Anthropic wire protocol. This factory captures exactly that split: the brand
 * owns IDENTITY + CATALOG, and every protocol behavior (build, reasoning, system
 * cache hint, sampling-param gate, usage extraction) delegates to the anthropic
 * module, presenting the config as `anthropic_compatible` so the anthropic module
 * applies its compatible-endpoint branches (budget thinking, sampling params on,
 * baseURL `/v1` normalization).
 *
 * This is why the stored `credential.provider` is the BRAND (`moonshot`/`zai`), not
 * the transport: dispatch resolves the brand module, which routes straight back to
 * the ONE Anthropic protocol implementation. Connected view, add-model, catalog,
 * and routing all key on that single brand id — no transport-to-brand recovery, no
 * per-brand transport id. (The generic `anthropic_compatible` id still exists for
 * custom/self-hosted Anthropic endpoints — DeepSeek and friends — that carry no
 * brand of their own.)
 */
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { anthropicModule } from './index';
import type {
    FieldDescriptor,
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderBuildOptions,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from '../kernel/types';
import type { ProviderCatalogModel } from '../kernel/catalog';

/** Present a brand's config to the anthropic module as its compatible transport,
 *  so the anthropic-compatible branches (budget thinking, sampling params on, `/v1`
 *  base normalization) fire for a Kimi/GLM slot dispatched under its brand id. */
const asCompatible = (cfg: ProviderBuildConfig): ProviderBuildConfig => ({
    ...cfg,
    provider: 'anthropic_compatible' as ProviderBuildConfig['provider'],
});

export interface AnthropicBrandSpec {
    id: string;
    label: string;
    doc?: string;
    catalog: ProviderCatalogModel[];
    uiFields: FieldDescriptor[];
}

export function anthropicBrandModule(spec: AnthropicBrandSpec): ProviderModule {
    return {
        id: spec.id,
        label: spec.label,
        doc: spec.doc,
        settingsSchema: z.object({ baseURL: z.string().optional() }),
        catalog: spec.catalog,

        // Intrinsic to the Anthropic wire protocol → one source, the anthropic module.
        capabilities(model: string): ModelCapabilities {
            return anthropicModule.capabilities(model);
        },
        build(
            cfg: ProviderBuildConfig,
            opts?: ProviderBuildOptions,
        ): LanguageModel {
            return anthropicModule.build(asCompatible(cfg), opts);
        },
        reasoning(
            cfg: ProviderBuildConfig,
            effort: ReasoningEffort,
        ): ProviderReasoningOptions {
            return anthropicModule.reasoning!(asCompatible(cfg), effort);
        },
        // NO inline cache marker. Unlike native Anthropic (which REQUIRES an
        // explicit `cache_control: ephemeral` breakpoint), the Anthropic-protocol
        // brands cache AUTOMATICALLY and IGNORE the marker — same as OpenAI/Gemini.
        // Per their docs (Kimi: "Context Caching is automatically enabled for all
        // model requests, no manual cache creation"; Z.ai: "implicit caching, no
        // manual configuration required") AND verified live: two identical Kimi
        // calls with NO marker → the 2nd read the whole prompt from cache
        // (cache_read = full input). So emitting the marker is a no-op at best and
        // a rejection risk on a strict endpoint. `capabilities().promptCaching`
        // stays true (they DO cache) — only the explicit breakpoint is dropped.
        systemCacheControl(): Record<string, unknown> | undefined {
            return undefined;
        },
        supportsSamplingParams(cfg: ProviderBuildConfig): boolean {
            return anthropicModule.supportsSamplingParams!(asCompatible(cfg));
        },

        normalize: anthropicModule.normalize,
        normalizeUsage: anthropicModule.normalizeUsage,
        providerOptionsNamespace: () => 'anthropic',

        uiFields: spec.uiFields,
        // Curated brand: the catalog names the models; the manual field types any
        // other. (No `/models` listing — that is the OpenAI protocol's shape, not
        // this one's.)
        modelListing: () => ({ kind: 'manual' }),
    };
}
