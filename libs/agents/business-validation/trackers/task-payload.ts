import type { Task } from '../business-validation.types';
import { asRecord } from '../value-utils';

type JsonRecord = Record<string, unknown>;

/**
 * The fields a record keeps its own id in: `id`, `key`, `issueKey`,
 * `task_id`. Never `parentKey` or `epic_id`: those name another task.
 */
const OWN_ID_FIELD =
    /^(?:id|key|identifier|number|iid|custom_id|(?:issue|task|ticket|item|work_?item|story|card)_?(?:id|key|identifier|number))$/i;

/**
 * The record in `payload` whose own id is `id`, compared whole and ignoring
 * case. A list or a search that only mentions the task elsewhere (a link, a
 * parent) has no such record.
 */
export function recordWithId(
    payload: unknown,
    id: string,
): JsonRecord | undefined {
    const wanted = id.toUpperCase();
    return recordsIn(payload).find((record) =>
        Object.entries(record).some(
            ([field, value]) =>
                OWN_ID_FIELD.test(field) &&
                (typeof value === 'string' || typeof value === 'number') &&
                String(value).toUpperCase() === wanted,
        ),
    );
}

/** Custom fields shorter than this are labels and ids, not requirements. */
const MIN_CUSTOM_FIELD_TEXT = 20;

const DESCRIPTION_FIELDS = [
    'System.Description',
    'description',
    'markdown_description',
    'text_content',
    'notes',
    'body',
];

/**
 * Whether the record carries the task's description, even an empty one. A
 * list, or a read that picked its fields, may leave it out; then an empty
 * description says nothing about the task.
 */
export function carriesDescription(item: JsonRecord): boolean {
    const fields = { ...item, ...asRecord(item.fields) };
    return DESCRIPTION_FIELDS.some((key) => key in fields);
}

/**
 * What a task record says, in any tracker's shape: Jira `fields`, Azure
 * `System.*`, ClickUp and Asana custom fields, GitHub and GitLab issues.
 * Undefined when the record names the task but says nothing of it.
 */
export function describeTask(
    item: JsonRecord,
    payload?: unknown,
): Pick<Task, 'title' | 'description' | 'url' | 'fields'> | undefined {
    const fields = { ...item, ...asRecord(item.fields) };
    const title = textField(fields, [
        'System.Title',
        'title',
        'summary',
        'name',
    ]);
    const jira = jiraCustomFields(asRecord(item.fields), asRecord(item.names));
    const named = { ...namedCustomFields(item), ...jira.named };
    const description = joinSections([
        htmlToText(
            textField(fields, DESCRIPTION_FIELDS) ??
                (typeof payload === 'string' ? payload : undefined),
        ),
        htmlToText(
            textField(fields, [
                'Microsoft.VSTS.Common.AcceptanceCriteria',
                'acceptance_criteria',
                'acceptanceCriteria',
            ]),
        ),
        jira.text ?? customFieldsText(namedCustomFields(item)),
    ]);
    if (!title && !description) {
        return undefined;
    }
    return {
        title,
        description,
        url: textField(fields, ['html_url', 'web_url', 'app_url', 'url']),
        ...(Object.keys(named).length ? { fields: named } : {}),
    };
}

/**
 * Jira's long text custom fields (`customfield_10379`), where teams often keep
 * acceptance criteria: by id and, when the answer names them (`names`), by
 * name too, so a team can say where its criteria live. `text` keeps them all
 * for the judge.
 */
export function jiraCustomFields(
    fields: JsonRecord,
    names: JsonRecord,
): { named: Record<string, string>; text?: string } {
    const named: Record<string, string> = {};
    const texts: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
        if (!key.startsWith('customfield_')) {
            continue;
        }
        const text = toText(value);
        if (typeof text !== 'string' || text.length < MIN_CUSTOM_FIELD_TEXT) {
            continue;
        }
        texts.push(text);
        named[key] = text;
        if (typeof names[key] === 'string') {
            named[names[key] as string] = text;
        }
    }
    return {
        named,
        ...(texts.length
            ? { text: `Other fields:\n${texts.join('\n\n')}` }
            : {}),
    };
}

/**
 * Text custom fields kept as `[{ name, value }]` (ClickUp `value`, Asana
 * `text_value` / `display_value`), by name, where teams often keep criteria.
 */
function namedCustomFields(item: JsonRecord): Record<string, string> {
    const list = Array.isArray(item.custom_fields) ? item.custom_fields : [];
    const out: Record<string, string> = {};
    for (const entry of list.map(asRecord)) {
        const text = htmlToText(
            textField(entry, ['value', 'text_value', 'display_value']),
        );
        if (typeof entry.name === 'string' && text) {
            out[entry.name] = text;
        }
    }
    return out;
}

function customFieldsText(named: Record<string, string>): string | undefined {
    const long = Object.entries(named).filter(
        ([, text]) => text.length >= MIN_CUSTOM_FIELD_TEXT,
    );
    return long.length
        ? `Other fields:\n${long.map(([name, text]) => `${name}:\n${text}`).join('\n\n')}`
        : undefined;
}

function joinSections(sections: Array<string | undefined>): string | undefined {
    const present = sections.filter(Boolean);
    return present.length ? present.join('\n\n') : undefined;
}

/** Every object inside a tool payload, outermost first. */
export function recordsIn(
    payload: unknown,
    maxDepth = 6,
    maxItems = 50,
): JsonRecord[] {
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
            value.slice(0, maxItems).forEach((item) => visit(item, depth + 1));
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
        const text = record[key];
        if (typeof text === 'string' && text) {
            return text.trim();
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

/** Tags that mark a field as HTML. Once it is, every tag is removed. */
const HTML_TAG =
    /<\/?(?:div|p|br|span|b|i|u|strong|em|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|a|img|code|pre|blockquote|hr)\b[^>]*>/i;

/**
 * Plain text from the HTML some trackers store (Azure DevOps). Text without
 * HTML is returned as is. `&lt;` stays escaped, so no tag comes back.
 */
export function htmlToText(text: string | undefined): string | undefined {
    if (!text || !HTML_TAG.test(text)) {
        return text;
    }
    let plain = text
        .replace(/<li\b[^>]*>/gi, '- ')
        .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, '\n');
    // Repeated, so `<scr<script>ipt>` leaves no tag either.
    for (let previous = ''; previous !== plain;) {
        previous = plain;
        plain = plain.replace(/<[^<>]*>/g, '');
    }
    plain = plain
        .replace(/</g, '&lt;')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return plain || undefined;
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
