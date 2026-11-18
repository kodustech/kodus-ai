// JSON.parse keeps the last of two duplicate keys and has no depth limit, and
// the Go side decodes keys case-insensitively. A frame that two parsers can
// read differently is refused here, before any schema runs (ADR-051, S-30).
// `__proto__` is refused too: assigned to a plain object it replaces the
// prototype, and zod reads inherited properties, so a field hidden there
// would pass a strict schema that never saw it as a key.

export type StrictJsonErrorCode = 'invalid_json' | 'duplicate_key' | 'too_deep';

export class StrictJsonError extends Error {
    constructor(
        readonly code: StrictJsonErrorCode,
        message: string,
    ) {
        super(message);
    }
}

/** Keys refused anywhere in a frame (see the header). */
export const RESERVED_JSON_KEYS: ReadonlySet<string> = new Set(['__proto__']);

const NUMBER_OR_LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/**
 * The strict parse of `text`: duplicate and reserved keys and nesting past `maxDepth` refused. Most frames are
 * clean, so the value comes from the native JSON.parse and one scan of the text checks the structure: it
 * reads only keys and brackets, and jumps over every string with indexOf. A frame the scan cannot clear (or
 * JSON.parse refuses) goes through strictJsonByHand, which throws the precise error or, when the scan was
 * only cautious, returns the same value. strict-json.spec.ts holds the two to the same answers. Measured on
 * Node 22: a 1 MiB string-heavy frame 6.3-6.9 ms by hand, 0.8 ms here; a 475 KB object-heavy one (9 000
 * small objects) 15-44 ms by hand, 3.9-5.4 ms here (JSON.parse alone: 1.7-3.4 ms).
 */
export function parseStrictJson(text: string, maxDepth = 32): unknown {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return strictJsonByHand(text, maxDepth);
    }
    return structureIsClean(text, maxDepth) ? value : strictJsonByHand(text, maxDepth);
}

/**
 * The keys seen in one open object: the offsets of each key in the text while it is short (no string or Set
 * made per small object), a Set of the keys once it is long. An array holds none.
 */
type OpenKeys = number[] | Set<string> | null;
const SHORT_OBJECT = 16;
const RESERVED_SPANS = [...RESERVED_JSON_KEYS];

function sameSpan(text: string, a: number, b: number, length: number): boolean {
    for (let k = 0; k < length; k++) if (text.charCodeAt(a + k) !== text.charCodeAt(b + k)) return false;
    return true;
}

/**
 * Whether valid JSON `text` (JSON.parse accepted it) has no duplicate key, no reserved key and no container at
 * depth `maxDepth` or more. Complete, not exact: every refusal of strictJsonByHand is flagged (a value too deep
 * sits inside a container at depth >= maxDepth); an empty container at that depth, and any key written with an
 * escape (compared only once unescaped), are flagged too and settled by the hand parser.
 */
function structureIsClean(text: string, maxDepth: number): boolean {
    const open: OpenKeys[] = [];
    let expectKey = false;
    const n = text.length;
    let i = 0;
    while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 0x22) {
            // The closing quote is the first one not escaped (an even run of backslashes before it).
            let end = text.indexOf('"', i + 1);
            for (;;) {
                let k = end - 1;
                while (text.charCodeAt(k) === 0x5c) k--;
                if ((end - 1 - k) % 2 === 0) break;
                end = text.indexOf('"', end + 1);
            }
            if (expectKey) {
                const start = i + 1;
                const length = end - start;
                for (let k = start; k < end; k++) if (text.charCodeAt(k) === 0x5c) return false;
                for (const reserved of RESERVED_SPANS) if (length === reserved.length && text.startsWith(reserved, start)) return false;
                const keys = open[open.length - 1]!;
                if (Array.isArray(keys)) {
                    for (let k = 0; k < keys.length; k += 2) if (keys[k + 1] === length && sameSpan(text, keys[k], start, length)) return false;
                    keys.push(start, length);
                    if (keys.length > SHORT_OBJECT * 2) {
                        const set = new Set<string>();
                        for (let k = 0; k < keys.length; k += 2) set.add(text.substr(keys[k], keys[k + 1]));
                        open[open.length - 1] = set;
                    }
                } else {
                    const key = text.slice(start, end);
                    if (keys!.has(key)) return false;
                    keys!.add(key);
                }
                expectKey = false;
            }
            i = end + 1;
            continue;
        }
        if (c === 0x7b || c === 0x5b) {
            if (open.length >= maxDepth) return false;
            const object = c === 0x7b;
            open.push(object ? [] : null);
            expectKey = object;
        } else if (c === 0x7d || c === 0x5d) {
            open.pop();
        } else if (c === 0x2c) {
            expectKey = open[open.length - 1] !== null;
        }
        i++;
    }
    return true;
}

/**
 * The reference strict parser, character by character: the error it throws names the first refusal and where
 * it is. parseStrictJson falls back to it for every frame its scan does not clear; exported for the
 * differential test that holds the two to the same answers.
 */
export function strictJsonByHand(text: string, maxDepth = 32): unknown {
    let i = 0;

    const fail = (code: StrictJsonErrorCode, message: string): never => {
        throw new StrictJsonError(code, `${message} at ${i}`);
    };
    const skipWs = () => {
        while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
    };
    const expect = (ch: string) => {
        if (text[i] !== ch) fail('invalid_json', `expected '${ch}'`);
        i++;
    };

    const parseString = (): string => {
        const start = i;
        expect('"');
        while (i < text.length && text[i] !== '"') {
            if (text[i] === '\\') i++;
            i++;
        }
        expect('"');
        try {
            return JSON.parse(text.slice(start, i)) as string;
        } catch {
            return fail('invalid_json', 'bad string');
        }
    };

    const parseValue = (depth: number): unknown => {
        if (depth > maxDepth) fail('too_deep', `nesting deeper than ${maxDepth}`);
        skipWs();
        const ch = text[i];
        if (ch === '{') {
            i++;
            const out: Record<string, unknown> = {};
            const seen = new Set<string>();
            skipWs();
            if (text[i] === '}') {
                i++;
                return out;
            }
            for (;;) {
                skipWs();
                const key = parseString();
                if (seen.has(key)) fail('duplicate_key', `duplicate key "${key}"`);
                if (RESERVED_JSON_KEYS.has(key)) fail('invalid_json', `reserved key "${key}"`);
                seen.add(key);
                skipWs();
                expect(':');
                Object.defineProperty(out, key, { value: parseValue(depth + 1), enumerable: true, writable: true, configurable: true });
                skipWs();
                if (text[i] === ',') {
                    i++;
                    continue;
                }
                expect('}');
                return out;
            }
        }
        if (ch === '[') {
            i++;
            const out: unknown[] = [];
            skipWs();
            if (text[i] === ']') {
                i++;
                return out;
            }
            for (;;) {
                out.push(parseValue(depth + 1));
                skipWs();
                if (text[i] === ',') {
                    i++;
                    continue;
                }
                expect(']');
                return out;
            }
        }
        if (ch === '"') return parseString();
        // Sticky, from i: a number of any length reads whole, as Go reads it.
        NUMBER_OR_LITERAL.lastIndex = i;
        const m = NUMBER_OR_LITERAL.exec(text);
        if (!m) return fail('invalid_json', 'unexpected token');
        i += m[0].length;
        return JSON.parse(m[0]);
    };

    const value = parseValue(0);
    skipWs();
    if (i !== text.length) fail('invalid_json', 'trailing data');
    return value;
}
