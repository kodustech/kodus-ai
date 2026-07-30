import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';
import axios from 'axios';

import { CacheService } from '@libs/core/cache/cache.service';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_CACHE_KEY = 'token-pricing:modelsdev';
const LITELLM_PRICING_URL =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const LITELLM_CACHE_KEY = 'token-pricing:litellm-normalized';
// cache-manager v7 expects TTL in milliseconds.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
// Hard cap on a pricing-catalog response. Both catalogs are a few MB; 64MB is
// generous headroom while still blocking a memory-exhaustion payload.
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;

/** models.dev prices are US$ per 1M tokens; we store per-token. */
const PER_MILLION = 1_000_000;

/**
 * The token threshold encoded in the LiteLLM catalog's `*_above_200k_tokens`
 * field names and models.dev's `context_over_200k` object. models.dev's
 * `tiers[].tier.size` carries an explicit per-model breakpoint, which takes
 * precedence when present.
 */
const TIER_THRESHOLD_200K = 200_000;

/**
 * Known first-party vendor ids on models.dev. Used only as a tiebreak when two
 * providers expose the same bare model id and the richness signal (below)
 * can't separate them — an incomplete list is safe because it never overrides
 * a richer entry. models.dev has ~50 providers (many resellers: 302ai, venice,
 * helicone, openrouter, …); blocklisting them is whack-a-mole, so we prefer the
 * authoritative entry by its data instead.
 */
const NATIVE_PROVIDERS = new Set([
    'openai',
    'anthropic',
    'google',
    'google-vertex',
    'google-ai-studio',
    'moonshotai',
    'zhipuai',
    'z-ai',
    'deepseek',
    'xai',
    'alibaba',
    'mistral',
    'meta',
    'meta-llama',
    'cohere',
    'amazon-bedrock',
]);

type ModelsDevCostTier = {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tier?: { type?: string; size?: number };
};

type ModelsDevCost = {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
    tiers?: ModelsDevCostTier[];
    context_over_200k?: {
        input?: number;
        output?: number;
        cache_read?: number;
        cache_write?: number;
    };
};

type ModelsDevModel = {
    id?: string;
    cost?: ModelsDevCost;
};

type ModelsDevProvider = {
    id?: string;
    models?: Record<string, ModelsDevModel>;
};

type LiteLLMModel = {
    input_cost_per_token?: number;
    input_cost_per_token_above_200k_tokens?: number;
    output_cost_per_token?: number;
    output_cost_per_token_above_200k_tokens?: number;
    cache_read_input_token_cost?: number;
    cache_read_input_token_cost_above_200k_tokens?: number;
    cache_creation_input_token_cost?: number;
    cache_creation_input_token_cost_above_200k_tokens?: number;
    litellm_provider?: string;
    mode?: string;
};

/**
 * Per-token rate with optional context tiers, sorted ascending by threshold.
 * A call whose input exceeds `tiers[k].threshold` (and no higher one) bills
 * entirely at `tiers[k].rate`; at or below the first threshold, `default`.
 * Per-request-total tiering (Gemini/Doubao), not graduated. Most models have
 * one tier; a few (Doubao) have several.
 */
export type TokenPrice = {
    default: number;
    tiers?: Array<{ threshold: number; rate: number }>;
};

/**
 * Normalized pricing for a single model. Prices are per-token, NOT per
 * million. Callers that render "$X per 1M" must multiply by 1e6.
 *
 * `prompt`/`completion`/`internal_reasoning` are kept as flat scalars for
 * backward compatibility with existing UI consumers; they mirror the
 * `default` tier of input/output. Cost calculations should prefer the rich
 * input/output/cacheRead/cacheWrite shape.
 */
export type ModelPricingInfo = {
    id: string;
    provider?: string;
    pricing: {
        input: TokenPrice;
        output: TokenPrice;
        cacheRead: TokenPrice;
        cacheWrite: TokenPrice;
        prompt: number;
        completion: number;
        internal_reasoning: number;
    };
};

/**
 * Source-agnostic catalog entry, already converted to per-token rates. Both
 * the models.dev and LiteLLM payloads normalize into this at fetch time (the
 * normalized form is what gets cached), so lookup and pricing logic never
 * touch source-specific field names or units again.
 */
export type CatalogEntry = {
    provider?: string;
    input: TokenPrice;
    output: TokenPrice;
    cacheRead: TokenPrice;
    cacheWrite: TokenPrice;
    /** Per-token reasoning rate when the source prices it separately. */
    reasoning?: number;
};

export type PricingCatalog = Record<string, CatalogEntry>;

@Injectable()
export class TokenPricingUseCase {
    private readonly logger = createLogger(TokenPricingUseCase.name);

    constructor(private readonly cacheService: CacheService) {}

    async execute(model: string, provider?: string): Promise<ModelPricingInfo> {
        try {
            return await this.getModelInfo(model, provider);
        } catch (error) {
            this.logger.error({
                message: 'Error fetching token pricing',
                error,
                context: TokenPricingUseCase.name,
                metadata: { model, provider },
            });
            return this.emptyPricing(model, provider);
        }
    }

    /**
     * Batch variant: resolve many models in one call. The catalogs are cached,
     * so this fetches each source at most once regardless of model count —
     * collapsing the screen's per-model N+1 into a single request.
     */
    async executeMany(
        models: string[],
        provider?: string,
    ): Promise<Record<string, ModelPricingInfo>> {
        const unique = Array.from(
            new Set(models.map((m) => m?.trim()).filter(Boolean)),
        );
        const entries = await Promise.all(
            unique.map(
                async (model) =>
                    [model, await this.execute(model, provider)] as const,
            ),
        );
        return Object.fromEntries(entries);
    }

    /**
     * Canonical model name → its sorted INPUT tier breakpoints. The Token
     * Usage read buckets each call by which of these thresholds its input
     * exceeds, without a per-request DB scan to discover the models present.
     * A model with N input tiers maps to N thresholds (Doubao: [32000,
     * 128000]); a flat model is absent. Catalogs are cached (24h) → near-free.
     *
     * Keys are canonicalized the same way the write path stores
     * `attributes.tu.model` (strip provider prefix, keep the last id segment),
     * so `vertex_ai/gemini-2.5-pro` and a bare `gemini-2.5-pro` both collapse to
     * the stored name and match in the aggregation's `$switch`.
     */
    async tieredInputThresholds(): Promise<Map<string, number[]>> {
        const out = new Map<string, number[]>();
        // Fallback first, primary second — primary wins on key collisions.
        // Each fetch is guarded: this feeds the Token Usage READ (every
        // summary/overview call), so a catalog outage must degrade to "no
        // tiers" (everything priced at default), never fail the whole read.
        const catalogs: PricingCatalog[] = [];
        for (const [source, getCatalog] of [
            ['litellm', () => this.getLiteLLMCatalog()],
            ['models.dev', () => this.getModelsDevCatalog()],
        ] as const) {
            try {
                catalogs.push(await getCatalog());
            } catch (error) {
                this.logger.warn({
                    message: 'Tier-threshold catalog fetch failed',
                    error,
                    context: TokenPricingUseCase.name,
                    metadata: { source },
                });
            }
        }
        for (const catalog of catalogs) {
            for (const [key, entry] of Object.entries(catalog)) {
                const tiers = entry.input.tiers;
                if (!tiers?.length) continue;
                const thresholds = tiers.map((t) => t.threshold);
                for (const name of this.canonicalNames(key)) {
                    out.set(name, thresholds);
                }
            }
        }
        return out;
    }

    /**
     * Every form a catalog key can appear as in `attributes.tu.model`, so the
     * read-time tier `$switch` matches however the id was stored.
     *
     * The write path (deriveTu) stores `gen_ai.response.model.split(':').pop()`
     * — it strips a `provider:` prefix but KEEPS a `provider/` one. So a stored
     * id may be the colon-stripped key (`vertex_ai/gemini-2.5-pro`) OR the fully
     * bare last segment (`gemini-2.5-pro`). Emitting only the bare form (as a
     * previous version did) missed slash-prefixed ids and under-reported their
     * tiered cost — so emit BOTH.
     */
    private canonicalNames(key: string): string[] {
        const colonStripped = key.split(':').pop()!;
        const bare = colonStripped.split('/').pop()!;
        return colonStripped === bare ? [colonStripped] : [colonStripped, bare];
    }

    /**
     * Primary catalog (models.dev), flattened from its provider-nested shape
     * into `provider/model` keys plus bare-id aliases, normalized to per-token
     * rates. Cached post-normalization.
     */
    async getModelsDevCatalog(): Promise<PricingCatalog> {
        const cached =
            await this.cacheService.getFromCache<PricingCatalog>(
                MODELS_DEV_CACHE_KEY,
            );
        if (cached) return cached;

        const raw = await this.fetchJson<Record<string, ModelsDevProvider>>(
            MODELS_DEV_URL,
        );
        const catalog = this.flattenModelsDev(raw);
        await this.cacheService.addToCache(
            MODELS_DEV_CACHE_KEY,
            catalog,
            CACHE_TTL_MS,
        );
        return catalog;
    }

    /** Secondary catalog (LiteLLM), kept as a fallback during the cutover. */
    async getLiteLLMCatalog(): Promise<PricingCatalog> {
        const cached =
            await this.cacheService.getFromCache<PricingCatalog>(
                LITELLM_CACHE_KEY,
            );
        if (cached) return cached;

        const raw =
            await this.fetchJson<Record<string, LiteLLMModel>>(
                LITELLM_PRICING_URL,
            );
        const catalog: PricingCatalog = {};
        for (const [key, entry] of Object.entries(raw)) {
            if (!entry || typeof entry !== 'object') continue;
            catalog[key] = this.fromLiteLLM(entry);
        }
        await this.cacheService.addToCache(
            LITELLM_CACHE_KEY,
            catalog,
            CACHE_TTL_MS,
        );
        return catalog;
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const response = await axios.get<unknown>(url, {
            timeout: FETCH_TIMEOUT_MS,
            responseType: 'json',
            // Bound the response so a compromised/oversized upstream can't
            // exhaust the process memory (models.dev ~2MB, LiteLLM ~1MB today).
            maxContentLength: MAX_CATALOG_BYTES,
            maxBodyLength: MAX_CATALOG_BYTES,
        });
        const parsed =
            typeof response.data === 'string'
                ? (JSON.parse(response.data) as T)
                : (response.data as T);
        if (!parsed || typeof parsed !== 'object') {
            throw new Error(`Invalid pricing payload from ${url}`);
        }
        return parsed;
    }

    private flattenModelsDev(
        raw: Record<string, ModelsDevProvider>,
    ): PricingCatalog {
        const catalog: PricingCatalog = {};
        const bareOwner = new Map<string, string>();

        for (const [providerKey, provider] of Object.entries(raw)) {
            const providerId = (provider?.id ?? providerKey).toLowerCase();
            const models = provider?.models;
            if (!models || typeof models !== 'object') continue;

            for (const [modelKey, model] of Object.entries(models)) {
                const modelId = (model?.id ?? modelKey).toLowerCase();
                const entry = this.fromModelsDev(model?.cost, providerId);
                catalog[`${providerId}/${modelId}`] = entry;

                if (this.claimBareAlias(catalog, bareOwner, modelId, entry)) {
                    bareOwner.set(modelId, providerId);
                }
            }
        }
        return catalog;
    }

    /**
     * Ranks a candidate for the bare-id alias by (priced, rich, native), most
     * significant first. "Rich" = carries tier/cache/reasoning metadata, which
     * only the authoritative vendor entry does — a reseller mirroring the list
     * input/output price strips those. So `gemini-2.5-pro` resolves to Google's
     * tiered entry, not 302ai's flat one, and cache-priced models keep their
     * cache rate. `native` is a weak tiebreak (see NATIVE_PROVIDERS).
     */
    private aliasRank(entry: CatalogEntry): number {
        const priced = entry.input.default > 0 || entry.output.default > 0;
        const rich =
            !!entry.input.tiers?.length ||
            !!entry.output.tiers?.length ||
            entry.cacheRead.default > 0 ||
            entry.cacheWrite.default > 0 ||
            entry.reasoning !== undefined;
        const native = NATIVE_PROVIDERS.has(entry.provider ?? '');
        return (priced ? 4 : 0) + (rich ? 2 : 0) + (native ? 1 : 0);
    }

    /**
     * Whether `entry` should own the bare-id alias for `modelId`. Highest rank
     * wins; ties keep the first writer.
     */
    private claimBareAlias(
        catalog: PricingCatalog,
        bareOwner: Map<string, string>,
        modelId: string,
        entry: CatalogEntry,
    ): boolean {
        const existing = bareOwner.has(modelId)
            ? catalog[modelId]
            : undefined;
        if (!existing) {
            catalog[modelId] = entry;
            return true;
        }
        if (this.aliasRank(entry) > this.aliasRank(existing)) {
            catalog[modelId] = entry;
            return true;
        }
        return false;
    }

    private fromModelsDev(
        cost: ModelsDevCost | undefined,
        provider: string,
    ): CatalogEntry {
        const perToken = (perMillion?: number): number | undefined =>
            typeof perMillion === 'number'
                ? perMillion / PER_MILLION
                : undefined;

        // Every context breakpoint (models.dev usually one, Doubao two). The
        // legacy `context_over_200k` object is treated as a synthetic 200k
        // tier when no explicit `tiers` list is present.
        const rawTiers = (cost?.tiers ?? []).filter(
            (t) =>
                (t?.tier?.type ?? 'context') === 'context' &&
                typeof t?.tier?.size === 'number',
        );
        const contextTiers: Array<ModelsDevCostTier & { size: number }> =
            rawTiers.length
                ? rawTiers.map((t) => ({ ...t, size: t.tier!.size! }))
                : cost?.context_over_200k
                  ? [{ ...cost.context_over_200k, size: TIER_THRESHOLD_200K }]
                  : [];

        // Per-token tier list for one cost field (input/output/cache_*),
        // keeping only breakpoints that price that field.
        const tiersFor = (
            key: 'input' | 'output' | 'cache_read' | 'cache_write',
        ) =>
            contextTiers
                .filter((t) => typeof t[key] === 'number')
                .map((t) => ({
                    threshold: t.size,
                    rate: perToken(t[key])!,
                }));

        return {
            provider,
            input: this.toTokenPrice(perToken(cost?.input), tiersFor('input')),
            output: this.toTokenPrice(
                perToken(cost?.output),
                tiersFor('output'),
            ),
            cacheRead: this.toTokenPrice(
                perToken(cost?.cache_read),
                tiersFor('cache_read'),
            ),
            cacheWrite: this.toTokenPrice(
                perToken(cost?.cache_write),
                tiersFor('cache_write'),
            ),
            ...(typeof cost?.reasoning === 'number'
                ? { reasoning: cost.reasoning / PER_MILLION }
                : {}),
        };
    }

    private fromLiteLLM(entry: LiteLLMModel): CatalogEntry {
        const tier = (rate?: number) =>
            typeof rate === 'number'
                ? [{ threshold: TIER_THRESHOLD_200K, rate }]
                : undefined;
        return {
            provider: entry.litellm_provider,
            input: this.toTokenPrice(
                entry.input_cost_per_token,
                tier(entry.input_cost_per_token_above_200k_tokens),
            ),
            output: this.toTokenPrice(
                entry.output_cost_per_token,
                tier(entry.output_cost_per_token_above_200k_tokens),
            ),
            cacheRead: this.toTokenPrice(
                entry.cache_read_input_token_cost,
                tier(entry.cache_read_input_token_cost_above_200k_tokens),
            ),
            cacheWrite: this.toTokenPrice(
                entry.cache_creation_input_token_cost,
                tier(entry.cache_creation_input_token_cost_above_200k_tokens),
            ),
        };
    }

    private async getModelInfo(
        model: string,
        provider?: string,
    ): Promise<ModelPricingInfo> {
        // models.dev is the source of truth; LiteLLM stays as a fallback so
        // nothing it priced regresses during the cutover. Each source failing
        // to fetch is non-fatal as long as the other resolves the model.
        const match =
            (await this.lookupIn(
                () => this.getModelsDevCatalog(),
                'models.dev',
                model,
                provider,
            )) ??
            (await this.lookupIn(
                () => this.getLiteLLMCatalog(),
                'litellm',
                model,
                provider,
            ));

        if (!match) {
            this.logger.warn({
                message: 'Model not found in pricing catalogs',
                context: TokenPricingUseCase.name,
                metadata: { model, provider },
            });
            return this.emptyPricing(model, provider);
        }

        return this.toPricingInfo(match.id, match.data, provider);
    }

    private async lookupIn(
        getCatalog: () => Promise<PricingCatalog>,
        source: string,
        model: string,
        provider?: string,
    ): Promise<{ id: string; data: CatalogEntry } | null> {
        let catalog: PricingCatalog;
        try {
            catalog = await getCatalog();
        } catch (error) {
            this.logger.warn({
                message: 'Pricing catalog fetch failed',
                error,
                context: TokenPricingUseCase.name,
                metadata: { source, model },
            });
            return null;
        }
        return this.lookupModel(catalog, model, provider);
    }

    /**
     * Catalog keys are either the bare model id (`kimi-k2.6`) or
     * provider-prefixed (`moonshotai/kimi-k2.6`, `vertex_ai/gemini-...`). We
     * try exact match, then the unprefixed variant, then provider-prefixed
     * variants, then a best-effort prefix search (on the full key AND its last
     * segment) so versioned or provider-nested ids still resolve.
     */
    private lookupModel(
        catalog: PricingCatalog,
        model: string,
        provider?: string,
    ): { id: string; data: CatalogEntry } | null {
        if (!model) return null;

        const normalized = model.trim();
        const lowered = normalized.toLowerCase();
        // Provider separator may be ':' (Kodus internal BYOK format —
        // resolveModelName in observability.service.ts) or '/' (LiteLLM /
        // OpenRouter). Only normalize ':' when it precedes any '/', so
        // suffixes like OpenRouter's ':free' stay intact.
        const colonNormalized = /^[^:/]+:/.test(lowered)
            ? lowered.replace(':', '/')
            : lowered;
        const withoutPrefix = colonNormalized.includes('/')
            ? colonNormalized.split('/').slice(1).join('/')
            : colonNormalized;

        const direct = [normalized, lowered, colonNormalized, withoutPrefix];
        for (const key of direct) {
            if (catalog[key]) return { id: key, data: catalog[key] };
        }

        if (provider) {
            const providerLower = provider.toLowerCase();
            const providerVariants = [
                providerLower,
                // LiteLLM uses `vertex_ai`, models.dev `google-vertex`; our
                // BYOK enum uses `google-vertex`.
                providerLower.replace('google-vertex', 'vertex_ai'),
                providerLower.replace('google-gemini', 'gemini'),
                providerLower.replace('google-gemini', 'google'),
            ];
            for (const prov of providerVariants) {
                for (const key of direct) {
                    const candidate = `${prov}/${key}`;
                    if (catalog[candidate]) {
                        return { id: candidate, data: catalog[candidate] };
                    }
                }
            }
        }

        // Prefix fallback — e.g. a passed model "gemini-3.1-pro-preview"
        // should resolve against "gemini-3.1-pro-preview-customtools" if
        // that's the only variant present. Matching the key's last segment
        // too lets a bare id land on a provider-prefixed key.
        //
        // Deterministic: pick the CLOSEST match (shortest matching segment,
        // ties broken lexicographically) instead of whatever Object.keys
        // yields first — otherwise the resolved price depends on catalog
        // insertion order and can flip between fetches.
        let best: { id: string; segLen: number } | null = null;
        for (const key of Object.keys(catalog)) {
            const keyLower = key.toLowerCase();
            const seg = keyLower.split('/').pop()!;
            if (
                !keyLower.startsWith(withoutPrefix) &&
                !seg.startsWith(withoutPrefix)
            ) {
                continue;
            }
            if (
                !best ||
                seg.length < best.segLen ||
                (seg.length === best.segLen && key < best.id)
            ) {
                best = { id: key, segLen: seg.length };
            }
        }
        if (best) return { id: best.id, data: catalog[best.id] };

        return null;
    }

    private toPricingInfo(
        id: string,
        entry: CatalogEntry,
        provider?: string,
    ): ModelPricingInfo {
        return {
            id,
            provider: provider ?? entry.provider,
            pricing: {
                input: entry.input,
                output: entry.output,
                cacheRead: entry.cacheRead,
                cacheWrite: entry.cacheWrite,
                prompt: entry.input.default,
                completion: entry.output.default,
                internal_reasoning: entry.reasoning ?? entry.output.default,
            },
        };
    }

    private toTokenPrice(
        base?: number,
        tiers?: Array<{ threshold: number; rate: number }>,
    ): TokenPrice {
        const sorted = (tiers ?? [])
            .filter((t) => typeof t.rate === 'number')
            .sort((a, b) => a.threshold - b.threshold);
        return {
            default: typeof base === 'number' ? base : 0,
            ...(sorted.length ? { tiers: sorted } : {}),
        };
    }

    private emptyPricing(id: string, provider?: string): ModelPricingInfo {
        const zero: TokenPrice = { default: 0 };
        return {
            id,
            provider,
            pricing: {
                input: zero,
                output: zero,
                cacheRead: zero,
                cacheWrite: zero,
                prompt: 0,
                completion: 0,
                internal_reasoning: 0,
            },
        };
    }
}
