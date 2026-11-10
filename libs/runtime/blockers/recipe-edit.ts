import * as yaml from 'js-yaml';

import type { RecipeChange } from './catalog';

// A fix that changes the recipe edits one field under services.compose and
// leaves every other byte alone: the customer's comments and layout stay, and
// the PR diff is the one line the fix is about. The edit is checked by loading
// both versions: the only difference must be the field, or it is refused.

export type RecipeEdit = { ok: true; text: string; diff: string } | { ok: false; error: string };

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const indentOf = (line: string) => line.length - line.trimStart().length;
const isContent = (line: string) => line.trim() !== '' && !line.trimStart().startsWith('#');
const quote = (v: string) => JSON.stringify(v);

/** The line index of `key:` among the direct children of the block that starts after `from` with indent `indent`. */
function findKey(lines: string[], from: number, end: number, indent: number, key: string) {
    for (let i = from; i < end; i += 1) {
        if (!isContent(lines[i])) continue;
        const ind = indentOf(lines[i]);
        if (ind < indent) return -1;
        if (ind === indent && new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:(\\s|$)`).test(lines[i])) return i;
    }
    return -1;
}

/** Where the block of the key on line `at` ends (exclusive), and the indent of its children. */
function blockOf(lines: string[], at: number) {
    const parent = indentOf(lines[at]);
    let end = at + 1;
    let child: number | undefined;
    while (end < lines.length) {
        if (isContent(lines[end])) {
            const ind = indentOf(lines[end]);
            if (ind <= parent) break;
            child ??= ind;
        }
        end += 1;
    }
    // Trailing blank or comment lines belong to what follows.
    while (end > at + 1 && !isContent(lines[end - 1])) end -= 1;
    return { end, child };
}

const get = (doc: unknown, path: string[]) => path.reduce<unknown>((v, k) => (isMap(v) ? v[k] : undefined), doc);

function textEdit(text: string, change: RecipeChange): string | null {
    const lines = text.split('\n');
    const services = findKey(lines, 0, lines.length, 0, 'services');
    if (services < 0) return null;
    const sBlock = blockOf(lines, services);
    if (sBlock.child === undefined) return null;
    const compose = findKey(lines, services + 1, sBlock.end, sBlock.child, 'compose');
    if (compose < 0) return null;
    const cBlock = blockOf(lines, compose);
    const step = sBlock.child;
    const cIndent = cBlock.child ?? indentOf(lines[compose]) + step;
    const pad = (n: number) => ' '.repeat(n);

    if (change.path[0] !== 'env') {
        // A scalar of services.compose. A timeout stays bare (`180s`); a path or a service name is quoted so YAML reads it back as the same string.
        const key = change.path[0];
        const at = findKey(lines, compose + 1, cBlock.end, cIndent, key);
        const line = `${pad(cIndent)}${key}: ${key === 'health_timeout' ? change.value : quote(change.value)}`;
        if (at >= 0) lines[at] = line;
        else lines.splice(cBlock.end, 0, line);
        return lines.join('\n');
    }

    const name = change.path[1]!;
    const env = findKey(lines, compose + 1, cBlock.end, cIndent, 'env');
    if (env < 0) {
        lines.splice(cBlock.end, 0, `${pad(cIndent)}env:`, `${pad(cIndent + step)}${name}: ${quote(change.value)}`);
        return lines.join('\n');
    }
    if (/:\s*\{/.test(lines[env])) return null; // a flow mapping: not edited by hand
    const eBlock = blockOf(lines, env);
    const eIndent = eBlock.child ?? cIndent + step;
    const at = findKey(lines, env + 1, eBlock.end, eIndent, name);
    const line = `${pad(eIndent)}${name}: ${quote(change.value)}`;
    if (at >= 0) lines[at] = line;
    else lines.splice(eBlock.end, 0, line);
    return lines.join('\n');
}

/** A unified diff of one contiguous change, with up to 3 lines of context. */
export function lineDiff(before: string, after: string, path = '.kodus/workspace.yaml'): string {
    const a = before.split('\n');
    const b = after.split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1;
        endB -= 1;
    }
    const from = Math.max(0, start - 3);
    const toA = Math.min(a.length, endA + 3);
    const toB = Math.min(b.length, endB + 3);
    const out = [`--- a/${path}`, `+++ b/${path}`, `@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`];
    for (let i = from; i < start; i += 1) out.push(` ${a[i]}`);
    for (let i = start; i < endA; i += 1) out.push(`-${a[i]}`);
    for (let i = start; i < endB; i += 1) out.push(`+${b[i]}`);
    for (let i = endA; i < toA; i += 1) out.push(` ${a[i]}`);
    return out.join('\n');
}

export function applyRecipeChange(text: string, change: RecipeChange, path?: string): RecipeEdit {
    let before: unknown;
    try {
        before = yaml.load(text, { schema: yaml.CORE_SCHEMA });
    } catch {
        return { ok: false, error: "the recipe doesn't parse" };
    }
    const fieldPath = ['services', 'compose', ...change.path];
    const edited = isMap(get(before, ['services', 'compose'])) ? textEdit(text, change) : null;
    if (edited === null)
        return {
            ok: false,
            error: 'services.compose is not a block the fix can edit; change the recipe by hand',
        };

    // The check: the edited recipe loads, the field has the value, and nothing else moved.
    let after: unknown;
    try {
        after = yaml.load(edited, { schema: yaml.CORE_SCHEMA });
    } catch {
        return { ok: false, error: 'the edit would break the recipe' };
    }
    if (get(after, fieldPath) !== change.value) return { ok: false, error: 'the edit did not set the field' };
    const expected = structuredClone(before) as Record<string, any>;
    const parent = get(expected, fieldPath.slice(0, -1)) as Record<string, unknown> | undefined;
    if (parent && isMap(parent)) parent[fieldPath.at(-1)!] = change.value;
    else
        (expected.services.compose as Record<string, unknown>).env = {
            [change.path[1]!]: change.value,
        };
    if (JSON.stringify(after) !== JSON.stringify(expected)) return { ok: false, error: 'the edit changed more than the field' };
    return { ok: true, text: edited, diff: lineDiff(text, edited, path) };
}
