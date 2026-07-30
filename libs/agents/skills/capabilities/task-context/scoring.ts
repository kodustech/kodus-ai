/**
 * task-context — scoring & usability heuristics.
 *
 * Extracted from the task-context-read monolith. Decides whether a fetched task
 * context is good enough to use (`isUsableTaskContext`), ranks candidates
 * (`scoreNormalizedContext`), and recognizes tool-error payloads
 * (`looksLikeToolErrorCandidate`) so a 404/403 response isn't mistaken for real
 * task content. Pure heuristics — no IO, no LLM.
 */
import { asRecord } from '../../runtime/value-utils';
import type { TaskContextNormalized } from '../types';
import { firstNonEmptyString } from './text-utils';

/** Weighted richness score — more complete context ranks higher. */
export function scoreNormalizedContext(value: TaskContextNormalized): number {
    let score = 0;
    if (value.id) {
        score += 1;
    }
    if (value.title) {
        score += 3;
    }
    if (value.description) {
        score += 4;
    }
    if (value.acceptanceCriteria?.length) {
        score += 2;
    }
    if (value.links?.length) {
        score += 1;
    }
    return score;
}

export function isUsableTaskContext(value: TaskContextNormalized): boolean {
    if (value.acceptanceCriteria?.length) {
        return true;
    }

    if (!value.description?.trim()) {
        return false;
    }

    if (looksLikeTaskContextFailure(value)) {
        return false;
    }

    return !looksLikeStructuredMetadata(value.description);
}

/** A description that's actually serialized ADF/card metadata, not prose. */
function looksLikeStructuredMetadata(value: string): boolean {
    const trimmed = value.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
        return false;
    }

    return (
        trimmed.includes('"inlineCard"') ||
        trimmed.includes('"blockCard"') ||
        trimmed.includes('"application"') ||
        trimmed.includes('"attrs"') ||
        trimmed.includes('"url"')
    );
}

/** Title/description that read like an error response (404/403/etc.). */
function looksLikeTaskContextFailure(value: TaskContextNormalized): boolean {
    const combined = [value.title, value.description]
        .filter((entry): entry is string => typeof entry === 'string')
        .join(' ')
        .toLowerCase();

    if (!combined) {
        return false;
    }

    const failureIndicators = [
        'failed to fetch',
        'status: 404',
        'status 404',
        'status: 403',
        'status 403',
        'status: 401',
        'status 401',
        'not found',
        'unauthorized',
        'forbidden',
        'tenant info',
    ];

    return failureIndicators.some((indicator) => combined.includes(indicator));
}

/** A raw tool-result payload that is an error envelope rather than content. */
export function looksLikeToolErrorCandidate(
    candidate: Record<string, unknown>,
): boolean {
    const statusCandidates = [
        candidate.status,
        candidate.statusCode,
        candidate.httpStatus,
    ];
    const status = statusCandidates.find(
        (value): value is number => typeof value === 'number',
    );
    const hasErrorStatus = typeof status === 'number' && status >= 400;

    const hasErrorFlag =
        candidate.error === true ||
        candidate.success === false ||
        candidate.ok === false;

    const errorValue = candidate.error;
    const errorRecord = asRecord(errorValue);
    const errorMessage =
        firstNonEmptyString([
            candidate.message,
            candidate.errorMessage,
            candidate.detail,
            typeof errorValue === 'string' ? errorValue : undefined,
            errorRecord.message,
        ]) ?? '';
    const normalizedErrorMessage = errorMessage.toLowerCase();

    const hasErrorMessage =
        normalizedErrorMessage.includes('failed to fetch') ||
        normalizedErrorMessage.includes('not found') ||
        normalizedErrorMessage.includes('unauthorized') ||
        normalizedErrorMessage.includes('forbidden') ||
        normalizedErrorMessage.includes('status: 404') ||
        normalizedErrorMessage.includes('status 404') ||
        normalizedErrorMessage.includes('status: 403') ||
        normalizedErrorMessage.includes('status 403') ||
        normalizedErrorMessage.includes('status: 401') ||
        normalizedErrorMessage.includes('status 401');

    return hasErrorFlag || hasErrorStatus || hasErrorMessage;
}
