import {
    asRecord,
    safeJsonParse,
} from '../../../../skills/runtime/value-utils';

import { ValidationResult } from './types';

const PARSER_FALLBACK_SUMMARY =
    '❌ **Error processing validation**\n\nAn error occurred while processing the system response. Please try again.';
const PARSER_FALLBACK_MISSING_INFO =
    'Error parsing validation result. Please try again.';

export function parseBusinessRulesValidationResult(
    result: unknown,
): ValidationResult {
    const unwrapped = unwrapValidationResult(result);
    const fromObject = tryParseValidationObject(unwrapped);
    if (fromObject) {
        return fromObject;
    }

    if (typeof unwrapped === 'string') {
        const extracted = extractFieldsFromString(unwrapped);
        if (extracted.summary) {
            return {
                needsMoreInfo: extracted.needsMoreInfo ?? false,
                missingInfo: extracted.missingInfo ?? '',
                summary: extracted.summary,
            };
        }

        const normalized = unwrapped.trim();
        if (!normalized) {
            return buildParserFallbackResult();
        }

        const looksLikeLimitation = looksLikeValidationLimitation(normalized);
        if (
            looksLikeValidationSummary(normalized) ||
            looksLikeLimitation ||
            containsNaturalLanguage(normalized)
        ) {
            return {
                needsMoreInfo: looksLikeLimitation,
                missingInfo: looksLikeLimitation ? normalized : '',
                summary: normalized,
            };
        }
    }

    return buildParserFallbackResult();
}

function buildParserFallbackResult(): ValidationResult {
    return {
        needsMoreInfo: true,
        mode: 'limitation_response',
        reason: 'parser_fallback',
        confidence: 'low',
        missingInfo: PARSER_FALLBACK_MISSING_INFO,
        summary: PARSER_FALLBACK_SUMMARY,
    };
}

function unwrapValidationResult(result: unknown): unknown {
    let current: unknown = result;

    for (let index = 0; index < 4; index++) {
        if (typeof current === 'string') {
            const stripped = stripCodeFence(current);
            const parsed = parseJsonLikeString(stripped);
            if (parsed !== undefined) {
                current = parsed;
                continue;
            }
            return stripped;
        }

        const currentRecord = asRecord(current);
        if (!Object.keys(currentRecord).length) {
            return current;
        }

        const action = asRecord(currentRecord.action);
        if (typeof action.content === 'string') {
            current = action.content;
            continue;
        }
        const actionBlocksText = collectTextFromContentBlocks(action.content);
        if (typeof actionBlocksText === 'string') {
            current = actionBlocksText;
            continue;
        }

        if (typeof currentRecord.content === 'string') {
            current = currentRecord.content;
            continue;
        }
        const contentBlocksText = collectTextFromContentBlocks(
            currentRecord.content,
        );
        if (typeof contentBlocksText === 'string') {
            current = contentBlocksText;
            continue;
        }
        if (typeof currentRecord.text === 'string') {
            current = currentRecord.text;
            continue;
        }

        if (currentRecord.result !== undefined) {
            current = currentRecord.result;
            continue;
        }

        return currentRecord;
    }

    return current;
}

function tryParseValidationObject(
    result: unknown,
): ValidationResult | undefined {
    const record = asRecord(result);
    if (!Object.keys(record).length) {
        return undefined;
    }

    const hasKnownKeys =
        'needsMoreInfo' in record ||
        'summary' in record ||
        'missingInfo' in record ||
        'mode' in record ||
        'reason' in record;
    if (!hasKnownKeys) {
        return undefined;
    }

    const summary =
        typeof record.summary === 'string' && record.summary.trim().length > 0
            ? record.summary
            : 'Business rules validation completed.';

    const missingInfo =
        typeof record.missingInfo === 'string' ? record.missingInfo : '';
    const mode =
        record.mode === 'full_analysis' || record.mode === 'limitation_response'
            ? record.mode
            : record.needsMoreInfo === true
              ? 'limitation_response'
              : 'full_analysis';
    const reason =
        record.reason === 'analysis_ready' ||
        record.reason === 'task_context_missing' ||
        record.reason === 'task_context_weak' ||
        record.reason === 'pr_diff_missing' ||
        record.reason === 'analyzer_failure' ||
        record.reason === 'parser_fallback'
            ? record.reason
            : undefined;
    const taskContextStatus =
        record.taskContextStatus === 'missing' ||
        record.taskContextStatus === 'weak' ||
        record.taskContextStatus === 'usable'
            ? record.taskContextStatus
            : undefined;
    const prDiffStatus =
        record.prDiffStatus === 'missing' || record.prDiffStatus === 'usable'
            ? record.prDiffStatus
            : undefined;
    const confidence =
        record.confidence === 'low' ||
        record.confidence === 'medium' ||
        record.confidence === 'high'
            ? record.confidence
            : undefined;

    return {
        needsMoreInfo: record.needsMoreInfo === true,
        mode,
        reason,
        taskContextStatus,
        prDiffStatus,
        confidence,
        missingInfo,
        summary,
    };
}

function stripCodeFence(value: string): string {
    const trimmed = value.trim();
    const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fencedMatch || !fencedMatch[1]) {
        return trimmed;
    }
    return fencedMatch[1].trim();
}

function looksLikeValidationSummary(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return (
        normalized.includes('business rules validation') ||
        normalized.includes(
            'analysis performed by kodus ai business rules validator',
        ) ||
        /^#{1,6}\s+\S+/m.test(value) ||
        /\*\*status:\*\*/i.test(value)
    );
}

function extractFieldsFromString(text: string): Partial<ValidationResult> {
    const fields: Partial<ValidationResult> = {};

    const needsMoreInfoMatch = text.match(/"needsMoreInfo"\s*:\s*(true|false)/);
    if (needsMoreInfoMatch) {
        fields.needsMoreInfo = needsMoreInfoMatch[1] === 'true';
    }

    const missingInfoMatch = text.match(/"missingInfo"\s*:\s*"([^"]*)"/);
    if (missingInfoMatch) {
        fields.missingInfo = missingInfoMatch[1];
    }

    const summaryMatch = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (summaryMatch) {
        fields.summary = summaryMatch[1]
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"');
    }

    return fields;
}

function parseJsonLikeString(text: string): unknown | undefined {
    const direct = safeJsonParse<unknown | undefined>(text, undefined);
    if (direct !== undefined) {
        return direct;
    }

    const fencedCandidates = [
        ...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi),
    ];
    for (const match of fencedCandidates) {
        const candidate = match[1]?.trim();
        if (!candidate) {
            continue;
        }
        const parsed = safeJsonParse<unknown | undefined>(candidate, undefined);
        if (parsed !== undefined) {
            return parsed;
        }
    }

    const extractedObject = extractFirstJsonObject(text);
    if (!extractedObject) {
        return undefined;
    }
    return safeJsonParse<unknown | undefined>(extractedObject, undefined);
}

function extractFirstJsonObject(text: string): string | undefined {
    let startIndex = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }

        if (char === '{') {
            if (depth === 0) {
                startIndex = index;
            }
            depth += 1;
            continue;
        }

        if (char === '}') {
            if (depth === 0) {
                continue;
            }
            depth -= 1;
            if (depth === 0 && startIndex >= 0) {
                return text.slice(startIndex, index + 1);
            }
        }
    }

    return undefined;
}

function looksLikeValidationLimitation(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return (
        normalized.includes('need task information') ||
        normalized.includes('insufficient task context') ||
        normalized.includes('missing validation context') ||
        normalized.includes('need pull request diff') ||
        normalized.includes('mcp integration required') ||
        normalized.includes('could not start the skill') ||
        normalized.includes("couldn't start the skill")
    );
}

function containsNaturalLanguage(value: string): boolean {
    return /[a-zà-ÿ]{4,}/i.test(value);
}

function collectTextFromContentBlocks(value: unknown): string | undefined {
    if (!Array.isArray(value) || value.length === 0) {
        return undefined;
    }

    const text = value
        .map((item) => {
            if (typeof item === 'string') {
                return item;
            }

            const block = asRecord(item);
            if (typeof block.text === 'string') {
                return block.text;
            }
            if (typeof block.content === 'string') {
                return block.content;
            }
            return '';
        })
        .filter((item) => item.trim().length > 0)
        .join('\n')
        .trim();

    return text.length > 0 ? text : undefined;
}
