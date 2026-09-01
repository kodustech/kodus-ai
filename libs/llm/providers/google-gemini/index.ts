/**
 * Google Gemini provider module (Phase 1, plan 01-02) — id `google_gemini`.
 * Reproduces byok-to-vercel.ts's GOOGLE_GEMINI case (native @ai-sdk/google).
 * Gemini-on-Vertex is a SEPARATE id (google_vertex) handled by the vertex module.
 */
import type { LanguageModel } from 'ai';
import { EFFORT_TO_BUDGET } from '../kernel/effort-budget';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { registerProvider } from '../kernel/registry';
import { geminiReasoningConfig } from './reasoning';
import {
    NON_REASONING_TRAITS,
    type ModelReasoningTraits,
} from '../kernel/reasoning-traits';
import { googleGeminiModelListing } from './listing';
import type {
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from '../kernel/types';
import type { TemperaturePolicy } from '../kernel/model-types';
import { normalizeSdkResult, normalizeSdkUsage } from '../kernel/usage';

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

    settingsSchema: z.object({ baseURL: z.string().optional() }),

    capabilities(model: string): ModelCapabilities {
        const reasoningConfig = geminiReasoningConfig(model);
        return {
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

    /**
     * Per-model reasoning facts. Gemini used to declare NONE of these and
     * inherited `NON_REASONING_TRAITS` — so `planStructuredCall` was deciding
     * for 91 production slots from defaults nobody had checked against Google's
     * docs, and the module could not state that its models reason without the
     * family-default policy overriding Google's own thinking level.
     *
     * Sources: ai.google.dev/gemini-api/docs/thinking and
     * firebase.google.com/docs/ai-logic/thinking.
     */
    reasoningTraits(cfg: ProviderBuildConfig): ModelReasoningTraits {
        const config = geminiReasoningConfig(cfg.model);
        if (!config) return NON_REASONING_TRAITS;

        const m = (cfg.model ?? '').toLowerCase();
        // 2.5 Flash-Lite ships with thinking OFF (documented default budget 0);
        // every other thinking-capable Gemini reasons unless told otherwise.
        const thinksByDefault = !/gemini-2\.5-flash-lite/.test(m);
        // Documented: 2.5 Flash and Flash-Lite disable with budget 0; 2.5 Pro
        // "cannot be disabled", and the 3.x level scale exposes no off value.
        const canDisableThinking = /gemini-2\.5-flash/.test(m);

        return {
            thinksByDefault,
            canDisableThinking,
            // Gemini takes a forced tool choice via
            // toolConfig.functionCallingConfig.mode = ANY, and does not reject it
            // while thinking (that is an Anthropic-protocol rule).
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: false,
            // The reason this fact had to become declarable:every Gemini model
            // carries its own documented default thinking level, so sending NO
            // thinkingConfig leaves THAT in force rather than turning reasoning
            // off. Imposing our 'medium' would replace a better default.
            omittingDisablesReasoning: false,
        };
    },

    /** Gemini accepts a sampling temperature on every model, thinking or not —
     *  stated here so no caller has to fall back to guessing. */
    temperaturePolicy(): TemperaturePolicy {
        return { kind: 'adjustable' };
    },

    reasoning(
        cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions {
        if (effort === 'none') return {};

        // The model's OWN reasoning config decides both the shape and the legal
        // range. Three things depended on that and were previously guessed:
        //   - a model with NO thinking (plain gemini-2.0 and older) must get no
        //     thinkingConfig at all — the field is unsupported there, not ignored;
        //   - Gemini 3 takes a level, Gemini 2.5 a budget, and Google documents
        //     the two as "completely incompatible";
        //   - the 2.5 budget has a documented per-model ceiling (Pro 32,768 /
        //     Flash and Flash-Lite 24,576) and our shared `high` = 40,000 blew
        //     through every one of them.
        const config = geminiReasoningConfig(cfg.model);
        if (!config) return {};

        if (config.type === 'level') {
            // Round UP to a level the model actually accepts rather than sending
            // one it rejects: gemini-3-pro-preview has no 'medium'.
            const level = config.options.includes(effort as any)
                ? effort
                : effort === 'medium'
                  ? 'high'
                  : config.options[config.options.length - 1];
            return { google: { thinkingConfig: { thinkingLevel: level } } };
        }

        if (config.type === 'budget') {
            const { min, max } = config.options;
            const budget = Math.min(
                Math.max(EFFORT_TO_BUDGET[effort], min),
                max ?? EFFORT_TO_BUDGET[effort],
            );
            return { google: { thinkingConfig: { thinkingBudget: budget } } };
        }

        // `adaptive` is the ANTHROPIC shape; `geminiReasoningConfig` never
        // returns it. Handled explicitly rather than by falling into the budget
        // branch, where `options` is a list of levels and the numeric read would
        // produce `thinkingBudget: NaN`.
        return {};
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
        },
    ],
    providerOptionsNamespace: () => 'google',
    // The example has to follow the MODEL's generation, not the provider: Gemini
    // 3 takes a qualitative thinkingLevel and 2.5 a numeric thinkingBudget, and
    // Google documents the two as completely incompatible. Suggesting the 2.5
    // shape to a Gemini 3 user (68 of 91 production Gemini slots are 3.x) hands
    // them a parameter their model does not implement.
    reasoningOverrideExample: (_id, model) =>
        geminiReasoningConfig(model)?.type === 'budget'
            ? '{\n  "thinkingConfig": { "thinkingBudget": 16000 }\n}'
            : '{\n  "thinkingConfig": { "thinkingLevel": "high" }\n}',
    modelListing: googleGeminiModelListing,
};

registerProvider(googleGeminiModule);
