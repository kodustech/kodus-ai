/**
 * Provider CATALOG — the curated, editorial model list a provider module owns.
 *
 * The registry already owns a provider's FACTS (`capabilities()`, `modelListing`,
 * `doc`, endpoints, `reasoning()`). This adds the CURATION: Kodus's opinionated
 * picks with a benchmark score, marketing copy, connection variants (billing
 * plans), and per-model defaults. Keeping it on the module makes each brand the
 * single source for ITS models — the web app no longer ships a static
 * `curated-models.json` that duplicates provider facts and drifts from them.
 *
 * IDENTITY comes from the module, NOT repeated here: a catalog entry carries no
 * `providerKey`/`providerDisplayName` (that's the module's `id`/`label`) and no
 * `provider` transport unless it OVERRIDES the module's default build transport
 * (e.g. a brand served over `anthropic_compatible`). The aggregating use-case
 * stamps those from the module when it flattens the registry.
 */
/** Perceptual response-speed bucket shown as a chip. */
export type SpeedRating = 'fast' | 'medium' | 'slow';
/** Relative cost bucket — `$` cheapest … `$$$` priciest. */
export type CostTier = '$' | '$$' | '$$$';
/** Curation tier — `recommended` are the hero picks shown first. */
export type ModelTier = 'recommended' | 'bestValue' | 'budget' | 'other';

/** One connection variant of a catalog model — a billing plan / endpoint pair
 *  (e.g. "Developer API" vs "Coding Plan"), each possibly on its own transport
 *  and base URL. Mirrors the web `ModelVariant`. */
export interface ProviderCatalogVariant {
    id: string;
    label: string;
    description?: string;
    baseURL: string;
    apiKeyUrl?: string;
    maxConcurrentRequests?: number;
    /** Transport override for this variant when it differs from the model's
     *  (e.g. one plan speaks Anthropic, another OpenAI-compatible). */
    provider?: string;
}

/** One curated model a provider module offers. Mirrors the web `CuratedModel`
 *  MINUS the module-owned identity (`provider`/`providerKey`/`providerDisplayName`),
 *  which the aggregator fills from the module. */
export interface ProviderCatalogModel {
    /** Model id the BYOK config stores (matches capabilities()/build() input). */
    id: string;
    displayName: string;
    /** Transport override when this model is NOT built over the module's default
     *  transport (e.g. a Kimi/GLM model served over `anthropic_compatible`).
     *  Absent ⇒ the aggregator stamps the module's own id as the transport. */
    provider?: string;
    tier: ModelTier;
    /** Colored tier badge on the hero picks ("Best balance", …). Hero-only. */
    recommendationLabel?: string;
    benchmarkScore: number;
    description: string;
    speed: SpeedRating;
    /** Display context window ("200K"). Interim: a later phase derives this from
     *  the module's `capabilities(model).maxInputTokens` so the fact lives in ONE
     *  place — carried here for now so the migration loses nothing. */
    contextWindow: string;
    costTier: CostTier;
    strengths?: string[];
    weaknesses?: string[];
    apiKeyUrl: string;
    defaults: {
        temperature: number;
        maxOutputTokens: number;
        baseURL?: string;
        reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
    };
    variants?: ProviderCatalogVariant[];
    defaultVariantId?: string;
    docsUrl?: string;
    latencyP50Ms?: number;
    errorRatePct?: number;
}

/** A catalog entry stamped with its owning module's identity — the shape the
 *  aggregating use-case emits and the web app consumes (1:1 with the old
 *  `CuratedModel`). */
export interface ResolvedCatalogModel extends ProviderCatalogModel {
    /** Transport id used to build this model (module default, or the entry's
     *  `provider` override). */
    provider: string;
    /** Brand identity — the owning module's id (`moonshot`, `zai`, …). */
    providerKey: string;
    /** Brand display name — the owning module's label. */
    providerDisplayName: string;
}

// Type-only (erased at runtime), so this import does not create a runtime cycle
// with types.ts even though types.ts type-imports ProviderCatalogModel from here.
import type { ProviderModule } from './types';

/**
 * Flatten every module's `catalog` into the resolved, identity-stamped list the
 * web app consumes. Each entry inherits its brand from the owning module (id →
 * `providerKey`, label → `providerDisplayName`) and its transport from the
 * entry's `provider` override, else the module's own id. Pure — takes the module
 * list so it is trivially unit-testable without the registry singleton.
 */
export function resolveCatalogFrom(
    modules: ProviderModule[],
): ResolvedCatalogModel[] {
    return modules.flatMap((m) =>
        (m.catalog ?? []).map((entry) => ({
            ...entry,
            provider: entry.provider ?? m.id,
            providerKey: m.id,
            providerDisplayName: m.label,
        })),
    );
}
