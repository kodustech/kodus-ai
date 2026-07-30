/**
 * task-context — tool-result normalization.
 *
 * Extracted from the task-context-read monolith. Turns a raw (and wildly
 * provider-shaped) MCP tool result into a single best `TaskContextNormalized`:
 * walks the payload for candidate objects, normalizes each (id/title/
 * description/acceptanceCriteria/links, incl. Atlassian ADF + Notion rich-text),
 * drops error envelopes, and keeps the richest one by score. Pure — no IO/LLM.
 *
 * Public entry point: `extractTaskContextFromToolResult`. Everything else is an
 * internal helper of that walk.
 */
import { asRecord, safeStringify } from '../../runtime/value-utils';
import type { TaskContextNormalized } from '../types';
import { extractLinks } from './task-references';
import {
    looksLikeToolErrorCandidate,
    scoreNormalizedContext,
} from './scoring';
import {
    firstNonEmptyString,
    firstNonEmptyValue,
    tryParseJsonString,
    uniqueNonEmpty,
} from './text-utils';

export function extractTaskContextFromToolResult(
    payload: unknown,
): TaskContextNormalized | undefined {
    const candidates = extractContextCandidates(payload);
    let best: TaskContextNormalized | undefined;
    let bestScore = -1;

    for (const candidate of candidates) {
        const normalized = normalizeContextCandidate(candidate);
        if (!normalized) {
            continue;
        }

        const score = scoreNormalizedContext(normalized);
        if (score > bestScore) {
            best = normalized;
            bestScore = score;
        }
    }

    return best;
}

function extractContextCandidates(payload: unknown): Record<string, unknown>[] {
    const candidates: Record<string, unknown>[] = [];
    const seen = new Set<string>();

    const addCandidate = (value: unknown): void => {
        const record = asRecord(value);
        if (!Object.keys(record).length) {
            return;
        }

        const fingerprint = safeStringify(record);
        if (seen.has(fingerprint)) {
            return;
        }
        seen.add(fingerprint);
        candidates.push(record);
    };

    const visit = (value: unknown, depth: number): void => {
        if (depth > 8 || value === null || value === undefined) {
            return;
        }

        if (typeof value === 'string') {
            const parsed = tryParseJsonString(value);
            if (parsed !== undefined) {
                visit(parsed, depth + 1);
            }
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value.slice(0, 25)) {
                visit(item, depth + 1);
            }
            return;
        }

        const record = asRecord(value);
        if (!Object.keys(record).length) {
            return;
        }
        addCandidate(record);

        const singletonKeys = [
            'result',
            'data',
            'payload',
            'item',
            'issue',
            'task',
            'ticket',
            'page',
            'record',
            'object',
            'fields',
            'properties',
            'attributes',
        ];
        const collectionKeys = [
            'items',
            'results',
            'records',
            'nodes',
            'content',
        ];

        for (const key of singletonKeys) {
            visit(record[key], depth + 1);
        }
        for (const key of collectionKeys) {
            visit(record[key], depth + 1);
        }
        if (typeof record.text === 'string') {
            visit(record.text, depth + 1);
        }
    };

    visit(payload, 0);
    return candidates;
}

function normalizeContextCandidate(
    candidate: Record<string, unknown>,
): TaskContextNormalized | undefined {
    if (looksLikeToolErrorCandidate(candidate)) {
        return undefined;
    }

    const fields = asRecord(candidate.fields);
    const properties = asRecord(candidate.properties);
    const attributes = asRecord(candidate.attributes);
    const data = asRecord(candidate.data);
    const spaces = [candidate, fields, properties, attributes, data];

    const id = firstNonEmptyString([
        ...pluckValues(spaces, [
            'key',
            'identifier',
            'code',
            'issueKey',
            'ticketKey',
            'taskKey',
            'id',
            'number',
            'issueId',
            'taskId',
            'ticketId',
            'pageId',
            'recordId',
        ]),
    ]);

    const title =
        firstNonEmptyString([
            ...pluckValues(spaces, ['summary', 'title', 'name', 'subject']),
        ]) ??
        extractPropertyText(properties, [
            'Name',
            'Title',
            'Summary',
            'Task',
            'Issue',
        ]);

    const descriptionRaw = firstNonEmptyValue([
        ...pluckValues(spaces, [
            'description',
            'body',
            'content',
            'text',
            'details',
            'overview',
            'context',
        ]),
    ]);

    const description = normalizeTextValue(descriptionRaw);

    const acceptanceCriteria = uniqueNonEmpty([
        ...(extractStringArray(
            firstNonEmptyValue([
                ...pluckValues(spaces, [
                    'acceptanceCriteria',
                    'acceptance_criteria',
                    'criteria',
                    'requirements',
                    'acceptance',
                ]),
            ]),
        ) ?? []),
        ...(extractStringArray(
            extractPropertyValue(properties, [
                'Acceptance Criteria',
                'Acceptance',
                'Criteria',
                'Requirements',
            ]),
        ) ?? []),
    ]);

    const links = uniqueNonEmpty([
        ...(extractStringArray(
            firstNonEmptyValue([
                ...pluckValues(spaces, ['links', 'references', 'urls']),
            ]),
        ) ?? []),
        ...[
            firstNonEmptyString([
                ...pluckValues(spaces, [
                    'url',
                    'webUrl',
                    'htmlUrl',
                    'permalink',
                    'href',
                    'uri',
                    'link',
                ]),
            ]),
        ].filter((value): value is string => typeof value === 'string'),
        ...(description ? extractLinks(description) : []),
    ]);

    const normalized: TaskContextNormalized = {
        id,
        title,
        description,
        acceptanceCriteria: acceptanceCriteria.length
            ? acceptanceCriteria
            : undefined,
        links: links.length ? links : undefined,
    };

    const hasCoreContent =
        Boolean(normalized.title?.trim()) ||
        Boolean(normalized.description?.trim());
    return hasCoreContent ? normalized : undefined;
}

function pluckValues(
    spaces: Record<string, unknown>[],
    keys: string[],
): unknown[] {
    const values: unknown[] = [];
    for (const space of spaces) {
        for (const key of keys) {
            values.push(space[key]);
        }
    }
    return values;
}

function extractPropertyValue(
    properties: Record<string, unknown>,
    names: string[],
): unknown {
    for (const name of names) {
        if (properties[name] !== undefined) {
            return properties[name];
        }
    }
    return undefined;
}

function extractPropertyText(
    properties: Record<string, unknown>,
    names: string[],
): string | undefined {
    return normalizeTextValue(extractPropertyValue(properties, names));
}

function normalizeTextValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value.trim().length > 0 ? value : undefined;
    }

    // Handle Atlassian Document Format (ADF) — Jira returns description as
    // {type: "doc", content: [{type: "paragraph", content: [{type: "text", text: "..."}]}]}
    const adf = extractAdfText(value);
    if (adf) {
        return adf;
    }

    const rich = extractRichText(value);
    if (rich) {
        return rich;
    }

    if (value !== undefined && value !== null) {
        const serialized = safeStringify(value);
        return serialized && serialized.trim().length > 0
            ? serialized
            : undefined;
    }

    return undefined;
}

/**
 * Extract plain text from Atlassian Document Format (ADF).
 * ADF structure: {type: "doc", content: [{type: "paragraph"|"heading"|..., content: [{type: "text", text: "..."}]}]}
 */
function extractAdfText(value: unknown): string | undefined {
    const record = asRecord(value);
    if (
        record.type !== 'doc' ||
        !Array.isArray(record.content)
    ) {
        return undefined;
    }

    const lines: string[] = [];
    const visitAdfNode = (node: unknown): void => {
        const n = asRecord(node);
        if (!n.type) return;

        if (n.type === 'text' && typeof n.text === 'string') {
            lines.push(n.text);
            return;
        }

        if (Array.isArray(n.content)) {
            for (const child of n.content) {
                visitAdfNode(child);
            }
        }
    };

    for (const block of record.content as unknown[]) {
        visitAdfNode(block);
        lines.push('\n');
    }

    const result = lines.join('').replace(/\n{3,}/g, '\n\n').trim();
    return result.length > 0 ? result : undefined;
}

function extractRichText(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value.trim().length > 0 ? value : undefined;
    }

    if (Array.isArray(value)) {
        const combined = value
            .map((item) => extractRichText(item))
            .filter((item): item is string => typeof item === 'string')
            .join(' ')
            .trim();
        return combined.length > 0 ? combined : undefined;
    }

    const record = asRecord(value);
    if (!Object.keys(record).length) {
        return undefined;
    }

    const direct = firstNonEmptyString([
        record.plain_text,
        record.text,
        record.content,
        record.value,
        record.name,
        record.title,
    ]);
    if (direct) {
        return direct;
    }

    const nested = firstNonEmptyString([
        extractRichText(record.rich_text),
        extractRichText(record.title),
        extractRichText(record.description),
        extractRichText(record.content),
        extractRichText(record.text),
    ]);

    return nested;
}

function extractStringArray(value: unknown): string[] | undefined {
    if (typeof value === 'string' && value.trim().length > 0) {
        return [value];
    }

    if (!Array.isArray(value)) {
        const nestedValue = extractRichText(value);
        return nestedValue ? [nestedValue] : undefined;
    }

    const values = value
        .map((item) => extractRichText(item))
        .filter((item): item is string => typeof item === 'string');

    return values.length ? values : undefined;
}
