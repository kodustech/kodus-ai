import type {
    RelatedTask,
    Task,
    TaskLinks,
} from '../business-validation.types';
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
):
    | Pick<Task, 'title' | 'description' | 'url' | 'fields' | 'links'>
    | undefined {
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
        checklistsText(item.checklists),
    ]);
    if (!title && !description) {
        return undefined;
    }
    const links = linksIn(item);
    return {
        title,
        description,
        // Azure answers with an API `url` and the page under `_links.html`
        // (the REST API) or `links.links.html` (its MCP server).
        url:
            textField(fields, ['html_url', 'web_url', 'app_url']) ??
            toText(asRecord(asRecord(item._links).html).href) ??
            toText(asRecord(asRecord(asRecord(item.links).links).html).href) ??
            textField(fields, ['url']),
        ...(Object.keys(named).length ? { fields: named } : {}),
        ...(links ? { links } : {}),
    };
}

/** ClickUp-style checklists, where teams often keep acceptance criteria. */
function checklistsText(checklists: unknown): string | undefined {
    if (!Array.isArray(checklists)) {
        return undefined;
    }
    const sections = checklists
        .map((entry) => asRecord(entry))
        .map((list) => {
            const items = (Array.isArray(list.items) ? list.items : [])
                .map((item) => textField(asRecord(item), ['name', 'title']))
                .filter((name): name is string => !!name);
            return items.length
                ? `## ${textField(list, ['name']) ?? 'Checklist'}\n${items.map((name) => `- ${name}`).join('\n')}`
                : undefined;
        })
        .filter(Boolean);
    return sections.length ? sections.join('\n\n') : undefined;
}

/** The most sub-tasks a judge is shown: a title each, enough to see the split. */
export const MAX_SUBTASKS = 25;

/**
 * The parent, sub-tasks and documents a task record names, in any tracker's
 * shape: Linear `parentId` and `documents`, Jira `fields.parent` and
 * `fields.subtasks`, ClickUp `parent` and `subtasks`, GitHub `sub_issues`,
 * Azure Boards `fields['System.Parent']`.
 */
export function linksIn(item: JsonRecord): TaskLinks | undefined {
    const fields = { ...item, ...asRecord(item.fields) };
    const parent = fields.parent;
    const parentRecord = asRecord(parent);
    const parentId =
        idOf(parentRecord) ??
        (typeof parent === 'string' || typeof parent === 'number'
            ? String(parent)
            : undefined) ??
        firstString(fields, [
            'parentId',
            'parent_id',
            'parentKey',
            'parent_key',
            // Azure Boards names a work item's parent in its fields.
            'System.Parent',
        ]);
    const subtasks = SUBTASK_FIELDS.flatMap((key) =>
        Array.isArray(fields[key]) ? (fields[key] as unknown[]) : [],
    )
        .map((entry) => relatedTask(asRecord(entry)))
        .filter((task): task is RelatedTask => !!task)
        .slice(0, MAX_SUBTASKS);
    const documents = (Array.isArray(fields.documents) ? fields.documents : [])
        .map((entry) => asRecord(entry))
        .filter((doc) => typeof doc.id === 'string')
        .map((doc) => ({
            id: doc.id as string,
            title: textField(doc, ['title', 'name']),
            content: textField(doc, ['content', 'body', 'text']),
        }));
    const links: TaskLinks = {
        ...(parentId ? { parentId } : {}),
        ...(parentId && relatedTask(parentRecord)?.title
            ? { parentTitle: relatedTask(parentRecord)!.title }
            : {}),
        ...(subtasks.length ? { subtasks } : {}),
        ...(documents.length ? { documents } : {}),
    };
    return Object.keys(links).length ? links : undefined;
}

const SUBTASK_FIELDS = [
    'subtasks',
    'subTasks',
    'sub_tasks',
    'subIssues',
    'sub_issues',
    'children',
];

/** A linked item as `{ id, title, status }`, from its own shape or Jira's `fields`. */
export function relatedTask(record: JsonRecord): RelatedTask | undefined {
    const id = idOf(record);
    if (!id) {
        return undefined;
    }
    const fields = { ...record, ...asRecord(record.fields) };
    const status = fields.status ?? fields.state;
    return {
        id,
        title: textField(fields, ['title', 'summary', 'name']),
        status:
            typeof status === 'string'
                ? status
                : textField(asRecord(status), ['name', 'status']),
    };
}

/** The id a person would type for the item: its key or identifier before an internal id. */
function idOf(record: JsonRecord): string | undefined {
    // A GitHub issue's `id` is internal; its `number` is what people type.
    return firstString(record, [
        'identifier',
        'key',
        'custom_id',
        'number',
        'id',
    ]);
}

function firstString(record: JsonRecord, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
        if (typeof value === 'number') {
            return String(value);
        }
    }
    return undefined;
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

/** Tags that mark a field as HTML. */
const HTML_TAG =
    /<\/?(?:div|p|br|span|b|i|u|strong|em|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|a|img|code|pre|blockquote|hr)\b[^>]*>/i;

/**
 * The tags removed once a field is HTML: the ones above and other elements
 * a tracker field holds. Anything else between angle brackets is text
 * (`Array<string>`, `Map<String, List<Order>>`) and stays, escaped.
 */
const REMOVED_TAG =
    /<\/?(?:div|p|br|span|b|i|u|strong|em|ul|ol|li|h[1-6]|table|thead|tbody|tfoot|tr|td|th|a|img|code|pre|blockquote|hr|section|article|aside|header|footer|nav|figure|figcaption|details|summary|dl|dt|dd|del|ins|sub|sup|strike|kbd|samp|abbr|cite|script|style|iframe|svg|video|audio|embed|noscript|textarea|canvas)\b[^<>]*>|<!--[^<>]*-->/gi;
/** Removal passes: each one undoes one level of `<scr<script>ipt>`. */
const MAX_TAG_PASSES = 5;

/**
 * Plain text from the HTML some trackers store (Azure DevOps). Text without
 * HTML is returned as is. Whatever `<` is left is escaped, so no tag comes
 * back however deep the nesting.
 */
export function htmlToText(text: string | undefined): string | undefined {
    if (!text || !HTML_TAG.test(text)) {
        return text;
    }
    let plain = text
        .replace(/<li\b[^>]*>/gi, '- ')
        .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, '\n');
    // A bounded number of passes, so a crafted body costs linear time; a tag
    // nested deeper is escaped below like any other `<`.
    for (let pass = 0; pass < MAX_TAG_PASSES; pass++) {
        const before = plain.length;
        plain = plain.replace(REMOVED_TAG, '');
        if (plain.length >= before) {
            break;
        }
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
