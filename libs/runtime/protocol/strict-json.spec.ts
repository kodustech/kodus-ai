import { parseStrictJson, StrictJsonError, strictJsonByHand } from './strict-json';

const codeOf = (text: string, maxDepth?: number) => {
    try {
        parseStrictJson(text, maxDepth);
        return 'ok';
    } catch (e) {
        return e instanceof StrictJsonError ? e.code : `threw ${String(e)}`;
    }
};

const nested = (depth: number, inner: string) => '{"a":'.repeat(depth) + inner + '}'.repeat(depth);

describe('parseStrictJson reads what JSON.parse reads', () => {
    it.each([
        '{"v":1,"body":{"list":[1,-2.5e3,true,false,null,"x"],"empty":{},"none":[]}}',
        '  [ {"a" : "b\\"c\\\\", "d":"\\u00e9\\n\\t"} , [] ]  ',
        '"just a string"',
        '0',
        '{"s":"\\",\\"s\\":1"}',
        '{"a":"\\\\\\\\","b":"x\\\\\\"y"}',
        '{"emoji":"\\ud83d\\ude00","raw":"😀"}',
    ])('%s', (text) => {
        expect(parseStrictJson(text)).toEqual(JSON.parse(text));
    });

    it('keeps the same key in sibling and nested objects', () => {
        expect(codeOf('{"a":{"a":1},"b":{"a":2},"c":[{"a":1},{"a":1}]}')).toBe('ok');
    });
});

describe('parseStrictJson refuses what two parsers could read differently', () => {
    it('refuses a duplicate key however deep it is', () => {
        expect(codeOf(nested(20, '{"k":1,"x":2,"k":3}'))).toBe('duplicate_key');
    });

    it('refuses a duplicate key spelled with an escape', () => {
        expect(codeOf('{"ab":1,"a\\u0062":2}')).toBe('duplicate_key');
        expect(codeOf('{"a\\u0062":1,"ab":2}')).toBe('duplicate_key');
    });

    it('refuses a duplicate key after a value that holds quotes and backslashes', () => {
        expect(codeOf('{"k":"\\\\","x":"\\"k\\":","k":0}')).toBe('duplicate_key');
    });

    it('refuses __proto__, also spelled with an escape', () => {
        expect(codeOf('{"a":{"__proto__":{"held":true}}}')).toBe('invalid_json');
        expect(codeOf('{"\\u005f_proto__":{"held":true}}')).toBe('invalid_json');
    });

    it('refuses nesting past the depth bound and keeps the bound itself', () => {
        expect(codeOf(nested(4, '1'), 4)).toBe('ok');
        expect(codeOf(nested(5, '1'), 4)).toBe('too_deep');
        expect(codeOf('['.repeat(5) + ']'.repeat(5), 4)).toBe('ok');
        expect(codeOf('['.repeat(6) + ']'.repeat(6), 4)).toBe('too_deep');
    });

    it('refuses deep nesting without exhausting the stack', () => {
        expect(codeOf('['.repeat(200_000))).toBe('too_deep');
    });

    it.each(['{"a":1}{}', '{"a":1,}', '[1,]', '{"a" 1}', '{"a":01}', '{"a":tru}', '{"a":"x', '{a:1}', "{'a':1}", '', '﻿{}', '{"a":"\u0001"}', '[1 2]'])(
        'refuses malformed JSON: %j',
        (text) => {
            expect(codeOf(text)).toBe('invalid_json');
        },
    );
});

describe('parseStrictJson cost (P13: the hub decodes every cell frame with it)', () => {
    const median = (fn: () => unknown, runs: number) => {
        for (let i = 0; i < 3; i++) fn();
        const times: number[] = [];
        for (let i = 0; i < runs; i++) {
            const start = process.hrtime.bigint();
            fn();
            times.push(Number(process.hrtime.bigint() - start));
        }
        return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
    };

    // Measured on the old value-building parser: 22 ms against JSON.parse's 3 ms on this ~840 KB frame (7x).
    // Under Stryker the parser runs instrumented and JSON.parse does not: the ratio says nothing there.
    const instrumented = '__stryker__' in globalThis;
    (instrumented ? it.skip : it)('reads an object-heavy frame in at most 5x what JSON.parse takes', () => {
        const items = Array.from({ length: 9_000 }, (_, i) => ({ id: i, name: `item${i}`, ok: true, price: 12.5, tags: ['a', 'b'], meta: { k: 'v\n"q"' } }));
        const text = JSON.stringify({ v: 1, data: items });
        const strict = median(() => parseStrictJson(text), 15);
        const plain = median(() => JSON.parse(text), 15);
        expect(strict / plain).toBeLessThan(5);
    });
});

/** What a parse answers: its value, or its error code and message. */
const answer = (parse: () => unknown) => {
    try {
        return { value: parse() };
    } catch (e) {
        if (e instanceof StrictJsonError) return { code: e.code, message: e.message };
        throw e;
    }
};

/** A deterministic PRNG, so a failing case reproduces. */
function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Random JSON text with the shapes a strict decoder must refuse: duplicate, escaped and reserved keys, deep nesting. */
function randomJson(r: () => number): string {
    const keys = ['a', 'b', 'id', 'type', '__proto__', '__pro\\u0074o__', 'a\\"b', '\\u0061', 'k\\\\', 'ä', '0', '1'];
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    let budget = 40;
    const value = (depth: number): string => {
        const roll = r();
        if (budget-- <= 0 || roll < 0.3) return pick(['1', '-0.5e3', 'true', 'false', 'null', '"x"', '"a\\\\"', '"q\\"q"', '""', '"\\u00e9"']);
        if (roll < 0.62) {
            const ws = pick(['', ' ', '\n\t']);
            return `[${ws}${Array.from({ length: Math.floor(r() * 4) }, () => value(depth + 1)).join(`,${ws}`)}${ws}]`;
        }
        const n = Math.floor(r() * (depth < 2 ? 20 : 4));
        return `{${Array.from({ length: n }, () => `${pick(['', ' '])}"${pick(keys)}"${pick(['', ' '])}:${value(depth + 1)}`).join(',')}}`;
    };
    // A chain of single-child containers around it reaches past the depth limit without growing wide.
    const chain = Math.floor(r() * 40);
    const opens = Array.from({ length: chain }, () => (r() < 0.5 ? ['[', ']'] : ['{"k":', '}']));
    return opens.map((o) => o[0]).join('') + value(0) + opens.map((o) => o[1]).reverse().join('');
}

/** Breaks valid text the ways a hostile or truncated frame does. */
function mutate(r: () => number, text: string): string {
    const at = Math.floor(r() * (text.length + 1));
    switch (Math.floor(r() * 5)) {
        case 0:
            return text.slice(0, at);
        case 1:
            return text.slice(0, at) + text.slice(at + 1);
        case 2:
            return text.slice(0, at) + '"' + text.slice(at);
        case 3:
            return text.slice(0, at) + '\\' + text.slice(at);
        default:
            return text + ' x';
    }
}

describe('parseStrictJson against the reference parser', () => {
    it('answers every frame as the reference parser does: the same value, or the same error and position', () => {
        const r = rng(20261117);
        for (let n = 0; n < 4_000; n++) {
            const valid = randomJson(r);
            for (const text of [valid, mutate(r, valid)]) {
                for (const depth of [32, 4]) expect([text, depth, answer(() => parseStrictJson(text, depth))]).toEqual([text, depth, answer(() => strictJsonByHand(text, depth))]);
            }
        }
    });

    it('refuses a duplicate key, also one spelled with an escape, and a reserved key at any depth', () => {
        expect(answer(() => parseStrictJson('{"a":1,"a":2}'))).toMatchObject({ code: 'duplicate_key' });
        expect(answer(() => parseStrictJson('{"a":1,"\\u0061":2}'))).toMatchObject({ code: 'duplicate_key' });
        expect(answer(() => parseStrictJson('[{"x":{"__pro\\u0074o__":{}}}]'))).toMatchObject({ code: 'invalid_json', message: expect.stringContaining('reserved key') });
        // The same key in sibling objects is no duplicate; a key-like string value is no key.
        expect(parseStrictJson('[{"a":1},{"a":"a","b":["a","a"]}]')).toEqual([{ a: 1 }, { a: 'a', b: ['a', 'a'] }]);
    });

    it('refuses nesting past the limit and keeps an empty container at the limit', () => {
        const nest = (n: number, inner: string) => '['.repeat(n) + inner + ']'.repeat(n);
        expect(parseStrictJson(nest(4, '[]'), 4)).toEqual([[[[[]]]]]);
        expect(answer(() => parseStrictJson(nest(5, '1'), 4))).toMatchObject({ code: 'too_deep' });
        expect(answer(() => parseStrictJson(nest(100_000, ''), 32))).toMatchObject({ code: 'too_deep' });
    });

    it('keeps a large key-heavy object whose keys are all distinct', () => {
        const big = Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, i]));
        expect(parseStrictJson(JSON.stringify(big))).toEqual(big);
        expect(answer(() => parseStrictJson(JSON.stringify(big).replace('"k4999"', '"k17"')))).toMatchObject({ code: 'duplicate_key' });
    });
});
