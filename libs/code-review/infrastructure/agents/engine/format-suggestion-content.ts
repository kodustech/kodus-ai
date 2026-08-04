import { createLogger } from '@libs/core/log/logger';
import type { NormalizedByokConfig } from '@libs/llm/byok-config';
import { tracedGenerateText as generateText } from '@libs/llm/llm-call';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
} from '@libs/core/log/langfuse';
import { resolveSecondaryPassModel } from './secondary-pass-model';
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
 * Runs on the shared secondary-pass model — see resolveSecondaryPassModel
 * (BYOK default when configured; platform gpt-5.4-mini for trial / no BYOK).
 * Respects custom writing guidelines if provided.
 *
 * Prompt + parse live in format-prompt.ts (shared with the format eval).
 */
export async function formatSuggestionContent(
    suggestions: SuggestionToFormat[],
    options?: {
        customWritingGuidelines?: string;
        byokConfig?: NormalizedByokConfig;
        languageResultPrompt?: string;
    },
): Promise<Map<number, FormattedSuggestion>> {
    if (suggestions.length === 0) {
        return new Map();
    }

    // Secondary pass: BYOK when configured, else platform — see
    // resolveSecondaryPassModel. Null when nothing is configured → skip
    // formatting (comments still ship, minus the prose polish).
    const model = resolveSecondaryPassModel(options?.byokConfig);

    if (!model) {
        logger.warn({
            message: 'No model available for suggestion formatting, skipping',
            context: 'SuggestionFormatter',
        });
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FORMAT_TIMEOUT_MS);

    try {
        const result: any = await generateText({
            model: model as any,
            abortSignal: controller.signal,
            ...toAiSdkTelemetryArgs(
                buildLangfuseTelemetry('suggestion-formatter'),
            ),
            prompt: buildFormatPrompt(suggestions, {
                customWritingGuidelines: options?.customWritingGuidelines,
                languageLabel: langLabel,
            }),
        });

        const text = result.text || '';
        const { formatted, parseOk } = parseFormatResponse(text);
        if (!parseOk) {
            logger.warn({
                message: `[FORMATTER] No JSON array in response (${text.length} chars)`,
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
    } finally {
        clearTimeout(timeout);
    }
}
