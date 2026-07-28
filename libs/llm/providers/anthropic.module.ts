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

/** Claude families that support the newer adaptive thinking (type:'adaptive'
 *  + effort); older families use enabled + budgetTokens. Mirrors reasoning-options. */
function isAdaptiveCapable(model: string): boolean {
    return (
        /claude-(opus|sonnet)-4-[6-9]/i.test(model) ||
        /claude-(opus|sonnet)-4-\d{2,}/i.test(model) ||
        model.includes('mythos')
    );
}

export const anthropicModule: ProviderModule = {
    id: 'anthropic',
    aliases: ['anthropic_compatible'],
    label: 'Anthropic',

    settingsSchema: z.object({ baseURL: z.string().optional() }),

    capabilities(model: string): ModelCapabilities {
        const claude = /^claude[-_]/i.test(model);
        const reasoningConfig: ModelCapabilities['reasoningConfig'] = !claude
            ? undefined
            : isAdaptiveCapable(model)
              ? { type: 'adaptive', options: ['low', 'medium', 'high'] }
              : { type: 'budget', options: { min: 1024, default: 3000 } };
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
        if (effort === 'none') return {};
        // Compatible endpoints never implement adaptive thinking → always budget.
        if (
            (cfg.provider as string) !== 'anthropic_compatible' &&
            isAdaptiveCapable(cfg.model)
        ) {
            return { anthropic: { thinking: { type: 'adaptive' }, effort } };
        }
        return {
            anthropic: {
                thinking: { type: 'enabled', budgetTokens: EFFORT_TO_BUDGET[effort] },
            },
        };
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

registerProvider(anthropicModule);
