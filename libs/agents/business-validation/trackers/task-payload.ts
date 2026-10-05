import { asRecord } from '../value-utils';

type JsonRecord = Record<string, unknown>;

/** Every object inside a tool payload, outermost first. */
export function recordsIn(payload: unknown, maxDepth = 6): JsonRecord[] {
    const records: JsonRecord[] = [];
    const visit = (value: unknown, depth: number) => {
        if (depth > maxDepth || value === null || value === undefined) {
            return;
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                try {
                    visit(JSON.parse(trimmed), depth + 1);
                } catch {
                    /* plain text */
                }
            }
            return;
        }
        if (Array.isArray(value)) {
            value.slice(0, 50).forEach((item) => visit(item, depth + 1));
            return;
        }
        if (typeof value === 'object') {
            records.push(value as JsonRecord);
            Object.values(value as JsonRecord).forEach((child) =>
                visit(child, depth + 1),
            );
        }
    };
    visit(payload, 0);
    return records;
}

/** The first non-empty text among `keys` of `record`, flattening rich text and ADF. */
export function textField(
    record: JsonRecord,
    keys: string[],
): string | undefined {
    for (const key of keys) {
        const text = toText(record[key]);
        if (text) {
            return text;
        }
    }
    return undefined;
}

/** Plain text from a string, Atlassian Document Format, or Notion-style rich text. */
export function toText(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value.trim() ? value.trim() : undefined;
    }
    if (typeof value === 'number') {
        return String(value);
    }
    const record = asRecord(value);
    if (record.type === 'doc' && Array.isArray(record.content)) {
        return adfToText(record);
    }
    if (Array.isArray(value)) {
        const joined = value
            .map((item) => toText(item))
            .filter(Boolean)
            .join(' ')
            .trim();
        return joined || undefined;
    }
    for (const key of ['plain_text', 'text', 'content', 'value', 'name']) {
        if (typeof record[key] === 'string' && record[key]) {
            return (record[key] as string).trim();
        }
    }
    if (record.rich_text) {
        return toText(record.rich_text);
    }
    return undefined;
}

function adfToText(doc: JsonRecord): string | undefined {
    const parts: string[] = [];
    const visit = (node: unknown) => {
        const n = asRecord(node);
        if (n.type === 'text' && typeof n.text === 'string') {
            parts.push(n.text);
            return;
        }
        if (n.type === 'listItem') {
            parts.push('- ');
        }
        if (Array.isArray(n.content)) {
            n.content.forEach(visit);
        }
        if (
            n.type === 'paragraph' ||
            n.type === 'heading' ||
            n.type === 'listItem'
        ) {
            parts.push('\n');
        }
    };
    (doc.content as unknown[]).forEach(visit);
    const text = parts
        .join('')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return text || undefined;
}

/** True when `payload` mentions `id` as a whole token anywhere. */
export function mentions(payload: unknown, id: string): boolean {
    const text =
        typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_])`, 'i').test(
        text,
    );
}
