import { createLogger } from '@libs/core/log/logger';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { LLM } from '@libs/llm/llm';
import { buildProviderOptions } from '@libs/llm/reasoning-options';
import {
    envManagedReasoningDescriptor,
    managedDefaultReasoningDescriptor,
} from '@libs/llm/managed-slot';
import type { LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';
import {
    buildFormatPrompt,
    parseFormatResponse,
    stripLabelsMechanically,
    type FormattedSuggestion,
    type SuggestionToFormat,
} from './format-prompt';

export type { FormattedSuggestion, SuggestionToFormat };

const logger = createLogger('SuggestionFormatter');

const FORMAT_TIMEOUT_MS = 90_000; // 90s — the secondary model can take >30s under load

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

/**
 * Reformat suggestion content from WHAT/WHY/HOW to natural prose,
 * and ensure improvedCode is populated.
 *
 * Plain BYOK text call through the ONE primitive (LLM.run): the passed slot
 * when configured, else the managed default — same model resolution, limiter,
 * reasoning and timeout as every other call. Respects custom writing guidelines
 * if provided. A missing/failed model — parse failure, provider error, or the
 * 90s timeout — degrades through the mechanical WHAT/WHY/HOW → prose strip
 * (stripLabelsMechanically) so the client never sees the raw scaffolding, and
 * logs at error level with org/PR metadata for attribution.
 *
 * Prompt + parse live in format-prompt.ts (shared with the format eval).
 */
export async function formatSuggestionContent(
    suggestions: SuggestionToFormat[],
    options?: {
        customWritingGuidelines?: string;
        byokConfig?: NormalizedModel;
        languageResultPrompt?: string;
        organizationId?: string;
        /** Full telemetry metadata (org/team/PR/repo) for Langfuse tracing. */
        telemetryMetadata?: LangfuseTelemetryMetadata;
        /**
         * Called when the formatter degrades to the mechanical fallback (parse
         * failure or provider error) instead of throwing — so the caller can
         * record `{ severity: 'partial', stage: 'suggestion-formatter' }` on the
         * execution and keep a degraded run from finishing as success (rule 15).
         */
        onDegraded?: (info: { reason: string; error?: unknown }) => void;
    },
): Promise<Map<number, FormattedSuggestion>> {
    if (suggestions.length === 0) {
        return new Map();
    }

    let langLabel: string | null = null;
    if (options?.languageResultPrompt) {
        try {
            langLabel =
                displayNames.of(options.languageResultPrompt) ||
                options.languageResultPrompt;
        } catch {
            langLabel = options.languageResultPrompt;
        }
    }

    // Force reasoning OFF for the formatter — it's a prose-rewrite step, not a
    // reasoning task. Without this, BYOK models that think by default (DeepSeek,
    // some Kimi/GLM) emit thousands of reasoning tokens and may hit the 90s timeout.
    //
    // Build through the SHARED buildProviderOptions (the same one every other
    // call resolves via resolveModelConfig) so the reasoning-off payload is
    // expressed per-provider WHILE the slot's OpenRouter routing pins
    // (openrouterProviderOrder / openrouterAllowFallbacks) survive — passing a
    // raw buildReasoningProviderOptions here would REPLACE the slot-derived
    // providerOptions in structured-review-call and silently drop the routing
    // pins. On the env/managed path (no BYOK slot) resolve the provider/model the
    // same way resolveModelConfig does, so the managed DeepSeek/Fireworks default
    // also gets thinking:disabled instead of {}.
    //
    // The managed default forwards `{ thinking: { type: 'disabled' } }` to
    // api.fireworks.ai for the first time (the old 'fireworks' instance name
    // dropped it). The field is a DOCUMENTED part of Fireworks' OpenAI-compatible
    // surface — https://docs.fireworks.ai/api-reference/post-completions: "type=
    // disabled always disables thinking", and DeepSeek V4 defaults reasoning ON
    // ('high'), so the disable is both accepted and required. If an upstream ever
    // rejects it, the catch path below degrades and reports through onDegraded —
    // a rejected payload is observable, never silently passed.
    const reasoningSlot =
        options?.byokConfig ??
        envManagedReasoningDescriptor() ??
        managedDefaultReasoningDescriptor();
    const formatterProviderOptions = buildProviderOptions(
        'suggestion-formatter',
        options?.telemetryMetadata,
        {
            reasoningEffort: 'none',
            byokProvider: reasoningSlot?.provider,
            modelName: reasoningSlot?.model,
            openrouterProviderOrder: options?.byokConfig?.openrouterProviderOrder,
            openrouterAllowFallbacks: options?.byokConfig?.openrouterAllowFallbacks,
        },
    );
    // An EMPTY payload (no provider resolved, or a model family with no
    // reasoning-off shape) must never become a truthy `{}` override that
    // replaces the funnel's own derivation in structured-review-call
    // (`providerOptionsOverride ?? providerOptions`). Only pass a concrete
    // disable; otherwise leave the funnel in charge.
    const hasFormattedProviderOptions =
        Object.keys(formatterProviderOptions).length > 0;

    try {
        const text = await LLM.run({
            byokConfig: options?.byokConfig,
            user: buildFormatPrompt(suggestions, {
                customWritingGuidelines: options?.customWritingGuidelines,
                languageLabel: langLabel,
            }),
            runName: 'suggestion-formatter',
            timeoutMs: FORMAT_TIMEOUT_MS,
            organizationId: options?.organizationId,
            telemetryMetadata: options?.telemetryMetadata,
            providerOptions: hasFormattedProviderOptions
                ? formatterProviderOptions
                : undefined,
        });

        const { formatted, parseOk } = parseFormatResponse(text || '');
        if (!parseOk) {
            logger.error({
                message: `[FORMATTER] No JSON array in response (${(text || '').length} chars) — applying mechanical fallback`,
                context: 'SuggestionFormatter',
                metadata: {
                    organizationId: options?.organizationId,
                    pullRequestId: options?.telemetryMetadata?.pullRequestId,
                    suggestionCount: suggestions.length,
                },
            });
            options?.onDegraded?.({
                reason: 'model response had no parseable JSON array',
            });
            return stripLabelsMechanically(suggestions);
        }

        logger.log({
            message: `[FORMATTER] Formatted ${formatted.size}/${suggestions.length} suggestions`,
            context: 'SuggestionFormatter',
        });

        return formatted;
    } catch (err) {
        logger.error({
            message: `[FORMATTER] Formatting failed (${err instanceof Error ? err.message : String(err)}) — applying mechanical fallback`,
            context: 'SuggestionFormatter',
            metadata: {
                organizationId: options?.organizationId,
                pullRequestId: options?.telemetryMetadata?.pullRequestId,
                suggestionCount: suggestions.length,
            },
        });
        options?.onDegraded?.({
            reason: `provider call failed: ${err instanceof Error ? err.message : String(err)}`,
            error: err,
        });
        return stripLabelsMechanically(suggestions);
    }
}
