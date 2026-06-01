import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import axios from 'axios';

import { CacheService } from '@libs/core/cache/cache.service';

const LITELLM_PRICING_URL =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_KEY = 'token-pricing:litellm';
// cache-manager v7 expects TTL in milliseconds.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

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

/** Per-token rate with optional tiered rate above 200K prompt tokens. */
export type TokenPrice = {
    default: number;
    above200k?: number;
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

    async getCatalog(): Promise<Record<string, LiteLLMModel>> {
        const cached =
            await this.cacheService.getFromCache<Record<string, LiteLLMModel>>(
                CACHE_KEY,
            );
        if (cached) return cached;

        const response = await axios.get<unknown>(LITELLM_PRICING_URL, {
            timeout: FETCH_TIMEOUT_MS,
            responseType: 'json',
        });

        const parsed =
            typeof response.data === 'string'
                ? (JSON.parse(response.data) as Record<string, LiteLLMModel>)
                : (response.data as Record<string, LiteLLMModel>);

        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Invalid LiteLLM pricing payload');
        }

        await this.cacheService.addToCache(CACHE_KEY, parsed, CACHE_TTL_MS);
        return parsed;
    }

    private async getModelInfo(
        model: string,
        provider?: string,
    ): Promise<ModelPricingInfo> {
        const catalog = await this.getCatalog();
        const match = this.lookupModel(catalog, model, provider);

        if (!match) {
            this.logger.warn({
                message: 'Model not found in LiteLLM catalog',
                context: TokenPricingUseCase.name,
                metadata: { model, provider },
            });
            return this.emptyPricing(model, provider);
        }

        return this.toPricingInfo(match.id, match.data, provider);
    }

    /**
     * LiteLLM keys are typically the bare model id (`claude-sonnet-4-5`,
     * `gemini-3.1-pro-preview-customtools`), sometimes provider-prefixed
     * (`vertex_ai/gemini-...`, `openrouter/google/...`). We try exact match,
     * then the unprefixed variant, then provider-prefixed variants, then a
     * best-effort prefix search so versioned model ids still resolve.
     */
    private lookupModel(
        catalog: Record<string, LiteLLMModel>,
        model: string,
        provider?: string,
    ): { id: string; data: LiteLLMModel } | null {
        if (!model) return null;

        const normalized = model.trim();
        const lowered = normalized.toLowerCase();
        const withoutPrefix = lowered.includes('/')
            ? lowered.split('/').slice(1).join('/')
            : lowered;

        const direct = [normalized, lowered, withoutPrefix];
        for (const key of direct) {
            if (catalog[key]) return { id: key, data: catalog[key] };
        }

        if (provider) {
            const providerLower = provider.toLowerCase();
            const providerVariants = [
                providerLower,
                // LiteLLM uses `vertex_ai` but our BYOK enum uses `google-vertex`.
                providerLower.replace('google-vertex', 'vertex_ai'),
                providerLower.replace('google-gemini', 'gemini'),
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

        // Prefix fallback — e.g. a passed model "gemini-3.1-pro-preview" should
        // resolve against "gemini-3.1-pro-preview-customtools" if that's the
        // only variant present.
        for (const key of Object.keys(catalog)) {
            if (key.toLowerCase().startsWith(withoutPrefix)) {
                return { id: key, data: catalog[key] };
            }
        }

        return null;
    }

    private toPricingInfo(
        id: string,
        entry: LiteLLMModel,
        provider?: string,
    ): ModelPricingInfo {
        const input = this.toTokenPrice(
            entry.input_cost_per_token,
            entry.input_cost_per_token_above_200k_tokens,
        );
        const output = this.toTokenPrice(
            entry.output_cost_per_token,
            entry.output_cost_per_token_above_200k_tokens,
        );
        const cacheRead = this.toTokenPrice(
            entry.cache_read_input_token_cost,
            entry.cache_read_input_token_cost_above_200k_tokens,
        );
        const cacheWrite = this.toTokenPrice(
            entry.cache_creation_input_token_cost,
            entry.cache_creation_input_token_cost_above_200k_tokens,
        );

        return {
            id,
            provider: provider ?? entry.litellm_provider,
            pricing: {
                input,
                output,
                cacheRead,
                cacheWrite,
                prompt: input.default,
                completion: output.default,
                internal_reasoning: output.default,
            },
        };
    }

    private toTokenPrice(base?: number, above200k?: number): TokenPrice {
        return {
            default: typeof base === 'number' ? base : 0,
            ...(typeof above200k === 'number' ? { above200k } : {}),
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
