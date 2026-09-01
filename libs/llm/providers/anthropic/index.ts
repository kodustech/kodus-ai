/**
 * Anthropic provider module (Phase 1, plan 01-02) — serves `anthropic` (native
 * @ai-sdk/anthropic) and `anthropic_compatible` (Kimi Code, Z.ai, DeepSeek —
 * same SDK, baseURL normalized to a `/v1` suffix). Reproduces byok-to-vercel.ts's
 * ANTHROPIC / ANTHROPIC_COMPATIBLE cases.
 */
import type { LanguageModel } from 'ai';
import { EFFORT_TO_BUDGET } from '../kernel/effort-budget';
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
    ProviderBuildOptions,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from '../kernel/types';
import type { TemperaturePolicy } from '../kernel/model-types';
import {
    resolveCompatibleReasoningTraits,
    compatibleTemperaturePolicy,
    type ModelReasoningTraits,
} from '../kernel/reasoning-traits';
import { normalizeSdkResult, normalizeSdkUsage } from '../kernel/usage';



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

    capabilities(model: string): ModelCapabilities {
        const reasoningConfig = anthropicReasoningConfig(model);
        return {
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

    build(
        cfg: ProviderBuildConfig,
        opts?: ProviderBuildOptions,
    ): LanguageModel {
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
                // Compose, don't replace: a caller-supplied transport (the
                // probe's redirect-refusing fetch) still needs the signature
                // repair, and the repair still needs the caller's guard.
                fetch: withThinkingSignatureRepair(opts?.fetch ?? fetch),
            })(cfg.model);
        }
        return createAnthropic({
            apiKey: cfg.apiKey,
            ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
            ...(opts?.fetch ? { fetch: opts.fetch } : {}),
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
            return traits.thinkingShape === 'adaptive' &&
                traits.canDisableThinking
                ? { anthropic: { thinking: { type: 'disabled' } } }
                : {};
        }

        const budget: ProviderReasoningOptions = {
            anthropic: {
                thinking: {
                    type: 'enabled',
                    budgetTokens: EFFORT_TO_BUDGET[effort],
                },
            },
        };

        // Compatible endpoints hosting a NON-Claude brand (Kimi/Z.ai/DeepSeek)
        // never implement adaptive thinking → budget. The id is what decides,
        // NOT the transport: a real Claude proxied over this endpoint is handled
        // just below, because 4.7+ reject the budget shape outright.
        //
        // KNOWN CAVEAT (k3 / GLM-5.3): the newest generations control reasoning
        // with a TOP-LEVEL `reasoning_effort` (low/high/max), NOT a thinking
        // budget — and that param isn't expressible through the anthropic
        // providerOptions namespace this transport uses. It's non-blocking: these
        // models ALWAYS reason (canDisableThinking=false), a structured call on
        // them REROUTES to json (no reasoning param sent to force a tool), and a
        // finder call gets a budget hint they simply ignore. A faithful
        // reasoning_effort needs the /v1 (OpenAI) transport, where the openai
        // module now emits it from the same trait table (`effortScale`). Three
        // production slots run a bare `k3` id, so this caveat is live, not
        // hypothetical.
        if ((cfg.provider as string) === 'anthropic_compatible') {
            // An 'effort-only' brand (MiniMax) has no `thinking` object, and its
            // `reasoning_effort` is a TOP-LEVEL field this transport's
            // providerOptions namespace cannot express — the same limit as the
            // k3 / GLM-5.3 caveat above. So send nothing rather than a field the
            // model does not have: it keeps the brand's own default (medium)
            // instead of risking a rejected body. The faithful effort needs the
            // OpenAI transport, where the openai module now emits it.
            if (
                resolveCompatibleReasoningTraits(cfg.model)
                    .reasoningControl === 'effort-only'
            ) {
                return {};
            }
            // A REAL Claude id proxied over a compatible endpoint is still a
            // Claude, and the id says so. Claude 4.7 / 4.8 / Opus 5 / Sonnet 5 /
            // Fable / Mythos REJECT `thinking:{type:'enabled'}` with a 400 - so
            // the blanket budget shape below is a guaranteed failure for them.
            // The generation resolver is anchored on `^claude-`, so a Kimi/GLM/
            // DeepSeek id can never reach this branch and still gets `budget`.
            const claude = resolveAnthropicModelTraits(cfg.model);
            if (claude.thinkingShape === 'adaptive') {
                return {
                    anthropic: { thinking: { type: 'adaptive' }, effort },
                };
            }
            return budget;
        }

        // Native Anthropic: send the shape the model actually accepts. Claude
        // 4.7+/5 REJECT budgetTokens (hard 400), so an UNIDENTIFIED id — the
        // code-review loop passes an agent name, or nothing — must OMIT the
        // config rather than gamble on budget and 400 the entire review.
        switch (resolveAnthropicModelTraits(cfg.model).thinkingShape) {
            case 'adaptive':
                return {
                    anthropic: { thinking: { type: 'adaptive' }, effort },
                };
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
    temperaturePolicy(cfg: ProviderBuildConfig): TemperaturePolicy {
        // `anthropic_compatible` upstreams (Kimi/Z.ai/DeepSeek) implement the legacy
        // shape and ACCEPT temperature — but the always-thinking ones (Kimi
        // k2.7-code/k3, GLM-5.3) reason UNCONDITIONALLY, and the Anthropic protocol
        // pins temperature to 1 while thinking, so 1 is their only sound value.
        // Disable-able ones (Kimi k2.6, DeepSeek) keep a free temperature.
        if ((cfg.provider as string) === 'anthropic_compatible') {
            return compatibleTemperaturePolicy(cfg.model, cfg.reasoningEffort);
        }
        // Real Anthropic: 4.7+ REJECT temperature (a 400); older accept it. Native
        // thinking models don't need a pin — they withhold temperature outright.
        return supportsSamplingParams(true, cfg.model)
            ? { kind: 'adjustable' }
            : { kind: 'unsupported' };
    },

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
