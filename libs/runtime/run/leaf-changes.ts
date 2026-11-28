import { clip, maskNested, REDACTED, SECRET_KEY } from './response-diff';

// The leaves that differ between two whole-value JSON strings the gate stores
// for one compared field (docs/runtime/monorepo-speed-and-targeting.md §3).
// The gate compares an array as one field (`json.applinks.details`): a finding
// on it says only that the array differs. This reads the same two strings,
// after the gate has decided, and names each leaf that differs, so the PR
// author sees `applinks.details[0].paths[0]` and its two values. It decides
// nothing and renames no field: masks, history and kept checks keep the
// gate's names.
//
// It never invents a path or a value: a leaf is a difference between the two
// strings it was given, found by descending both (objects by key, arrays by
// index). Values are cleaned by the caller's `clean`, a secret-looking key is
// always `[redacted]` (the Response tab's rule, response-diff.ts), and every
// value is cut to 200 characters.

export const LEAF_CHANGES_MAX = 200;
export const LEAF_DEPTH_MAX = 16;

export const LEAF_CHANGE_KINDS = ['added', 'removed', 'changed', 'reordered'] as const;
export type LeafChangeKind = (typeof LEAF_CHANGE_KINDS)[number];

/** One leaf that differs: its path (`applinks.details[0].paths[0]`), how, and the two cleaned values (JSON text). */
export interface LeafChange {
    path: string;
    kind: LeafChangeKind;
    base?: string;
    pr?: string;
    /** On a described leaf: what described it, a passed assertion of the description or the diff spelling the swap. */
    by?: LeafDescribedBy;
}

export const LEAF_DESCRIBED_BY = ['description', 'diff'] as const;
export type LeafDescribedBy = (typeof LEAF_DESCRIBED_BY)[number];

export interface LeafChanges {
    leaves: LeafChange[];
    /** More leaves differed than are listed, or a difference sat below the depth cap. */
    truncated: boolean;
}

type Segment = string | number;

const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/**
 * A path as leaves spell it: keys joined by dots, indexes in brackets, a key
 * that is not a plain name (`/`, `x.y`) quoted in brackets; the root alone is
 * `$`. The first segment is the field's own prefix (`applinks.details`) and is
 * kept as given.
 */
export function leafPathOf(segments: readonly Segment[]): string {
    if (!segments.length) return '$';
    return segments.reduce<string>((out, s, i) => {
        if (typeof s === 'number') return `${out}[${s}]`;
        if (i === 0) return s;
        return PLAIN_KEY.test(s) ? `${out}.${s}` : `${out}[${JSON.stringify(s)}]`;
    }, '');
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const canonical = (v: unknown): string =>
    JSON.stringify(v, (_k, x) => (isObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

function parse(text: string): { ok: true; value: unknown } | { ok: false } {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch {
        return { ok: false };
    }
}

/** Whether `path` is `under` or a leaf below it, by whole segments (`a.b[0]` is under `a.b`; `a.bc` is not). */
export const isPathUnder = (path: string, under: string): boolean =>
    path === under || (path.startsWith(under) && (path[under.length] === '.' || path[under.length] === '['));

export function leafChanges(
    base: string | undefined,
    pr: string | undefined,
    opts: { prefix?: string; clean?: (text: string) => string; exclude?: readonly string[] } = {},
): LeafChanges {
    const clean = opts.clean ?? ((t: string) => t);
    const prefix: Segment[] = opts.prefix ? [opts.prefix] : [];
    const leaves: LeafChange[] = [];
    let truncated = false;

    const excluded = (path: string) => (opts.exclude ?? []).some((e) => isPathUnder(path, e));
    const text = (segments: readonly Segment[], raw: string): string => {
        if (segments.some((s) => typeof s === 'string' && SECRET_KEY.test(s))) return REDACTED;
        return clip(maskNested(clean(raw)));
    };
    const push = (segments: readonly Segment[], kind: LeafChangeKind, b: unknown, p: unknown, raw?: { base?: string; pr?: string }) => {
        const path = leafPathOf(segments);
        if (excluded(path)) return;
        if (leaves.length >= LEAF_CHANGES_MAX) {
            truncated = true;
            return;
        }
        const side = (v: unknown, r: string | undefined) => (r !== undefined ? r : v === undefined ? undefined : JSON.stringify(v));
        const bt = side(b, raw?.base);
        const pt = side(p, raw?.pr);
        leaves.push({ path, kind, ...(bt !== undefined ? { base: text(segments, bt) } : {}), ...(pt !== undefined ? { pr: text(segments, pt) } : {}) });
    };

    const walk = (a: unknown, b: unknown, at: Segment[], depth: number): void => {
        if (a === undefined || b === undefined) return push(at, a === undefined ? 'added' : 'removed', a, b);
        if (canonical(a) === canonical(b)) return;
        if (depth >= LEAF_DEPTH_MAX && (isObject(a) || Array.isArray(a) || isObject(b) || Array.isArray(b))) {
            truncated = true;
            return push(at, 'changed', a, b);
        }
        if (isObject(a) && isObject(b)) {
            for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
                walk(Object.hasOwn(a, k) ? a[k] : undefined, Object.hasOwn(b, k) ? b[k] : undefined, [...at, k], depth + 1);
            }
            return;
        }
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length === b.length && JSON.stringify(a.map(canonical).sort()) === JSON.stringify(b.map(canonical).sort())) return push(at, 'reordered', a, b);
            for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], [...at, i], depth + 1);
            return;
        }
        push(at, 'changed', a, b);
    };

    // A side that has no such field is one leaf at the field; a text that is not JSON is its own value.
    const x = base === undefined ? undefined : parse(base);
    const y = pr === undefined ? undefined : parse(pr);
    if (base === undefined || pr === undefined || !x?.ok || !y?.ok) {
        if (base !== pr) push(prefix, base === undefined ? 'added' : pr === undefined ? 'removed' : 'changed', undefined, undefined, { ...(base !== undefined ? { base } : {}), ...(pr !== undefined ? { pr } : {}) });
        return { leaves, truncated };
    }
    walk(x.value, y.value, prefix, 0);
    return { leaves, truncated };
}

/**
 * A finding's leaves as the report keeps them: the leaves no passed assertion
 * reads (what the finding is about), those one does (a count's worth of
 * context), and the paths the passed assertions read (`mentions`), which the
 * comment quotes as what the description covers. Built from data of the Run,
 * never from the PR's text or a model.
 */
export interface LeafChangeSet {
    undescribed: LeafChange[];
    described: LeafChange[];
    /** The paths the passed assertions read, in the leaves' spelling, at most 20. */
    mentions: string[];
    truncated: boolean;
}

export const LEAF_MENTIONS_MAX = 20;
