/**
 * Novita provider module (Phase 1, plan 01-02) — id `novita`.
 * Reproduces byok-to-vercel.ts's NOVITA case: an OpenAI-compatible client
 * pointed at Novita's endpoint. No LangChain adapter — built inline today.
 * Novita has no dedicated reasoning branch (varies wildly by upstream), so
 * reasoning() is always off — matching reasoning-options.ts's default.
 */
import type { LanguageModel } from 'ai';
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
} from './types';

export const novitaModule: ProviderModule = {
    id: 'novita',
    label: 'Novita',

    settingsSchema: z.object({ baseURL: z.string().optional() }),

    capabilities(_model: string): ModelCapabilities {
        // Reasoning is too upstream-dependent to advertise by default.
        return {
            supportsTemperature: true,
            supportsReasoning: false,
            structuredOutput: 'json_object',
            toolCalling: 'native',
            usageGranularity: 'output_only',
            streaming: true,
            promptCaching: false,
        };
    },

    build(cfg: ProviderBuildConfig, opts?: ProviderBuildOptions): LanguageModel {
        return createOpenAICompatible({
            name: 'novita',
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL || 'https://api.novita.ai/v3/openai',
            supportsStructuredOutputs:
                opts?.structuredOutputs === true &&
                shouldEnableJsonSchema('novita', cfg.model, cfg.baseURL),
        })(cfg.model);
    },

    // No reasoning() — Novita has no native thinking mapping (default: off).

    // ── Phase 3: real usage extraction (D-01 / Q4) ──────────────────────────
    // Novita is OpenAI-compatible, so @ai-sdk/openai-compatible maps its
    // { prompt_tokens, completion_tokens } onto the high-level ai@7
    // LanguageModelUsage shape — the same extraction openai.module uses applies.
    // ai@7 nests reasoning under `outputTokenDetails.reasoningTokens`; the
    // top-level `reasoningTokens` is the ai@6 flat fallback (0 when a Novita
    // upstream reports no split). Reasoning is a detail-OF output — `output` is
    // the FULL completion count and is NEVER reduced by reasoning (Q4 trap).
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
        { key: 'apiKey', label: 'API key', type: 'password', required: true, scope: 'top' },
        { key: 'baseURL', label: 'Base URL', type: 'url', required: false, scope: 'top', placeholder: 'https://api.novita.ai/v3/openai' },
    ],
};

registerProvider(novitaModule);
