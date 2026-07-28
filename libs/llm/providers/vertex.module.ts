/**
 * Google Vertex provider module (Phase 1, plan 01-02) — id `google_vertex`.
 * Reproduces byok-to-vercel.ts's GOOGLE_VERTEX case: BYOK Vertex keys are
 * base64-encoded Service Account JSON; `claude-*` ids route through the Anthropic
 * protocol INSIDE vertexModelFromSaJson (so Claude-on-Vertex needs no separate
 * provider id). Falls back to AI Studio if the value isn't a valid SA JSON.
 */
import type { LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { vertexModelFromSaJson } from '@libs/llm/model-builders';
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

export const vertexModule: ProviderModule = {
    id: 'google_vertex',
    label: 'Google Vertex AI',

    // vertexLocation lives at the top level of the BYOK config today.
    settingsSchema: z.object({ vertexLocation: z.string().optional() }),

    capabilities(model: string): ModelCapabilities {
        const reasoner = /^claude[-_]/i.test(model) || /gemini-(2\.5|3)/i.test(model);
        const reasoningConfig: ModelCapabilities['reasoningConfig'] = reasoner
            ? { type: 'budget', options: { min: 128, default: 3000 } }
            : undefined;
        return {
            supportsTemperature: true,
            supportsReasoning: !!reasoningConfig,
            reasoningConfig,
            structuredOutput: 'json_schema',
            toolCalling: 'native',
            usageGranularity: 'reasoning_split',
            streaming: true,
            promptCaching: true,
        };
    },

    build(cfg: ProviderBuildConfig): LanguageModel {
        // apiKey is the ALREADY-DECRYPTED base64 SA JSON.
        const model = vertexModelFromSaJson(cfg.apiKey, cfg.model, cfg.vertexLocation);
        if (model) return model;
        // Degraded fallback: not a valid SA JSON (e.g. a plain AIzaSy… key typed
        // into the Vertex slot) → treat as AI Studio.
        return createGoogleGenerativeAI({ apiKey: cfg.apiKey })(cfg.model);
    },

    reasoning(
        _cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions {
        if (effort === 'none') return {};
        // Matches byok-to-vercel's GOOGLE_VERTEX reasoning (google thinkingConfig),
        // which does not special-case Claude-on-Vertex today. Refined in 01-04.
        const isGemini3 = /gemini-?3/i.test(_cfg.model);
        return isGemini3
            ? { google: { thinkingConfig: { thinkingLevel: effort } } }
            : { google: { thinkingConfig: { thinkingBudget: EFFORT_TO_BUDGET[effort] } } };
    },

    normalizeUsage(_raw: unknown): NormalizedUsage {
        return { input: 0, output: 0, reasoning: 0 };
    },
    normalize(raw: unknown): ModelResult {
        return { usage: { input: 0, output: 0, reasoning: 0 }, raw };
    },

    uiFields: [
        { key: 'apiKey', label: 'Service Account JSON', type: 'password', required: true, scope: 'top' },
        { key: 'vertexLocation', label: 'Location', type: 'text', required: false, scope: 'settings', placeholder: 'global' },
    ],
};

registerProvider(vertexModule);
