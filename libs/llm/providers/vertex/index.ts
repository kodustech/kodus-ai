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
import { registerProvider } from '../kernel/registry';
import { reasoningConfigForModel } from '../kernel/model-reasoning';
import {
    anthropicEphemeralCacheHint,
    isAnthropicModel,
} from '../kernel/anthropic-cache';
import { anthropicModule } from '../anthropic';
import {
    NON_REASONING_TRAITS,
    type ModelReasoningTraits,
} from '../kernel/reasoning-traits';
import { vertexModelListing } from './listing';
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

const EFFORT_TO_BUDGET: Record<ReasoningEffort, number> = {
    none: 0,
    low: 5_000,
    medium: 15_000,
    high: 40_000,
};

export const vertexModule: ProviderModule = {
    id: 'google_vertex',
    label: 'Google Vertex AI',
    doc: 'https://cloud.google.com/vertex-ai/generative-ai/docs/models',

    // vertexLocation lives at the top level of the BYOK config today.
    settingsSchema: z.object({ vertexLocation: z.string().optional() }),

    capabilities(model: string): ModelCapabilities {
        // Vertex serves both Claude and Gemini; reasoning is resolved centrally
        // by family (was a local `budget`-for-everything regex, wrong for the
        // adaptive-only Claude 4.7+/5 line).
        const reasoningConfig = reasoningConfigForModel(model);
        return {
            supportsTemperature: true,
            supportsReasoning: !!reasoningConfig,
            reasoningConfig,
            // Claude-on-Vertex speaks the Anthropic protocol → structured output is
            // forced tool-use ('none'); Gemini-on-Vertex uses responseSchema
            // ('json_schema'). Must be model-aware or a structured Claude call is
            // mistaken for response_format.
            structuredOutput: isAnthropicModel(model) ? 'none' : 'json_schema',
            toolCalling: 'native',
            usageGranularity: 'reasoning_split',
            streaming: true,
            promptCaching: true,
            // Managed-catalog window (moved off the old MODEL_INPUT_MAX_TOKENS
            // table). The legacy Claude-3.5-on-Vertex id is the only Vertex model
            // that pinned a window; others fall to the chunking default.
            maxInputTokens: /^claude-3-5-sonnet/.test(model)
                ? 200_000
                : undefined,
        };
    },

    // Claude-on-Vertex (`@ai-sdk/google-vertex/anthropic`) honors the same inline
    // `anthropic.cacheControl` marker as native Anthropic; Gemini-on-Vertex caches
    // IMPLICITLY (no marker), so only Claude ids get the hint.
    systemCacheControl(cfg: ProviderBuildConfig): Record<string, unknown> | undefined {
        return isAnthropicModel(cfg.model)
            ? anthropicEphemeralCacheHint()
            : undefined;
    },

    // Claude-on-Vertex speaks the Anthropic thinking protocol → resolve its facts
    // through the anthropic module (native Claude branch). Gemini-on-Vertex does
    // structured via responseSchema (no forced tool_choice) → the safe default.
    reasoningTraits(cfg: ProviderBuildConfig): ModelReasoningTraits {
        return isAnthropicModel(cfg.model)
            ? anthropicModule.reasoningTraits!(cfg)
            : NON_REASONING_TRAITS;
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
        // Claude-on-Vertex speaks the Anthropic thinking protocol (createVertexAnthropic
        // reuses the anthropic language model), so it must resolve reasoning through
        // the anthropic module — NOT google thinkingConfig. This makes `effort: 'none'`
        // say `{ anthropic: { thinking: { type: 'disabled' } } }` out loud for the
        // adaptive models that think by default (Opus/Sonnet 5) instead of omitting it
        // — otherwise a structured (forced-tool_choice) Kody Rules / dedup call 400s
        // with "tool_choice 'required' is incompatible with thinking enabled", the same
        // failure class as Kimi. Gemini-on-Vertex keeps the google thinkingConfig path.
        if (isAnthropicModel(_cfg.model)) {
            return anthropicModule.reasoning!(_cfg, effort);
        }
        if (effort === 'none') return {};
        const isGemini3 = /gemini-?3/i.test(_cfg.model);
        return isGemini3
            ? { google: { thinkingConfig: { thinkingLevel: effort } } }
            : { google: { thinkingConfig: { thinkingBudget: EFFORT_TO_BUDGET[effort] } } };
    },

    // ── Phase 3: real usage extraction (D-01 / Q4) ──────────────────────────
    // Consumes the ai@7 generateText result's high-level LanguageModelUsage. A1
    // (code-verified): @ai-sdk/google-vertex reuses the @ai-sdk/google usage mapping
    // (thoughtsTokenCount -> outputTokens.reasoning) for Gemini-on-Vertex; Claude-on-
    // Vertex folds thinking into output like native anthropic (no separate split).
    // generateText flattens outputTokens.reasoning -> usage.outputTokenDetails
    // .reasoningTokens, so the generic reader splits reasoning for a Gemini thinking
    // call and yields 0 otherwise. output is the FULL completion count and is NEVER
    // reduced by reasoning (Q4 double-count trap).
    normalizeUsage: normalizeSdkUsage,
    normalize: normalizeSdkResult,

    uiFields: [
        { key: 'apiKey', label: 'Service Account JSON', type: 'password', required: true, scope: 'top' },
        { key: 'vertexLocation', label: 'Location', type: 'text', required: false, scope: 'settings', placeholder: 'global' },
    ],
    providerOptionsNamespace: () => 'google',
    reasoningOverrideExample: () =>
        '{\n  "thinkingConfig": { "thinkingBudget": 16000 }\n}',
    modelListing: vertexModelListing,
};

registerProvider(vertexModule);
