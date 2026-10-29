/**
 * What a finder pass returns, defined once (#1821). The lean item is the
 * generalist finder's five fields; the full item is a custom agent's finding,
 * as main had it. The submitResult tool schemas, the prose-recovery schemas
 * and the parse schema's field list are all derived from these two.
 */
import { z } from 'zod';

import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import { FINDER_LABELS } from '@libs/code-review/infrastructure/agents/engine/finding-labels';
import { TITLE_PROMPT_SPEC } from '@libs/common/utils/codeManagement/suggestion-title';

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

/** The generalist finder's finding: exactly the fields the prompt asks for,
 *  all required. Snippet, fix, severity and confidence come at enrichment. */
export const LEAN_FINDING = z.object({
    label: z.enum(FINDER_LABELS),
    relevantFile: z.string(),
    relevantLinesStart: z.number(),
    relevantLinesEnd: z.number(),
    suggestionContent: z.string(),
});

/** A custom agent's finding: it skips the enrichment and the severity
 *  classifier, so it writes the snippet, the fix, the title and the severity
 *  itself. */
export const FULL_FINDING = z.object({
    relevantFile: z.string(),
    language: z.string().optional(),
    label: z.enum(FINDER_LABELS).optional(),
    suggestionContent: z.string(),
    existingCode: z.string(),
    improvedCode: z.string(),
    oneSentenceSummary: z.string().describe(TITLE_PROMPT_SPEC),
    relevantLinesStart: z.number().optional(),
    relevantLinesEnd: z.number().optional(),
    severity: z.enum(SEVERITIES).optional(),
    confidence: z.number().optional(),
    ruleUuid: z.string().optional(),
});

export const LEAN_FINDER_FIELDS = Object.keys(LEAN_FINDING.shape) as Array<
    keyof typeof LEAN_FINDING.shape
>;

/** An object schema as provider strict tool use needs it:
 *  additionalProperties false, every key in a fixed order. */
function strictObject(item: z.ZodObject): JSONSchema {
    const { properties, required } = z.toJSONSchema(item) as {
        properties: Record<string, JSONSchema>;
        required?: string[];
    };
    return {
        type: 'object',
        additionalProperties: false,
        properties,
        required: required ?? [],
    };
}

/** The submitResult tool's input: the reasoning and the findings. */
export function submitResultSchema(item: z.ZodObject): JSONSchema {
    return {
        type: 'object',
        // additionalProperties:false on every object is required by provider
        // strict tool use / structured output modes.
        additionalProperties: false,
        properties: {
            reasoning: { type: 'string' },
            suggestions: { type: 'array', items: strictObject(item) },
        },
        required: ['reasoning', 'suggestions'],
    };
}

/** Prose recovery: the same item, its optional fields nullable. Prose that
 *  describes a defect may not name its label or lines, and requiring them made
 *  the WHOLE recovery fail ("response did not match schema", GPT-6.1, 30/09);
 *  OpenAI strict mode needs every field declared, so nullable, not optional.
 *  The label is any string: normalizeFinderLabels maps it after anchoring. */
export const LEAN_RECOVERY = z.object({
    suggestions: z.array(
        LEAN_FINDING.pick({ relevantFile: true, suggestionContent: true }).extend({
            label: z.string().nullable(),
            relevantLinesStart: z.number().nullable(),
            relevantLinesEnd: z.number().nullable(),
        }),
    ),
});

const FULL_RECOVERY_ITEM = FULL_FINDING.extend({
    language: z.string().nullable(),
    label: z.string().nullable(),
    oneSentenceSummary: z.string().nullable().describe(TITLE_PROMPT_SPEC),
    relevantLinesStart: z.number().nullable(),
    relevantLinesEnd: z.number().nullable(),
    severity: z.string().nullable(),
    confidence: z.number().nullable(),
}).shape;

export const FULL_RECOVERY = z.object({
    suggestions: z.array(
        // The order the recovery prompt has always sent.
        z.object({
            relevantFile: FULL_RECOVERY_ITEM.relevantFile,
            suggestionContent: FULL_RECOVERY_ITEM.suggestionContent,
            existingCode: FULL_RECOVERY_ITEM.existingCode,
            improvedCode: FULL_RECOVERY_ITEM.improvedCode,
            language: FULL_RECOVERY_ITEM.language,
            label: FULL_RECOVERY_ITEM.label,
            oneSentenceSummary: FULL_RECOVERY_ITEM.oneSentenceSummary,
            relevantLinesStart: FULL_RECOVERY_ITEM.relevantLinesStart,
            relevantLinesEnd: FULL_RECOVERY_ITEM.relevantLinesEnd,
            severity: FULL_RECOVERY_ITEM.severity,
            confidence: FULL_RECOVERY_ITEM.confidence,
        }),
    ),
});
