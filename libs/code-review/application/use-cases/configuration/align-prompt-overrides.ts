import { samePromptText } from '@libs/common/utils/writing-guidelines';

const PROMPT_PATHS: string[][] = [
    ['generation', 'main'],
    ['categories', 'descriptions', 'bug'],
    ['categories', 'descriptions', 'performance'],
    ['categories', 'descriptions', 'security'],
    ['severity', 'flags', 'critical'],
    ['severity', 'flags', 'high'],
    ['severity', 'flags', 'medium'],
    ['severity', 'flags', 'low'],
];

const get = (obj: any, path: string[]): unknown =>
    path.reduce((node, key) => (node == null ? undefined : node[key]), obj);

/**
 * The prompt editors write their default into the form as Tiptap JSON, and
 * saving any field on the page sends it back. Compared as strings it never
 * equals the parent's plain text, so the untouched default was stored as the
 * team's own and froze there. A prompt whose text equals the parent's takes
 * the parent's value, so the delta computed afterwards drops it.
 */
export function alignPromptOverridesWithParent<T extends Record<string, any>>(
    incoming: T,
    parent: Record<string, any> | undefined,
): { config: T; alignedPaths: string[] } {
    const overrides = incoming?.v2PromptOverrides;
    const parentOverrides = parent?.v2PromptOverrides;
    if (!overrides || !parentOverrides) {
        return { config: incoming, alignedPaths: [] };
    }

    const aligned = structuredClone(overrides);
    const alignedPaths: string[] = [];
    for (const path of PROMPT_PATHS) {
        const value = get(aligned, path);
        const parentValue = get(parentOverrides, path);
        if (value === undefined || parentValue === undefined) continue;
        if (samePromptText(value, parentValue)) {
            const holder = get(aligned, path.slice(0, -1)) as Record<string, unknown>;
            if (holder[path[path.length - 1]] !== parentValue) {
                alignedPaths.push(path.join('.'));
            }
            holder[path[path.length - 1]] = parentValue;
        }
    }

    return {
        config: { ...incoming, v2PromptOverrides: aligned },
        alignedPaths,
    };
}
