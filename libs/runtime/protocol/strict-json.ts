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

export function parseStrictJson(text: string, maxDepth = 32): unknown {
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
