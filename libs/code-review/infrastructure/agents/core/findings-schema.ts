/**
 * code-review (domain) — the findings output schema + sanitizer.
 *
 * Relocated from the legacy llm/agent-loop.ts so the decomposed agent path
 * (finder.agent) doesn't reach into the 4.5k-line legacy file for it.
 */
import { z } from 'zod';
import { createLogger } from '@libs/core/log/logger';
import { normalizeEnvelope } from '@libs/llm/structured-output-repair';
import { LLM_ENVELOPE_TAG } from '@libs/llm/log-tags';

const logger = createLogger('FindingsSchema');

/** Schema for structured output */
const suggestionSchema = z.object({
    relevantFile: z.string(),
    language: z.string().optional(),
    label: z.enum(['bug', 'security', 'performance']).optional(),
    suggestionContent: z.string(),
    existingCode: z.string(),
    improvedCode: z.string(),
    oneSentenceSummary: z.string().optional(),
    relevantLinesStart: z.number().optional(),
    relevantLinesEnd: z.number().optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(), // V2 compat
    confidence: z.number().min(1).max(10).optional(), // 1-10: how confident the agent is in this finding
    ruleUuid: z.string().optional(), // Kody Rules: UUID of the violated rule
});

const _findingsSchema = z.object({
    reasoning: z.string(),
    suggestions: z.array(suggestionSchema),
});

export type FindingsOutput = z.infer<typeof _findingsSchema>;

/**
 * Validate and sanitize a done-tool result against the FindingsOutput schema.
 * Returns null if the result is null or fails validation, ensuring downstream
 * code never receives a FindingsOutput with missing `suggestions`.
 */
export function sanitizeFindingsResult(
    raw: FindingsOutput | null,
): FindingsOutput | null {
    if (!raw) return null;
    // SHAPE layer (#1786): coerce the container a non-strict model wrapped /
    // renamed / bare-arrayed / stringified BEFORE validation, so a real finding
    // set under `{result:…}`, `{findings:…}`, a bare array, or a JSON string is
    // recovered instead of read as `undefined` and silently dropped. Pure and
    // conservative — a canonical `{reasoning,suggestions}` is returned untouched.
    const normalized = normalizeEnvelope(raw, 'suggestions', [
        'findings',
        'codeSuggestions',
    ]) as FindingsOutput;
    const parsed = _findingsSchema.safeParse(normalized);
    if (parsed.success) return parsed.data;
    logger.warn({
        message:
            `${LLM_ENVELOPE_TAG} [DONE-TOOL] FindingsOutput failed Zod validation, falling back to text parsing`,
        context: 'FindingsSchema',
        metadata: {
            zodErrors: parsed.error.issues.map(
                (i) => `${i.path.join('.')}: ${i.message}`,
            ),
            rawKeys: Object.keys(normalized ?? {}),
            hasSuggestions: Array.isArray((normalized as any)?.suggestions),
        },
    });
    // Attempt partial recovery: keep only the suggestions that
    // individually satisfy the item schema. The old recovery kept the
    // raw array UNVALIDATED, which is how a suggestion without
    // `relevantFile` (kimi-k2.7, observed on a customer instance)
    // reached the finder and crashed the evidence-coverage filter.
    if (Array.isArray((normalized as any)?.suggestions)) {
        const kept: FindingsOutput['suggestions'] = [];
        let dropped = 0;
        for (const item of (normalized as any).suggestions) {
            const s = suggestionSchema.safeParse(item);
            if (s.success) kept.push(s.data);
            else dropped++;
        }
        if (dropped > 0) {
            logger.warn({
                message: `${LLM_ENVELOPE_TAG} [DONE-TOOL] dropped ${dropped} suggestion(s) that failed item validation during partial recovery`,
                context: 'FindingsSchema',
                metadata: { kept: kept.length, dropped },
            });
        }
        return {
            reasoning: (normalized as any).reasoning ?? '',
            suggestions: kept,
        };
    }
    return null;
}
