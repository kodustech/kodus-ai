import { CommandError } from './command-errors.js';

const FIELD_TOKEN = /^[A-Za-z0-9_]+$/;

function validatePath(path: string): string[] {
    const trimmed = path.trim();
    if (!trimmed) {
        throw new CommandError('INVALID_INPUT', 'Invalid field path: empty');
    }

    const segments = trimmed.split('.');
    if (segments.some((segment) => !FIELD_TOKEN.test(segment))) {
        throw new CommandError('INVALID_INPUT', `Invalid field path: ${path}`);
    }

    return segments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map((item) => cloneValue(item)) as T;
    }

    if (isRecord(value)) {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            out[key] = cloneValue(child);
        }
        return out as T;
    }

    return value;
}

function projectAtPath(value: unknown, segments: string[]): unknown {
    if (segments.length === 0) {
        return cloneValue(value);
    }

    if (Array.isArray(value)) {
        const projectedItems = value.map((item) =>
            projectAtPath(item, segments),
        );
        if (projectedItems.some((item) => item === undefined)) {
            return undefined;
        }

        return projectedItems;
    }

    if (!isRecord(value)) {
        return undefined;
    }

    const [head, ...rest] = segments;
    if (!(head in value)) {
        return undefined;
    }

    const projectedChild = projectAtPath(value[head], rest);
    if (projectedChild === undefined) {
        return undefined;
    }

    return { [head]: projectedChild };
}

function deepMerge(target: unknown, source: unknown): unknown {
    if (source === undefined) {
        return target;
    }

    if (target === undefined) {
        return cloneValue(source);
    }

    if (Array.isArray(target) && Array.isArray(source)) {
        const max = Math.max(target.length, source.length);
        const merged: unknown[] = [];
        for (let i = 0; i < max; i += 1) {
            merged[i] = deepMerge(target[i], source[i]);
        }
        return merged;
    }

    if (isRecord(target) && isRecord(source)) {
        const merged: Record<string, unknown> = { ...target };
        for (const [key, value] of Object.entries(source)) {
            merged[key] = deepMerge(merged[key], value);
        }
        return merged;
    }

    return cloneValue(source);
}

export function applyFieldMask<T>(data: T, fields?: string[]): Partial<T> | T {
    if (!fields || fields.length === 0) {
        return data;
    }

    let merged: unknown = undefined;
    for (const path of fields) {
        const segments = validatePath(path);
        const projected = projectAtPath(data, segments);
        if (projected === undefined) {
            throw new CommandError(
                'INVALID_INPUT',
                `Unknown field path: ${path}`,
            );
        }
        merged = deepMerge(merged, projected);
    }

    return merged as Partial<T>;
}
