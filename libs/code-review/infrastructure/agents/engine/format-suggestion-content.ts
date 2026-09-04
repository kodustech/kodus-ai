import { createLogger } from '@libs/core/log/logger';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { LLM } from '@libs/llm/llm';
import {
    buildFormatPrompt,
    parseFormatResponse,
    type FormattedSuggestion,
    type SuggestionToFormat,
} from './format-prompt';
import {
    looksLikeReviewScaffolding,
    stripReviewScaffolding,
} from './strip-review-scaffolding';

export type { FormattedSuggestion, SuggestionToFormat };

const logger = createLogger('SuggestionFormatter');

const FORMAT_TIMEOUT_MS = 90_000; // 90s — the secondary model can take >30s under load

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

/**
 * What ships when the model pass gives us nothing for a suggestion.
 *
 * Every failure path below used to `return new Map()`, and the caller's loop
 * over an empty map left `suggestionContent` as the finder wrote it -- the
 * WHAT/WHY/HOW scaffolding the review prompt asks for. Production, twelve
 * hours: 86 of 732 runs (11.7%) ended that way, and every suggestion in those
 * batches reached a customer's pull request with the labels intact.
 *
 * The five causes were unrelated -- a suspended account (55), the 90s ceiling
 * (25), a parse failure, a model id that does not exist, a rate limit -- so no
 * fix aimed at one of them removes the symptom. Stripping the labels locally
 * removes it for all five: it cannot time out, cannot be rate limited, and does
 * not care whether the account has credit.
 *
 * The model pass is still the polish and still preferred; this is the floor.
 * Suggestions that are already prose are returned untouched.
 */
function scaffoldingFallback(
    suggestions: SuggestionToFormat[],
    reason: string,
): Map<number, FormattedSuggestion> {
    const out = new Map<number, FormattedSuggestion>();

    suggestions.forEach((s, i) => {
        const content = s.suggestionContent || '';
        if (!looksLikeReviewScaffolding(content)) {
            return;
        }
        out.set(i, {
            suggestionContent: stripReviewScaffolding(content),
            improvedCode: s.improvedCode || '',
        });
    });

    if (out.size > 0) {
        logger.warn({
            message: `[FORMATTER] ${reason} — stripped WHAT/WHY/HOW locally for ${out.size}/${suggestions.length} suggestion(s) so the scaffolding does not ship`,
            context: 'SuggestionFormatter',
        });
    }

    return out;
}

/**
 * Reformat suggestion content from WHAT/WHY/HOW to natural prose,
 * and ensure improvedCode is populated.
 *
 * Plain BYOK text call through the ONE primitive (LLM.run): the passed slot
 * when configured, else the managed default — same model resolution, limiter,
 * reasoning and timeout as every other call. Respects custom writing guidelines
 * if provided. A missing/failed model degrades through the catch (→ empty map:
 * comments still ship, minus the prose polish).
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

    try {
        const text = await LLM.run({
            byokConfig: options?.byokConfig,
            user: buildFormatPrompt(suggestions, {
                customWritingGuidelines: options?.customWritingGuidelines,
                languageLabel: langLabel,
            }),
            runName: 'suggestion-formatter',
            timeoutMs: FORMAT_TIMEOUT_MS,
            // Stamp the org so this pass's usage/cost lands in the org's
            // token-usage view instead of being recorded org-less (dropped).
            organizationId: options?.organizationId,
        });

        const { formatted, parseOk } = parseFormatResponse(text || '');
        if (!parseOk) {
            logger.warn({
                message: `[FORMATTER] No JSON array in response (${(text || '').length} chars)`,
                context: 'SuggestionFormatter',
            });
            return scaffoldingFallback(suggestions, 'no JSON array in response');
        }

        logger.log({
            message: `[FORMATTER] Formatted ${formatted.size}/${suggestions.length} suggestions`,
            context: 'SuggestionFormatter',
        });

        // A partial answer leaves the rest raw, which is the same leak in
        // miniature. Fill only the gaps -- what the model returned wins.
        if (formatted.size < suggestions.length) {
            for (const [i, fallback] of scaffoldingFallback(
                suggestions,
                'model returned a partial batch',
            )) {
                if (!formatted.has(i)) {
                    formatted.set(i, fallback);
                }
            }
        }

        return formatted;
    } catch (err) {
        logger.warn({
            message: `[FORMATTER] Formatting failed: ${err instanceof Error ? err.message : String(err)}`,
            context: 'SuggestionFormatter',
        });
        return scaffoldingFallback(
            suggestions,
            err instanceof Error ? err.message : String(err),
        );
    }
}
