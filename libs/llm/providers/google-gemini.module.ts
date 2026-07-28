/**
 * Google Gemini provider module (Phase 1, plan 01-02) — id `google_gemini`.
 * Reproduces byok-to-vercel.ts's GOOGLE_GEMINI case (native @ai-sdk/google).
 * Gemini-on-Vertex is a SEPARATE id (google_vertex) handled by the vertex module.
 */
import type { LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
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

/** Effort → thinking budget (mirrors reasoning-options.ts EFFORT_TO_BUDGET;
 *  local copy keeps this module free of a runtime kodus-common import). */
const EFFORT_TO_BUDGET: Record<ReasoningEffort, number> = {
    none: 0,
    low: 5_000,
    medium: 15_000,
    high: 40_000,
};

export const googleGeminiModule: ProviderModule = {
    id: 'google_gemini',
    label: 'Google Gemini',

    settingsSchema: z.object({ baseURL: z.string().optional() }),

    capabilities(model: string): ModelCapabilities {
        // Gemini 2.5 / 3.x thinking families use a numeric/level budget.
        const reasoner = /gemini-(2\.5|3)/i.test(model);
        const reasoningConfig: ModelCapabilities['reasoningConfig'] = reasoner
            ? { type: 'budget', options: { min: 128, default: 3000 } }
            : undefined;
        return {
            supportsTemperature: true,
            supportsReasoning: !!reasoningConfig,
            reasoningConfig,
            structuredOutput: 'json_schema', // Gemini responseSchema
            toolCalling: 'native',
            usageGranularity: 'reasoning_split',
            streaming: true,
            promptCaching: true,
        };
    },

    build(cfg: ProviderBuildConfig): LanguageModel {
        return createGoogleGenerativeAI({
            apiKey: cfg.apiKey,
            ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
        })(cfg.model);
    },

    reasoning(
        cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions {
        if (effort === 'none') return {};
        // Gemini 3+: thinkingLevel (minimal/low/medium/high); Gemini 2.5: thinkingBudget.
        const isGemini3 = /gemini-?3/i.test(cfg.model);
        return isGemini3
            ? { google: { thinkingConfig: { thinkingLevel: effort } } }
            : {
                  google: {
                      thinkingConfig: { thinkingBudget: EFFORT_TO_BUDGET[effort] },
                  },
              };
    },

    // ── Phase 3: real usage extraction (D-01 / Q4) ──────────────────────────
    // Consumes the ai@7 generateText result's high-level LanguageModelUsage. A1
    // (code-verified): @ai-sdk/google maps thoughtsTokenCount -> outputTokens.reasoning
    // and candidatesTokenCount -> outputTokens.text, with outputTokens.total already
    // INCLUDING thoughts; generateText flattens that to
    // usage.outputTokenDetails.reasoningTokens. So the generic reader below splits
    // reasoning correctly for a Gemini thinking call and yields 0 for a plain one.
    // output is the FULL completion count and is NEVER reduced by reasoning (Q4).
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
        { key: 'baseURL', label: 'Base URL', type: 'url', required: false, scope: 'top' },
    ],
};

registerProvider(googleGeminiModule);
