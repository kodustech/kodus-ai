/**
 * Google Gemini provider module (Phase 1, plan 01-02) — id `google_gemini`.
 * Reproduces byok-to-vercel.ts's GOOGLE_GEMINI case (native @ai-sdk/google).
 * Gemini-on-Vertex is a SEPARATE id (google_vertex) handled by the vertex module.
 */
import type { LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { registerProvider } from '../kernel/registry';
import { geminiReasoningConfig } from './reasoning';
import { googleGeminiModelListing } from './listing';
import type {
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from '../kernel/types';
import {
    normalizeSdkResult,
    normalizeSdkUsage,
} from '../kernel/usage';

/** Effort → thinking budget (mirrors reasoning-options.ts EFFORT_TO_BUDGET;
 *  local copy keeps this module free of a runtime LangChain import). */
const EFFORT_TO_BUDGET: Record<ReasoningEffort, number> = {
    none: 0,
    low: 5_000,
    medium: 15_000,
    high: 40_000,
};

/** Per-model input-token ceiling for the managed Gemini catalog (only the
 *  models whose window differs from the chunking default need an entry). Moved
 *  here from the old MODEL_INPUT_MAX_TOKENS table so the window lives with the
 *  provider. Keyed by the bare model id (no `google:` prefix). */
const GEMINI_MAX_INPUT_TOKENS: Record<string, number> = {
    'gemini-2.5-pro': 1_000_000,
    'gemini-3.1-flash-lite-preview': 1_048_576,
};

export const googleGeminiModule: ProviderModule = {
    id: 'google_gemini',
    label: 'Google Gemini',
    doc: 'https://ai.google.dev/gemini-api/docs/models',

    // Curated Google models (migrated from the web curated-models.json). Native
    // transport ⇒ no per-model `provider` override.
    catalog: [
        {
            id: 'gemini-3.1-pro-preview-customtools',
            displayName: 'Gemini 3.1 Pro (custom tools)',
            tier: 'recommended',
            benchmarkScore: 87,
            description:
                'Google flagship variant with custom-tools support. Massive 1M context window.',
            speed: 'medium',
            contextWindow: '1M',
            costTier: '$$$',
            apiKeyUrl: 'https://aistudio.google.com/apikey',
            defaults: {
                temperature: 0,
                maxOutputTokens: 16384,
                reasoningEffort: 'medium',
            },
        },
        {
            id: 'gemini-3-flash-preview',
            displayName: 'Gemini 3 Flash',
            tier: 'recommended',
            recommendationLabel: 'Most affordable',
            benchmarkScore: 83.9,
            description: 'Largest context window at lowest cost.',
            speed: 'medium',
            contextWindow: '1M',
            costTier: '$',
            strengths: [
                'Reliable — rarely errors out',
                'Clean — few low-value comments',
            ],
            weaknesses: ['Catches fewer issues than average'],
            apiKeyUrl: 'https://aistudio.google.com/apikey',
            defaults: { temperature: 0, maxOutputTokens: 8192 },
        },
        {
            id: 'gemini-2.5-pro',
            displayName: 'Gemini 2.5 Pro',
            tier: 'other',
            benchmarkScore: 86.8,
            description:
                'Previous Gemini Pro generation. Superseded by Gemini 3.1 Pro.',
            speed: 'medium',
            contextWindow: '1M',
            costTier: '$$',
            strengths: [
                'Very clean — few low-value comments',
                'Strong at spotting logic bugs within a file',
            ],
            weaknesses: ['Catches fewer issues than average'],
            apiKeyUrl: 'https://aistudio.google.com/apikey',
            defaults: { temperature: 0, maxOutputTokens: 16384 },
        },
        {
            id: 'gemini-3.1-pro-preview',
            displayName: 'Gemini 3.1 Pro',
            tier: 'other',
            benchmarkScore: 84.2,
            description:
                'Base Gemini 3.1 Pro without custom tools. Prefer the custom-tools variant above.',
            speed: 'slow',
            contextWindow: '1M',
            costTier: '$$$',
            strengths: [
                'Strong at spotting logic bugs within a file',
                'Clean — few low-value comments',
            ],
            weaknesses: ['Weaker at cross-file issues than most'],
            apiKeyUrl: 'https://aistudio.google.com/apikey',
            defaults: { temperature: 0, maxOutputTokens: 16384 },
        },
    ],

    settingsSchema: z.object({ baseURL: z.string().optional() }),

    capabilities(model: string): ModelCapabilities {
        const reasoningConfig = geminiReasoningConfig(model);
        return {
            supportsTemperature: true,
            supportsReasoning: !!reasoningConfig,
            reasoningConfig,
            structuredOutput: 'json_schema', // Gemini responseSchema
            toolCalling: 'native',
            usageGranularity: 'reasoning_split',
            streaming: true,
            promptCaching: true,
            // Context window for the managed-catalog models whose window differs
            // materially from the chunking default (the single home for it, read
            // by tokenChunking via managedModelMaxInputTokens). Other Gemini
            // models fall to the caller default.
            maxInputTokens: GEMINI_MAX_INPUT_TOKENS[model],
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
    normalizeUsage: normalizeSdkUsage,
    normalize: normalizeSdkResult,

    uiFields: [
        { key: 'apiKey', label: 'API key', type: 'password', required: true, scope: 'top' },
        { key: 'baseURL', label: 'Base URL', type: 'url', required: false, scope: 'top' },
    ],
    providerOptionsNamespace: () => 'google',
    reasoningOverrideExample: () =>
        '{\n  "thinkingConfig": { "thinkingBudget": 16000 }\n}',
    modelListing: googleGeminiModelListing,
};

registerProvider(googleGeminiModule);
