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
import type { NormalizedModel } from '@libs/llm/byok-config';
import type { CodeReviewConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { LLM } from '@libs/llm/llm';
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
 * Model policy lives inside the shared text executor (Porta 2): the passed
 * BYOK slot when configured, else the managed Kodus default (Fireworks
 * deepseek) — the SAME resolution every secondary pass uses. A missing/failed
 * model degrades through the catch below (→ everything 'medium').
 */
export async function classifySeverity(
    suggestions: SuggestionForClassification[],
    severityFlags?: CodeReviewConfig['v2PromptOverrides'],
    byokConfig?: NormalizedModel,
): Promise<Map<number, string>> {
    if (suggestions.length === 0) return new Map();

    const flags = severityFlags?.severity?.flags || DEFAULT_SEVERITY_FLAGS;
    const allMedium = () =>
        new Map<number, string>(suggestions.map((_, i) => [i, 'medium']));

    try {
        // Shared text executor (Porta 2): resolves the ONE secondary model (org
        // BYOK slot, else the managed default), adds the BYOK limiter and caps the
        // call at SEVERITY_TIMEOUT_MS so a stuck secondary pass can't hold the
        // pipeline. No system prompt, no span — matching the prior bare call.
        // A missing/failed model degrades through the catch below (→ all medium).
        const text = await LLM.run({
            byokConfig,
            user: buildSeverityPrompt(suggestions, flags),
            runName: 'severity-classifier',
            timeoutMs: SEVERITY_TIMEOUT_MS,
        });

        const { classifications, parseOk } = parseSeverityResponse(text || '');
        if (!parseOk) {
            logger.warn({
                message: `[SEVERITY] No JSON in response (${(text || '').length} chars)`,
                context: 'SeverityClassifier',
            });
            return allMedium();
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
        return allMedium();
    }
}
