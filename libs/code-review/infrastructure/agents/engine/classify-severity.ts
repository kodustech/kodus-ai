/**
 * Classifies severity of code review suggestions using a fixed cheap model.
 *
 * Separated from the agent loop so that:
 * - The agent focuses on finding bugs (doesn't worry about severity)
 * - Severity is always classified using the CLIENT's criteria (v2PromptOverrides)
 * - Classification is consistent regardless of which BYOK model the client uses
 *
 * Prompt + parse live in severity-prompt.ts (shared with the severity eval).
 */
import { createLogger } from '@libs/core/log/logger';
import type { BYOKConfig } from '@libs/llm/byok-config';
import type { CodeReviewConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { resolveSecondaryPassModel } from './secondary-pass-model';
import { tracedGenerateText as generateText } from '@libs/llm/llm-call';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
} from '@libs/core/log/langfuse';
import {
    DEFAULT_SEVERITY_FLAGS,
    buildSeverityPrompt,
    parseSeverityResponse,
    type SuggestionForClassification,
} from './severity-prompt';

export { DEFAULT_SEVERITY_FLAGS, type SuggestionForClassification };

const logger = createLogger('SeverityClassifier');

// Match format-suggestion-content: BYOK models can hang under load; don't
// pin the whole review pipeline on an unbounded secondary call.
const SEVERITY_TIMEOUT_MS = 90_000;

/**
 * Classify severity for a batch of suggestions.
 *
 * Model resolution (via resolveSecondaryPassModel, same as dedup/format):
 * 1. Org BYOK main/fallback (default when configured)
 * 2. Platform gpt-5.4-mini (trial / no BYOK)
 * 3. No model available → default everything to 'medium'
 */
export async function classifySeverity(
    suggestions: SuggestionForClassification[],
    severityFlags?: CodeReviewConfig['v2PromptOverrides'],
    byokConfig?: BYOKConfig,
): Promise<Map<number, string>> {
    if (suggestions.length === 0) return new Map();

    const model = resolveSecondaryPassModel(byokConfig);

    if (!model) {
        logger.warn({
            message:
                'No model available for severity classification, defaulting to medium',
            context: 'SeverityClassifier',
        });
        return new Map(suggestions.map((_, i) => [i, 'medium']));
    }

    const flags = severityFlags?.severity?.flags || DEFAULT_SEVERITY_FLAGS;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEVERITY_TIMEOUT_MS);

    try {
        const result: any = await generateText({
            model: model as any,
            abortSignal: controller.signal,
            ...toAiSdkTelemetryArgs(
                buildLangfuseTelemetry('severity-classifier'),
            ),
            prompt: buildSeverityPrompt(suggestions, flags),
        });

        const text = result.text || '';
        const { classifications, parseOk } = parseSeverityResponse(text);
        if (!parseOk) {
            logger.warn({
                message: `[SEVERITY] No JSON in response (${text.length} chars)`,
                context: 'SeverityClassifier',
            });
            return new Map(suggestions.map((_, i) => [i, 'medium']));
        }

        // Partial responses: only overwrite indices the model returned.
        // Missing indices keep the agent-assigned severity (caller skips
        // when severityMap.get(i) is undefined).

        logger.log({
            message: `[SEVERITY] Classified ${classifications.size} suggestions: ${[...classifications.values()].join(', ')}`,
            context: 'SeverityClassifier',
        });

        return classifications;
    } catch (error) {
        logger.error({
            message: '[SEVERITY] Classification failed, defaulting to medium',
            context: 'SeverityClassifier',
            error,
        });
        return new Map(suggestions.map((_, i) => [i, 'medium']));
    } finally {
        clearTimeout(timeout);
    }
}
