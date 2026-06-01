import type { OutputFormat } from '../types/cli.js';
import { CommandError } from './command-errors.js';

export function parseOptionalNumber(
    raw: string | undefined,
    flag: string,
): number | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const value = Number(raw);
    if (
        !Number.isFinite(value) ||
        Number.isNaN(value) ||
        !Number.isInteger(value) ||
        value <= 0
    ) {
        throw new CommandError('INVALID_INPUT', `Invalid ${flag} value`, 1, {
            flag,
            raw,
        });
    }

    return value;
}

export function parseCsvEnumList(
    raw: string | undefined,
    flag: string,
    allowed: readonly string[],
): string[] | undefined {
    if (!raw) {
        return undefined;
    }

    const items = raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

    if (items.length === 0) {
        return undefined;
    }

    const normalizedAllowed = new Set(
        allowed.map((item) => item.toLowerCase()),
    );
    const invalid = items.filter(
        (item) => !normalizedAllowed.has(item.toLowerCase()),
    );

    if (invalid.length > 0) {
        throw new CommandError(
            'INVALID_INPUT',
            `Invalid value for ${flag}: ${invalid.join(', ')}`,
            1,
            { flag, invalid, allowed: [...allowed] },
        );
    }

    return items;
}

export function validateHttpUrl(raw: string, flag: string): string {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('invalid protocol');
        }
        return raw;
    } catch {
        throw new CommandError('INVALID_INPUT', `Invalid ${flag} value`, 1, {
            flag,
            raw,
        });
    }
}

export function parseFieldList(raw: string | undefined): string[] | undefined {
    if (!raw) {
        return undefined;
    }

    const fields = raw
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean);

    if (fields.length === 0) {
        return undefined;
    }

    return [...new Set(fields)];
}

export function assertStructuredOutputForFields(input: {
    fields?: string;
    format: OutputFormat;
    isAgent: boolean;
}): void {
    if (!input.fields) {
        return;
    }

    if (input.isAgent || input.format === 'json') {
        return;
    }

    throw new CommandError(
        'INVALID_INPUT',
        '--fields requires --format json or --agent',
    );
}
