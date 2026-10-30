import {
    CODE_REVIEW_CONTEXT_PATTERNS,
    stripMarkersFromText,
} from '@libs/ai-engine/infrastructure/adapters/services/context/code-review-context.utils';

import { convertTiptapJSONToMarkdown } from '../tiptap-json';

/**
 * Limits text length to a maximum number of characters.
 * @param text - The text to limit
 * @param max - Maximum character length (default: 2000)
 * @returns Truncated text if it exceeds max length, otherwise the original text
 */
export function limitText(text: string, max = 5000): string {
    return text.length > max ? text.slice(0, max) : text;
}

/**
 * Extracts the raw value from a potentially nested structure.
 * Handles string values, objects with a 'value' property, or plain objects.
 * @param value - The value to extract (can be string, object, or undefined)
 * @returns Extracted string or object, or undefined if value is null/undefined
 */
export function extractRawValue(
    value: unknown,
): string | Record<string, unknown> | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value === 'string') {
        return value;
    }
    if (
        typeof value === 'object' &&
        typeof (value as Record<string, unknown>).value !== 'undefined'
    ) {
        return (value as Record<string, unknown>).value as
            | string
            | Record<string, unknown>;
    }
    return value as Record<string, unknown>;
}

/**
 * Sanitizes prompt text by removing MCP markers and trimming whitespace.
 * @param raw - The raw text to sanitize
 * @returns Sanitized text, or empty string if input is falsy
 */
export function sanitizePromptText(raw?: string): string {
    if (!raw) {
        return '';
    }
    return stripMarkersFromText(raw, CODE_REVIEW_CONTEXT_PATTERNS).trim();
}

/**
 * Gets text from primary source or falls back to default text.
 * Converts TipTap JSON to markdown, sanitizes, and limits length.
 * @param text - Primary text source (can be TipTap JSON or string)
 * @param fallbackText - Fallback text if primary is empty
 * @returns Processed text string, or empty string if both sources are empty
 */
export function getTextOrDefault(
    text: unknown,
    fallbackText?: unknown,
    options?: { keepMcpMentions?: boolean },
): string {
    const primaryRaw = convertTiptapJSONToMarkdown(
        extractRawValue(text),
        options,
    ).trim();
    const primary = options?.keepMcpMentions
        ? primaryRaw
        : sanitizePromptText(primaryRaw);
    if (primary.length) {
        return limitText(primary);
    }

    const fallbackRaw = convertTiptapJSONToMarkdown(
        extractRawValue(fallbackText),
        options,
    ).trim();
    const fallback = options?.keepMcpMentions
        ? fallbackRaw
        : sanitizePromptText(fallbackRaw);

    return fallback.length ? limitText(fallback) : '';
}
