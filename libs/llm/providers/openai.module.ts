/**
 * OpenAI provider module (Phase 1, plan 01-01) — the tracer.
 *
 * Serves BOTH `openai` (native `@ai-sdk/openai`) and `openai_compatible`
 * (`@ai-sdk/openai-compatible`, baseURL-driven) — they share a build that
 * branches on the provider id. Reproduces byok-to-vercel.ts's OPENAI /
 * OPENAI_COMPATIBLE cases exactly (same apiKey/baseURL/structured-output gate),
 * so routing this provider through the registry is a no-behavior-change move.
 *
 * capabilities() is a minimal openai-faithful version for the tracer; the full
 * capability table + the 6 extended fields are folded in 01-04. normalize/
 * normalizeUsage are declared stubs (Phase 3 owns them).
 */
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { shouldEnableJsonSchema } from '@libs/llm/structured-output-gate';
import { registerProvider } from './registry';
import type {
    ModelCapabilities,
    ModelResult,
    NormalizedUsage,
    ProviderBuildConfig,
    ProviderBuildOptions,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from './types';

/** o-series and gpt-5 are OpenAI's reasoning families (level-based effort). */
function isOpenAiReasoner(model: string): boolean {
    return /^o[134](\b|[-_@])/i.test(model) || /^gpt-5(\b|[-_@])/i.test(model);
}

export const openaiModule: ProviderModule = {
    id: 'openai',
    aliases: ['openai_compatible'],
    label: 'OpenAI',

    settingsSchema: z.object({
        baseURL: z.string().optional(),
    }),

    capabilities(model: string): ModelCapabilities {
        const reasoner = isOpenAiReasoner(model);
        // gpt-5 exposes only medium/high; o-series exposes low/medium/high.
        const reasoningConfig: ModelCapabilities['reasoningConfig'] = reasoner
            ? {
                  type: 'level',
                  options: /^gpt-5(\b|[-_@])/i.test(model)
                      ? ['medium', 'high']
                      : ['low', 'medium', 'high'],
              }
            : undefined;
        return {
            // o-series / gpt-5 reject `temperature`; other OpenAI models allow it.
            supportsTemperature: !reasoner,
            supportsReasoning: !!reasoningConfig,
            reasoningConfig,
            // Provider-level execution capabilities (01-04; per-model refinement
            // is a follow-up — note capabilities(model) can't see openai vs
            // openai_compatible, so these describe native OpenAI).
            structuredOutput: 'json_schema',
            toolCalling: 'native',
            usageGranularity: reasoner ? 'reasoning_split' : 'output_only',
            streaming: true,
            promptCaching: true,
        };
    },

    build(cfg: ProviderBuildConfig, opts?: ProviderBuildOptions): LanguageModel {
        // apiKey is already DECRYPTED by the caller (byok-to-vercel).
        const apiKey = cfg.apiKey;
        const baseURL = cfg.baseURL;

        if ((cfg.provider as string) === 'openai_compatible') {
            return createOpenAICompatible({
                name: 'openai-compatible',
                apiKey,
                baseURL: baseURL || '',
                supportsStructuredOutputs:
                    opts?.structuredOutputs === true &&
                    shouldEnableJsonSchema(
                        cfg.provider as string,
                        cfg.model,
                        baseURL,
                    ),
            })(cfg.model);
        }

        // Native OpenAI (id 'openai'). Only pass baseURL when set — the native
        // SDK has a sensible default and an empty string throws "Invalid URL".
        return createOpenAI({
            apiKey,
            ...(baseURL ? { baseURL } : {}),
        })(cfg.model);
    },

    reasoning(
        cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions {
        if (effort === 'none') return {};
        // openai_compatible upstreams (Kimi/GLM/…) take the standard
        // openai-compatible `thinking` param; native OpenAI takes reasoningEffort.
        if ((cfg.provider as string) === 'openai_compatible') {
            return { openaiCompatible: { thinking: { type: 'enabled' } } };
        }
        return { openai: { reasoningEffort: effort } };
    },

    // ── Phase 3: real usage extraction (D-01 / Q4) ──────────────────────────
    // Reads the same fields observability.service.ts:469-480 already reads off the
    // AI SDK generateText result, so cost projection stays a single source of truth.
    // ai@7 nests reasoning under `outputTokenDetails.reasoningTokens`; the top-level
    // `reasoningTokens` is the ai@6 flat fallback. Reasoning is a detail-OF output —
    // `output` is the FULL completion count and is NEVER reduced by reasoning (Q4
    // double-count trap: `total` = input+output, reasoning is additive info only).
    normalizeUsage(raw: unknown): NormalizedUsage {
        const u =
            (raw as { usage?: Record<string, any> } | undefined)?.usage ?? {};
        return {
            input: u.inputTokens ?? 0,
            output: u.outputTokens ?? 0,
            reasoning:
                u.outputTokenDetails?.reasoningTokens ??
                u.reasoningTokens ??
                0,
        };
    },
    normalize(raw: unknown): ModelResult {
        return { usage: this.normalizeUsage(raw), raw };
    },

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
            placeholder: 'https://api.openai.com/v1',
        },
    ],
};

registerProvider(openaiModule);
