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
import {
    anthropicReasoningConfig,
    resolveAnthropicModelTraits,
    supportsSamplingParams,
} from './traits';
import { registerProvider } from '../kernel/registry';
import { anthropicEphemeralCacheHint } from '../kernel/anthropic-cache';
import { anthropicModelListing } from './listing';
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

/** Claude families that support the newer adaptive thinking (type:'adaptive'
 *  + effort); older families use enabled + budgetTokens. Delegates to the
 *  single model-generation source so 4.6/4.7+/5 and the `anthropic:` /
 *  `anthropic.` / `@date` id spellings all resolve the same way here as they
 *  do in reasoning-options — the previous inline regex only knew 4.6–4.x and
 *  silently mis-classified every Claude 5. */
export const anthropicModule: ProviderModule = {
    id: 'anthropic',
    aliases: ['anthropic_compatible'],
    label: 'Anthropic',

    settingsSchema: z.object({ baseURL: z.string().optional() }),

    capabilities(model: string): ModelCapabilities {
        const reasoningConfig = anthropicReasoningConfig(model);
        return {
            supportsTemperature: true,
            supportsReasoning: !!reasoningConfig,
            reasoningConfig,
            // Anthropic does structured output via tool use, not a native
            // response_format json_schema → 'none' at this tier.
            structuredOutput: 'none',
            toolCalling: 'native',
            // A1 (code-verified, 03-10): @ai-sdk/anthropic sets
            // outputTokens.reasoning = void 0 — Anthropic's Messages API `usage`
            // reports NO separate thinking-token count (thinking is billed INTO
            // output_tokens). So usage is 'output_only' even for extended-thinking
            // models; supportsReasoning (above) is about REQUESTING thinking, which
            // is a different axis from how usage is REPORTED. The D-05 conformance
            // asserts this match against the captured fixture.
            usageGranularity: 'output_only',
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
        if (effort === 'none') {
            // "Off" must be said OUT LOUD on the models that think by default
            // (Opus 5, Sonnet 5), or the user who picked Off still pays for
            // thinking. Only the adaptive generation both thinks-by-default AND
            // accepts `disabled`; legacy models don't think unasked, Fable/Mythos
            // reject `disabled` (400), and anthropic_compatible never thinks by
            // default — for all three, omitting the config IS "off".
            if ((cfg.provider as string) === 'anthropic_compatible') return {};
            const traits = resolveAnthropicModelTraits(cfg.model);
            return traits.thinkingShape === 'adaptive' && traits.canDisableThinking
                ? { anthropic: { thinking: { type: 'disabled' } } }
                : {};
        }

        const budget: ProviderReasoningOptions = {
            anthropic: {
                thinking: { type: 'enabled', budgetTokens: EFFORT_TO_BUDGET[effort] },
            },
        };

        // Compatible endpoints (Kimi/Z.ai/DeepSeek) never implement adaptive
        // thinking → always budget, whatever the id looks like.
        if ((cfg.provider as string) === 'anthropic_compatible') {
            return budget;
        }

        // Native Anthropic: send the shape the model actually accepts. Claude
        // 4.7+/5 REJECT budgetTokens (hard 400), so an UNIDENTIFIED id — the
        // code-review loop passes an agent name, or nothing — must OMIT the
        // config rather than gamble on budget and 400 the entire review.
        switch (resolveAnthropicModelTraits(cfg.model).thinkingShape) {
            case 'adaptive':
                return { anthropic: { thinking: { type: 'adaptive' }, effort } };
            case 'budget':
                return budget;
            default:
                return {};
        }
    },

    // The anthropic protocol (native AND anthropic_compatible endpoints) accepts
    // an ephemeral cacheControl on the system message → the long static system
    // prompt is written to cache once and read on every subsequent loop step. A
    // compatible upstream that doesn't honor it ignores the namespace (no-op).
    systemCacheControl(): Record<string, unknown> {
        return anthropicEphemeralCacheHint();
    },

    // ── Phase 3: real usage extraction (D-01 / Q4) ──────────────────────────
    // Consumes the ai@7 generateText result's high-level LanguageModelUsage (the
    // same shape observability.service.ts reads): inputTokens/outputTokens are
    // numbers, reasoning is nested under outputTokenDetails.reasoningTokens (ai@7)
    // with a flat reasoningTokens fallback (ai@6). A1 (code-verified): the
    // @ai-sdk/anthropic adapter never populates reasoning (outputTokens.reasoning =
    // void 0), so this reads 0 for native anthropic — the generic reader is kept so
    // an anthropic-compatible upstream that DOES surface a split still works. output
    // is the FULL completion count and is NEVER reduced by reasoning (Q4 double-count
    // trap: reasoning is additive info only).
    supportsSamplingParams(cfg: ProviderBuildConfig): boolean {
        // Only the REAL anthropic endpoint withholds sampling params on 4.7+
        // (a 400 otherwise). `anthropic_compatible` upstreams (Kimi/Z.ai/DeepSeek)
        // implement the legacy shape and accept temperature — never gate them.
        return (cfg.provider as string) === 'anthropic_compatible'
            ? true
            : supportsSamplingParams(true, cfg.model);
    },

    normalizeUsage: normalizeSdkUsage,
    normalize: normalizeSdkResult,

    uiFields: [
        { key: 'apiKey', label: 'API key', type: 'password', required: true, scope: 'top' },
        { key: 'baseURL', label: 'Base URL', type: 'url', required: false, scope: 'top' },
    ],
    providerOptionsNamespace: () => 'anthropic',
    modelListing: anthropicModelListing,
};

registerProvider(anthropicModule);
