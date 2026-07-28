/**
 * Anthropic provider module (Phase 1, plan 01-02) — serves `anthropic` (native
 * @ai-sdk/anthropic) and `anthropic_compatible` (Kimi Code, Z.ai, DeepSeek —
 * same SDK, baseURL normalized to a `/v1` suffix). Reproduces byok-to-vercel.ts's
 * ANTHROPIC / ANTHROPIC_COMPATIBLE cases.
 */
import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { anthropicCompatibleRootURL } from '@libs/llm/model-builders';
import { registerProvider } from './registry';
import type {
    ModelCapabilities,
    ModelResult,
    NormalizedUsage,
    ProviderBuildConfig,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from './types';

const EFFORT_TO_BUDGET: Record<ReasoningEffort, number> = {
    none: 0,
    low: 5_000,
    medium: 15_000,
    high: 40_000,
};

/** Claude families that support the newer adaptive thinking (type:'adaptive'
 *  + effort); older families use enabled + budgetTokens. Mirrors reasoning-options. */
function isAdaptiveCapable(model: string): boolean {
    return (
        /claude-(opus|sonnet)-4-[6-9]/i.test(model) ||
        /claude-(opus|sonnet)-4-\d{2,}/i.test(model) ||
        model.includes('mythos')
    );
}

export const anthropicModule: ProviderModule = {
    id: 'anthropic',
    aliases: ['anthropic_compatible'],
    label: 'Anthropic',

    settingsSchema: z.object({ baseURL: z.string().optional() }),

    capabilities(model: string): ModelCapabilities {
        const claude = /^claude[-_]/i.test(model);
        const reasoningConfig: ModelCapabilities['reasoningConfig'] = !claude
            ? undefined
            : isAdaptiveCapable(model)
              ? { type: 'adaptive', options: ['low', 'medium', 'high'] }
              : { type: 'budget', options: { min: 1024, default: 3000 } };
        return {
            supportsTemperature: true,
            supportsReasoning: !!reasoningConfig,
            reasoningConfig,
            // Anthropic does structured output via tool use, not a native
            // response_format json_schema → 'none' at this tier.
            structuredOutput: 'none',
            toolCalling: 'native',
            usageGranularity: 'reasoning_split',
            streaming: true,
            promptCaching: true,
        };
    },

    build(cfg: ProviderBuildConfig): LanguageModel {
        if ((cfg.provider as string) === 'anthropic_compatible') {
            // @ai-sdk/anthropic appends /messages to the base, so the base must
            // carry the /v1 suffix — normalize whatever the user pasted.
            return createAnthropic({
                apiKey: cfg.apiKey,
                baseURL: `${anthropicCompatibleRootURL(cfg.baseURL || '')}/v1`,
            })(cfg.model);
        }
        return createAnthropic({
            apiKey: cfg.apiKey,
            ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
        })(cfg.model);
    },

    reasoning(
        cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions {
        if (effort === 'none') return {};
        // Compatible endpoints never implement adaptive thinking → always budget.
        if (
            (cfg.provider as string) !== 'anthropic_compatible' &&
            isAdaptiveCapable(cfg.model)
        ) {
            return { anthropic: { thinking: { type: 'adaptive' }, effort } };
        }
        return {
            anthropic: {
                thinking: { type: 'enabled', budgetTokens: EFFORT_TO_BUDGET[effort] },
            },
        };
    },

    normalizeUsage(_raw: unknown): NormalizedUsage {
        return { input: 0, output: 0, reasoning: 0 };
    },
    normalize(raw: unknown): ModelResult {
        return { usage: { input: 0, output: 0, reasoning: 0 }, raw };
    },

    uiFields: [
        { key: 'apiKey', label: 'API key', type: 'password', required: true, scope: 'top' },
        { key: 'baseURL', label: 'Base URL', type: 'url', required: false, scope: 'top' },
    ],
};

registerProvider(anthropicModule);
