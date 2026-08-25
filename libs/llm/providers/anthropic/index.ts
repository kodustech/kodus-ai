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
import { withThinkingSignatureRepair } from './thinking-repair';
import { anthropicModelListing } from './listing';
import type {
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from '../kernel/types';
import {
    resolveCompatibleReasoningTraits,
    type ModelReasoningTraits,
} from '../kernel/reasoning-traits';
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
    doc: 'https://docs.anthropic.com/en/docs/about-claude/models',

    settingsSchema: z.object({ baseURL: z.string().optional() }),

    // Curated Anthropic models — the brand owns its own catalog (migrated from the
    // web `curated-models.json`). Native transport, so no per-model `provider`
    // override; the aggregator stamps providerKey/providerDisplayName = anthropic.
    catalog: [
        {
            id: 'claude-sonnet-4-6',
            displayName: 'Claude Sonnet 4.6',
            tier: 'recommended',
            recommendationLabel: 'Best balance',
            benchmarkScore: 88,
            description:
                'Latest Anthropic Sonnet. Strong balance of quality and cost for day-to-day code review.',
            speed: 'medium',
            contextWindow: '200K',
            costTier: '$$$',
            apiKeyUrl: 'https://console.anthropic.com/settings/keys',
            defaults: {
                temperature: 0,
                maxOutputTokens: 16384,
                reasoningEffort: 'medium',
            },
        },
        {
            id: 'claude-opus-4-7',
            displayName: 'Claude Opus 4.7',
            tier: 'recommended',
            recommendationLabel: 'Highest quality',
            benchmarkScore: 91,
            description:
                'Anthropic flagship. Highest quality for the hardest reviews — at premium cost.',
            speed: 'slow',
            contextWindow: '1M',
            costTier: '$$$',
            apiKeyUrl: 'https://console.anthropic.com/settings/keys',
            defaults: {
                temperature: 0,
                maxOutputTokens: 32768,
                reasoningEffort: 'medium',
            },
        },
        {
            id: 'claude-sonnet-4-5-20250929',
            displayName: 'Claude Sonnet 4.5',
            tier: 'other',
            benchmarkScore: 87.1,
            description:
                'Previous Sonnet generation. Still solid, but superseded by Sonnet 4.6.',
            speed: 'medium',
            contextWindow: '200K',
            costTier: '$$$',
            strengths: [
                'Catches ~5% more cross-file issues than average',
                'Broader coverage than most models',
            ],
            weaknesses: ['Slightly noisier — a few more low-value comments'],
            apiKeyUrl: 'https://console.anthropic.com/settings/keys',
            defaults: { temperature: 0, maxOutputTokens: 16384 },
        },
        {
            id: 'claude-haiku-4-5-20251001',
            displayName: 'Claude Haiku 4.5',
            tier: 'bestValue',
            benchmarkScore: 85.0,
            description: 'Fastest Claude with highest coverage. Good cheap fallback.',
            speed: 'fast',
            contextWindow: '200K',
            costTier: '$',
            strengths: [
                'Catches the most issues of any model',
                'Fast — replies in ~17s',
            ],
            weaknesses: ['Noisier — more low-value comments'],
            apiKeyUrl: 'https://console.anthropic.com/settings/keys',
            defaults: { temperature: 0, maxOutputTokens: 8192 },
        },
    ],

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
            //
            // Compatible upstreams (Kimi/Z.ai/DeepSeek) emit `thinking` blocks with
            // no `signature`, which @ai-sdk/anthropic@4's schema rejects → repair the
            // response before it parses. No-op for native Anthropic (always signed).
            return createAnthropic({
                apiKey: cfg.apiKey,
                baseURL: `${anthropicCompatibleRootURL(cfg.baseURL || '')}/v1`,
                fetch: withThinkingSignatureRepair(fetch),
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
            // "Off" must be said OUT LOUD on every model that thinks by default,
            // or the user who picked Off still pays for thinking — and worse, a
            // structured (forced-tool_choice) call 400s with "tool_choice
            // 'required' is incompatible with thinking enabled".
            //
            // anthropic_compatible: the compatible THINKING models (Kimi K2.5/K2.6,
            // GLM ≤5.2, DeepSeek) enable thinking by DEFAULT and accept
            // `{ type: 'disabled' }` — omitting it leaves thinking ON (the PR#144-146
            // Kody-Rules failure). But the ALWAYS-thinking ones (Kimi k2.7-code/k3,
            // GLM-5.3) expose NO disable and would REJECT the field — for those,
            // omitting IS the only "off". Decide per model via the shared traits.
            if ((cfg.provider as string) === 'anthropic_compatible') {
                return resolveCompatibleReasoningTraits(cfg.model)
                    .canDisableThinking
                    ? { anthropic: { thinking: { type: 'disabled' } } }
                    : {};
            }
            // Native Anthropic: only the adaptive generation both thinks-by-default
            // AND accepts `disabled`; legacy models don't think unasked and
            // Fable/Mythos reject `disabled` (400) — for those, omitting IS "off".
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
        //
        // KNOWN CAVEAT (k3 / GLM-5.3): the newest generations control reasoning
        // with a TOP-LEVEL `reasoning_effort` (low/high/max), NOT a thinking
        // budget — and that param isn't expressible through the anthropic
        // providerOptions namespace this transport uses. It's non-blocking: these
        // models ALWAYS reason (canDisableThinking=false), a structured call on
        // them REROUTES to json (no reasoning param sent to force a tool), and a
        // finder call gets a budget hint they simply ignore. A faithful
        // reasoning_effort needs the /v1 (OpenAI) transport — deferred until a k3
        // slot exists to verify against.
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

    // Per-model reasoning facts — native Claude from its own trait resolver;
    // anthropic_compatible (Kimi/GLM/DeepSeek/unknown) from the shared table.
    reasoningTraits(cfg: ProviderBuildConfig): ModelReasoningTraits {
        if ((cfg.provider as string) === 'anthropic_compatible') {
            return resolveCompatibleReasoningTraits(cfg.model);
        }
        const t = resolveAnthropicModelTraits(cfg.model);
        // Only the adaptive generation (4.6+, 5.x, Fable/Mythos) thinks by default;
        // budget (3.7–4.5) and unknown do not. Native Claude always speaks the
        // tool-use protocol and rejects a forced tool_choice while thinking.
        return {
            thinksByDefault: t.thinkingShape === 'adaptive',
            canDisableThinking: t.canDisableThinking,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: true,
        };
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
    // Native Anthropic accepts the adaptive thinking shape (the form every Claude
    // 4.6+ takes); an anthropic_compatible upstream isn't the brand, so it falls
    // back to the generic enabled-thinking example (undefined here).
    reasoningOverrideExample: (id) =>
        id === 'anthropic_compatible'
            ? undefined
            : '{\n  "thinking": { "type": "adaptive" },\n  "effort": "high"\n}',
    modelListing: anthropicModelListing,
};

registerProvider(anthropicModule);
