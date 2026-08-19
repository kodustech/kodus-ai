import { createLogger } from '@libs/core/log/logger';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { LLM } from '@libs/llm/llm';
import {
    buildFormatPrompt,
    parseFormatResponse,
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
        });

        const { formatted, parseOk } = parseFormatResponse(text || '');
        if (!parseOk) {
            logger.warn({
                message: `[FORMATTER] No JSON array in response (${(text || '').length} chars)`,
                context: 'SuggestionFormatter',
            });
            return new Map();
        }

        logger.log({
            message: `[FORMATTER] Formatted ${formatted.size}/${suggestions.length} suggestions`,
            context: 'SuggestionFormatter',
        });

        return formatted;
    } catch (err) {
        logger.warn({
            message: `[FORMATTER] Formatting failed: ${err instanceof Error ? err.message : String(err)}`,
            context: 'SuggestionFormatter',
        });
        return new Map();
    }
}
