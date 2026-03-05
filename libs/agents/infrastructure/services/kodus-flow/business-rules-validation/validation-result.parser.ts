import {
    asRecord,
    safeJsonParse,
} from '../../../../skills/runtime/value-utils';

import { ValidationResult } from './types';

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

        if (looksLikeValidationSummary(unwrapped)) {
            return {
                needsMoreInfo: false,
                missingInfo: '',
                summary: unwrapped.trim(),
            };
        }
    }

    return {
        needsMoreInfo: true,
        mode: 'limitation_response',
        reason: 'parser_fallback',
        confidence: 'low',
        missingInfo: 'Error parsing validation result. Please try again.',
        summary:
            '❌ **Error processing validation**\n\nAn error occurred while processing the system response. Please try again.',
    };
}

function unwrapValidationResult(result: unknown): unknown {
    let current: unknown = result;

    for (let index = 0; index < 4; index++) {
        if (typeof current === 'string') {
            const stripped = stripCodeFence(current);
            const parsed = safeJsonParse<unknown | undefined>(
                stripped,
                undefined,
            );
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

        if (typeof currentRecord.content === 'string') {
            current = currentRecord.content;
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
        )
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
