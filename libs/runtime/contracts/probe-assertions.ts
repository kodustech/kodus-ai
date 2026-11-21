import { z } from 'zod';

import type { Probe, ProbeResult } from '@libs/runtime/probe/probe.schema';

/** Control-plane expectations only: never part of the cell's Probe protocol. */
export const ProbeAssertionsSchema = z.strictObject({
    kind: z.literal('http'),
    status: z.number().int().min(100).max(599),
    bodyIncludes: z.string().min(1).max(2_000).optional(),
});
export type ProbeAssertions = z.infer<typeof ProbeAssertionsSchema>;

/** Undefined means there is no demonstrable HTTP expectation, not that it failed. */
export function httpExpectedHolds(probe: Probe, result: ProbeResult, assertions?: ProbeAssertions): boolean | undefined {
    if (probe.spec.kind !== 'http' || !result.http) return undefined;
    if (assertions) {
        return result.http.status === assertions.status && (assertions.bodyIncludes === undefined || result.http.body.includes(assertions.bodyIncludes));
    }
    const expected = probe.expected.trim();
    if (/^\d{3}$/.test(expected)) return String(result.http.status) === expected;
    // Legacy literal predictions remain demonstrable; a prose miss says nothing about its meaning.
    return expected && result.http.body.includes(expected) ? true : undefined;
}

// Intent assertions (docs/runtime/intent-oracle.md): what a PR says its change
// does, written as a closed set checked on the PR side's answer. The intent
// author writes them from the PR's text, never from its code; a deterministic
// check decides. Paths and expressions are parsed here by hand: nothing the
// model writes is ever compiled or evaluated as code.

export const INTENT_ASSERTION_LIMITS = {
    pathChars: 200,
    pathSegments: 16,
    exprChars: 300,
    exprTokens: 64,
    exprDepth: 16,
    literalChars: 2_000,
    quoteChars: 500,
    maxTolerance: 1e9,
} as const;
/** Absolute: money in cents. */
export const DEFAULT_INTENT_TOLERANCE = 0.01;

export type JsonPathSegment = string | number;

const KEY = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * `$`, `$.a.b`, `$.a[0].b`: keys and array indexes only. Undefined outside the
 * subset. `.length` on an array is its length (`$.length`, `$.items.length`);
 * on an object it is the key.
 */
export function parseJsonPath(path: string): JsonPathSegment[] | undefined {
    const read = readPath(path, 0, '$');
    return read && read.end === path.length ? read.segments : undefined;
}

/** A path from `at`, after the root word; where it ends. */
function readPath(text: string, at: number, root: string): { segments: JsonPathSegment[]; end: number } | undefined {
    if (text.length > INTENT_ASSERTION_LIMITS.pathChars + at || !text.startsWith(root, at)) return undefined;
    let i = at + root.length;
    const segments: JsonPathSegment[] = [];
    while (i < text.length && (text[i] === '.' || text[i] === '[')) {
        if (text[i] === '.') {
            const key = KEY.exec(text.slice(i + 1));
            if (!key) return undefined;
            segments.push(key[0]);
            i += 1 + key[0].length;
        } else {
            const index = /^\[(0|[1-9]\d{0,5})\]/.exec(text.slice(i));
            if (!index) return undefined;
            segments.push(Number(index[1]));
            i += index[0].length;
        }
        if (segments.length > INTENT_ASSERTION_LIMITS.pathSegments) return undefined;
    }
    return { segments, end: i };
}

export type IntentExpression =
    | { kind: 'num'; value: number }
    | { kind: 'ref'; root: 'response' | 'request'; path: JsonPathSegment[] }
    | { kind: 'neg'; of: IntentExpression }
    | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: IntentExpression; right: IntentExpression };

type Token = { t: 'num'; value: number } | { t: 'ref'; root: 'response' | 'request'; path: JsonPathSegment[] } | { t: 'op'; op: '+' | '-' | '*' | '/' | '(' | ')' };

function tokenize(expr: string): Token[] | undefined {
    const tokens: Token[] = [];
    let i = 0;
    while (i < expr.length) {
        const c = expr[i];
        if (c === ' ') {
            i++;
            continue;
        }
        if ('+-*/()'.includes(c)) {
            tokens.push({ t: 'op', op: c as '+' });
            i++;
        } else if (/[0-9]/.test(c)) {
            const n = /^\d{1,15}(\.\d{1,15})?(?![\dA-Za-z_.])/.exec(expr.slice(i));
            if (!n) return undefined;
            tokens.push({ t: 'num', value: Number(n[0]) });
            i += n[0].length;
        } else if (c === '$') {
            const root = expr.startsWith('$request', i) && !/[A-Za-z0-9_]/.test(expr[i + 8] ?? '') ? 'request' : 'response';
            const read = readPath(expr, i, root === 'request' ? '$request' : '$');
            if (!read || /[A-Za-z0-9_]/.test(expr[read.end] ?? '')) return undefined;
            // The request root already is its JSON body: `$request.body.x` reads nothing the author meant (kr-shop #8).
            if (root === 'request' && read.segments[0] === 'body') return undefined;
            tokens.push({ t: 'ref', root, path: read.segments });
            i = read.end;
        } else {
            return undefined;
        }
        if (tokens.length > INTENT_ASSERTION_LIMITS.exprTokens) return undefined;
    }
    return tokens;
}

/** `+ - * /`, unary minus, numbers, parentheses, `$.path` (the response) and `$request.path` (the request's JSON body). */
export function parseIntentExpression(expr: string): IntentExpression | undefined {
    if (!expr.trim() || expr.length > INTENT_ASSERTION_LIMITS.exprChars) return undefined;
    const tokens = tokenize(expr);
    if (!tokens) return undefined;
    let at = 0;
    const peekOp = () => {
        const tok = tokens[at];
        return tok?.t === 'op' ? tok.op : undefined;
    };
    const sum = (depth: number): IntentExpression | undefined => {
        let left = product(depth);
        while (left && (peekOp() === '+' || peekOp() === '-')) {
            const op = peekOp() as '+' | '-';
            at++;
            const right = product(depth);
            left = right ? { kind: 'bin', op, left, right } : undefined;
        }
        return left;
    };
    const product = (depth: number): IntentExpression | undefined => {
        let left = factor(depth);
        while (left && (peekOp() === '*' || peekOp() === '/')) {
            const op = peekOp() as '*' | '/';
            at++;
            const right = factor(depth);
            left = right ? { kind: 'bin', op, left, right } : undefined;
        }
        return left;
    };
    const factor = (depth: number): IntentExpression | undefined => {
        if (depth > INTENT_ASSERTION_LIMITS.exprDepth) return undefined;
        const tok = tokens[at++];
        if (!tok) return undefined;
        if (tok.t === 'num') return { kind: 'num', value: tok.value };
        if (tok.t === 'ref') return { kind: 'ref', root: tok.root, path: tok.path };
        if (tok.op === '-') {
            const of = factor(depth + 1);
            return of ? { kind: 'neg', of } : undefined;
        }
        if (tok.op !== '(') return undefined;
        const inner = sum(depth + 1);
        if (!inner || peekOp() !== ')') return undefined;
        at++;
        return inner;
    };
    const tree = sum(0);
    return tree && at === tokens.length ? tree : undefined;
}

const isJsonValue = (v: unknown): boolean => {
    if (v === undefined) return false;
    try {
        const text = JSON.stringify(v);
        return text !== undefined && text.length <= INTENT_ASSERTION_LIMITS.literalChars;
    } catch {
        return false;
    }
};

/**
 * An `every` path: an array path, one `[*]`, then the path inside each
 * element (`$[*].item`, `$.items[*].sku`, `$[*]`). Undefined otherwise.
 */
export function parseEveryPath(path: string): { array: JsonPathSegment[]; element: JsonPathSegment[] } | undefined {
    const at = path.indexOf('[*]');
    if (at < 0 || path.indexOf('[*]', at + 3) >= 0) return undefined;
    const array = parseJsonPath(path.slice(0, at));
    const element = parseJsonPath(`$${path.slice(at + 3)}`);
    return array && element ? { array, element } : undefined;
}

const JsonPathSchema = z
    .string()
    .max(INTENT_ASSERTION_LIMITS.pathChars)
    .refine((p) => parseJsonPath(p) !== undefined, { message: 'a JSON path is $, then .key or [index] only' });

/** The closed set, evaluated on the PR side's answer. Anything else is dropped before the Run tests. */
export const IntentAssertionSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('status'), status: z.number().int().min(100).max(599) }),
    z.strictObject({
        kind: z.literal('equals'),
        path: JsonPathSchema,
        value: z.unknown().refine(isJsonValue, { message: `a JSON literal of at most ${INTENT_ASSERTION_LIMITS.literalChars} characters` }),
    }),
    z.strictObject({ kind: z.literal('sameAs'), path: JsonPathSchema, other: JsonPathSchema }),
    /**
     * Every element of an array has a value equal to a literal (`$[*].item == "keyboard"`):
     * a filter. An empty array holds only with `allowEmpty` ("returns only keyboard orders"
     * with a seeded keyboard order is not met by an empty list).
     */
    z.strictObject({
        kind: z.literal('every'),
        path: z
            .string()
            .max(INTENT_ASSERTION_LIMITS.pathChars)
            .refine((p) => parseEveryPath(p) !== undefined, { message: 'an every path is an array path, one [*], then .key or [index] inside each element' }),
        value: z.unknown().refine(isJsonValue, { message: `a JSON literal of at most ${INTENT_ASSERTION_LIMITS.literalChars} characters` }),
        allowEmpty: z.boolean().optional(),
    }),
    /** A path's string value contains a literal; on `$`, any string of the answer or a body that is not JSON (a quoted error message). */
    z.strictObject({ kind: z.literal('includes'), path: JsonPathSchema, value: z.string().min(1).max(INTENT_ASSERTION_LIMITS.literalChars) }),
    z.strictObject({
        kind: z.literal('computed'),
        path: JsonPathSchema,
        expr: z
            .string()
            .max(INTENT_ASSERTION_LIMITS.exprChars)
            .refine((e) => parseIntentExpression(e) !== undefined, { message: 'an expression of + - * /, numbers, parentheses, $.path and $request.path' }),
        tolerance: z.number().min(0).max(INTENT_ASSERTION_LIMITS.maxTolerance).optional(),
    }),
]);
export type IntentAssertion = z.infer<typeof IntentAssertionSchema>;

/** The sentence an intent probe comes from: quoted exactly from the PR description or one linked task. */
export const StatedIntentSchema = z.strictObject({
    quote: z.string().trim().min(1).max(INTENT_ASSERTION_LIMITS.quoteChars),
    source: z.union([z.literal('description'), z.string().regex(/^task:\S{1,256}$/)]),
});
export type StatedIntent = z.infer<typeof StatedIntentSchema>;

/** The PR side's answer as an assertion reads it. */
export interface IntentAnswer {
    status?: number;
    /** `text`: a body that is not JSON, when known (the raw body, or an HTML page's visible text). */
    body: { json: true; value: unknown } | { json: false; text?: string };
    /** The request's own JSON body, for `$request` paths. */
    request?: unknown;
}

export interface IntentAssertionResult {
    held: boolean;
    expected: string;
    received: string;
    /** The assertion could not be evaluated on this answer (an expression with an absent or non-number operand): never a failure. */
    inconclusive?: true;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** JSON with every object's keys sorted: the same value always reads the same. */
const stable = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    return JSON.stringify(v) ?? 'null';
};

type Resolved = { found: true; value: unknown } | { found: false };

function resolve(root: unknown, path: JsonPathSegment[]): Resolved {
    let at: unknown = root;
    for (const s of path) {
        if (s === 'length' && Array.isArray(at)) {
            at = at.length;
            continue;
        }
        if (typeof s === 'number' ? !Array.isArray(at) || s >= at.length : !isPlainObject(at) || !Object.prototype.hasOwnProperty.call(at, s)) return { found: false };
        at = (at as any)[s];
    }
    return { found: true, value: at };
}

const responsePath = (answer: IntentAnswer, path: string): Resolved => (answer.body.json ? resolve(answer.body.value, parseJsonPath(path)!) : { found: false });
const shown = (r: Resolved) => (r.found ? stable(r.value) : 'absent');
const number = (n: number) => String(Math.round(n * 1e6) / 1e6);

function compute(e: IntentExpression, answer: IntentAnswer): number | undefined {
    switch (e.kind) {
        case 'num':
            return e.value;
        case 'ref': {
            const r = e.root === 'request' ? (answer.request === undefined ? { found: false as const } : resolve(answer.request, e.path)) : answer.body.json ? resolve(answer.body.value, e.path) : { found: false as const };
            return r.found && typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : undefined;
        }
        case 'neg': {
            const v = compute(e.of, answer);
            return v === undefined ? undefined : -v;
        }
        case 'bin': {
            const l = compute(e.left, answer);
            const r = compute(e.right, answer);
            if (l === undefined || r === undefined) return undefined;
            const v = e.op === '+' ? l + r : e.op === '-' ? l - r : e.op === '*' ? l * r : r === 0 ? undefined : l / r;
            return v !== undefined && Number.isFinite(v) ? v : undefined;
        }
    }
}

/** Every string of a JSON value. */
const strings = (v: unknown): string[] =>
    typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : isPlainObject(v) ? Object.values(v).flatMap(strings) : [];

const VALUE_SHOWN = 200;
const cutShown = (s: string) => (s.length > VALUE_SHOWN ? `${s.slice(0, VALUE_SHOWN - 1)}…` : s);

/** One assertion on one answer: whether it held, and what was expected and received, in the assertion's terms. */
export function evaluateIntentAssertion(a: IntentAssertion, answer: IntentAnswer): IntentAssertionResult {
    switch (a.kind) {
        case 'status':
            return { held: answer.status === a.status, expected: `status ${a.status}`, received: `status ${answer.status ?? 'none'}` };
        case 'equals': {
            const got = responsePath(answer, a.path);
            return { held: got.found && stable(got.value) === stable(a.value), expected: `${a.path} = ${stable(a.value)}`, received: shown(got) };
        }
        case 'sameAs': {
            const got = responsePath(answer, a.path);
            const other = responsePath(answer, a.other);
            return { held: got.found && other.found && stable(got.value) === stable(other.value), expected: `${a.path} = ${a.other} (${shown(other)})`, received: shown(got) };
        }
        case 'every': {
            const { array, element } = parseEveryPath(a.path)!;
            const expected = `${a.path} = ${stable(a.value)}`;
            const list = answer.body.json ? resolve(answer.body.value, array) : ({ found: false } as const);
            if (!list.found || !Array.isArray(list.value)) return { held: false, expected, received: list.found ? `not an array: ${cutShown(stable(list.value))}` : 'absent' };
            if (!list.value.length) return { held: a.allowEmpty === true, expected, received: 'an empty array' };
            const at = a.path.indexOf('[*]');
            const bad = list.value.findIndex((el) => {
                const got = resolve(el, element);
                return !got.found || stable(got.value) !== stable(a.value);
            });
            if (bad < 0) return { held: true, expected, received: expected };
            return { held: false, expected, received: `${a.path.slice(0, at)}[${bad}]${a.path.slice(at + 3)} = ${shown(resolve(list.value[bad], element))}` };
        }
        case 'includes': {
            const expected = `${a.path} includes ${JSON.stringify(a.value)}`;
            if (!parseJsonPath(a.path)!.length) {
                const body = answer.body;
                if (body.json) return { held: strings(body.value).some((x) => x.includes(a.value)), expected, received: cutShown(stable(body.value)) };
                // The runtime tsconfig is not strict: the discriminant does not narrow the false branch.
                const text = (body as { text?: string }).text;
                return { held: !!text?.includes(a.value), expected, received: text === undefined ? 'absent' : cutShown(JSON.stringify(text)) };
            }
            const got = responsePath(answer, a.path);
            return { held: got.found && typeof got.value === 'string' && got.value.includes(a.value), expected, received: cutShown(shown(got)) };
        }
        case 'computed': {
            const got = responsePath(answer, a.path);
            const want = compute(parseIntentExpression(a.expr)!, answer);
            const tolerance = a.tolerance ?? DEFAULT_INTENT_TOLERANCE;
            const expected = `${a.path} = ${a.expr} = ${want === undefined ? 'not computable' : number(want)}`;
            if (want === undefined) return { held: false, expected, received: shown(got), inconclusive: true };
            const held = got.found && typeof got.value === 'number' && Math.abs(got.value - want) <= tolerance;
            return { held, expected, received: shown(got) };
        }
    }
}

/** The assertion as one line: `$.charge == $.total`. */
export function intentAssertionText(a: IntentAssertion): string {
    switch (a.kind) {
        case 'status':
            return `status == ${a.status}`;
        case 'equals':
            return `${a.path} == ${stable(a.value)}`;
        case 'sameAs':
            return `${a.path} == ${a.other}`;
        case 'every':
            return `${a.path} == ${stable(a.value)}`;
        case 'includes':
            return `${a.path} includes ${JSON.stringify(a.value)}`;
        case 'computed':
            return `${a.path} == ${a.expr}`;
    }
}

function responseRefs(e: IntentExpression): JsonPathSegment[][] {
    if (e.kind === 'ref') return e.root === 'response' ? [e.path] : [];
    if (e.kind === 'neg') return responseRefs(e.of);
    if (e.kind === 'bin') return [...responseRefs(e.left), ...responseRefs(e.right)];
    return [];
}

/**
 * A rule over the response's own fields (docs/runtime/intent-oracle.md, kr-shop
 * #12): `sameAs`, or `computed` from response paths with no `$request` path.
 * It holds for every request of the route, so it may explain another probe of
 * the same method and route; a status, a literal or a rule that reads the
 * request stays tied to its own request.
 */
export function isRouteInvariant(a: IntentAssertion): boolean {
    if (a.kind === 'sameAs') return true;
    if (a.kind !== 'computed') return false;
    const e = parseIntentExpression(a.expr)!;
    const refs = (x: IntentExpression): Array<'response' | 'request'> =>
        x.kind === 'ref' ? [x.root] : x.kind === 'neg' ? refs(x.of) : x.kind === 'bin' ? [...refs(x.left), ...refs(x.right)] : [];
    const roots = refs(e);
    return roots.includes('response') && !roots.includes('request');
}

/**
 * What an assertion reads of the response: the status, its response paths (a
 * `$request` path is not the response) and, for `every`, the array it reads
 * the elements of (whether that explains the array is the gate's call). An
 * `includes` reads a substring: it explains no field.
 */
export function intentAssertionReads(a: IntentAssertion): { status: boolean; paths: JsonPathSegment[][]; arrays?: JsonPathSegment[][] } {
    switch (a.kind) {
        case 'every':
            return { status: false, paths: [], arrays: [parseEveryPath(a.path)!.array] };
        case 'includes':
            return { status: false, paths: [] };
        case 'status':
            return { status: true, paths: [] };
        case 'equals':
            return { status: false, paths: [parseJsonPath(a.path)!] };
        case 'sameAs':
            return { status: false, paths: [parseJsonPath(a.path)!, parseJsonPath(a.other)!] };
        case 'computed':
            return { status: false, paths: [parseJsonPath(a.path)!, ...responseRefs(parseIntentExpression(a.expr)!)] };
    }
}
