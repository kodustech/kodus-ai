import type { MCPToolRaw } from '@libs/mcp-server/mcp-adapter';

import { asRecord } from '../value-utils';

/**
 * A read of one item that can pick its fields asks for all of them: Jira
 * leaves custom fields, where teams keep criteria, out of its default answer,
 * and names them only when asked. A field list the server enumerates (Linear)
 * already answers in full by default.
 */
export function wholeItem(
    tool: MCPToolRaw,
    args: Record<string, unknown>,
): Record<string, unknown> {
    if (MANY_ITEMS.test(tool.name)) {
        return args;
    }
    const properties = asRecord(asRecord(tool.inputSchema).properties);
    const fields = asRecord(properties.fields);
    const expand = asRecord(properties.expand);
    const whole = { ...args };
    if (
        fields.type === 'array' &&
        !Array.isArray(asRecord(fields.items).enum)
    ) {
        const asked = Array.isArray(args.fields) ? args.fields : [];
        whole.fields = asked.includes('*all') ? asked : [...asked, '*all'];
    }
    // A read that returns a summary unless asked (ClickUp's `include`):
    // ask for the sections a task's requirements live in.
    for (const name of ['include', 'fields', 'expand']) {
        const param = asRecord(properties[name]);
        const options = asRecord(param.items).enum;
        if (param.type !== 'array' || !Array.isArray(options)) {
            continue;
        }
        const asked = Array.isArray(args[name])
            ? (args[name] as unknown[])
            : [];
        const wanted = options.filter(
            (o): o is string =>
                typeof o === 'string' &&
                TASK_SECTIONS.test(o) &&
                !asked.includes(o),
        );
        if (wanted.length) {
            whole[name] = [...asked, ...wanted];
        }
    }
    if (expand.type === 'string' && !Array.isArray(expand.enum)) {
        const asked = typeof args.expand === 'string' ? args.expand : '';
        whole.expand = /\bnames\b/.test(asked)
            ? asked
            : [asked, 'names'].filter(Boolean).join(',');
    }
    return whole;
}

/** Sections a task's requirements live in, by the names trackers give them. */
const TASK_SECTIONS =
    /^(description|text_content|markdown_description|custom_fields|checklists?|subtasks|acceptance_criteria)$/i;

/**
 * A plural noun or a list/search verb: the tool returns many items, not the
 * one asked for (asked for all their fields, the answer would be huge).
 */
export const MANY_ITEMS =
    /(list|search|query|find|all|batch|backlog)|(issues|tasks|tickets|items|stories|cards)\b/i;
