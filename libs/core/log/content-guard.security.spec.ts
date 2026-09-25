/**
 * deepSanitize customer-content conformance.
 *
 * Production incident (2026-09-25): the worker emitted log lines of 260,882
 * bytes carrying `existingCode` / `improvedCode` / `suggestionContent` —
 * customer source code from private repositories, at `level: info`, sitting in
 * CloudWatch for the log group's 14-day retention. 34 lines out of 3,000
 * accounted for 70% of all bytes ingested, and 31 of them exceeded
 * CloudWatch's 256KB per-event ceiling, so they arrived TRUNCATED: invalid
 * JSON that no parser could read.
 *
 * Customer code is not a secret — we are authorized to process it. We are not
 * authorized to retain it. A failing assertion here means code is reaching the
 * logs again, NOT a test to relax.
 *
 * jest.setup.ts globally mocks '@libs/core/log/logger', so pull the REAL pure
 * helpers via requireActual.
 */
const { deepSanitize } = jest.requireActual('@libs/core/log/logger') as {
    deepSanitize: (obj: any) => any;
};

const CODE = 'const apiKey = process.env.SECRET;\nreturn fetch(url);';

describe('deepSanitize — customer content is never stored', () => {
    it('omits every content-bearing field, whatever the casing', () => {
        const out = deepSanitize({
            existingCode: CODE,
            improvedCode: CODE,
            suggestionContent: CODE,
            llmPrompt: CODE,
            LLM_PROMPT: CODE,
            'existing-code': CODE,
        });
        for (const v of Object.values(out)) {
            expect(v).toMatch(/^\[content omitted: /);
        }
        expect(JSON.stringify(out)).not.toContain('apiKey');
    });

    it('keeps oneSentenceSummary — a model-written line, not customer code', () => {
        // Deliberately NOT in CONTENT_KEYS: it is the model's own one-liner
        // about a suggestion, and it is what makes a suggestion identifiable
        // when debugging. Omitting it costs observability and protects nothing.
        const out = deepSanitize({
            oneSentenceSummary: 'Use a parameterized query here',
            existingCode: CODE,
        });
        expect(out.oneSentenceSummary).toBe('Use a parameterized query here');
        expect(out.existingCode).toMatch(/^\[content omitted: /);
    });

    it('keeps the size signal so a fat suggestion is still debuggable', () => {
        const out = deepSanitize({ improvedCode: 'x'.repeat(4300) });
        expect(out.improvedCode).toBe('[content omitted: 4.2KB]');
    });

    it('omits content at any depth, inside arrays of suggestions', () => {
        const out = deepSanitize({
            validSuggestions: [
                { id: 'a1', relevantFile: 'src/app.ts', existingCode: CODE },
            ],
        });
        expect(out.validSuggestions[0].existingCode).toMatch(/^\[content omitted: /);
        // identifiers survive — they are what makes the log useful
        expect(out.validSuggestions[0].id).toBe('a1');
        expect(out.validSuggestions[0].relevantFile).toBe('src/app.ts');
    });

    it('does not confuse content with secrets', () => {
        const out = deepSanitize({ password: 'hunter2', improvedCode: CODE });
        expect(out.password).toBe('[REDACTED]');
        expect(out.improvedCode).toMatch(/^\[content omitted: /);
    });
});

describe('deepSanitize — size bounds catch the field nobody named', () => {
    it('truncates a long string under an innocent key', () => {
        const out = deepSanitize({ diff: 'y'.repeat(300_000) });
        expect(out.diff.length).toBeLessThan(5_000);
        expect(out.diff).toContain('[truncated: 293.0KB total]');
    });

    it('leaves a normal-sized string untouched', () => {
        const out = deepSanitize({ message: 'all good' });
        expect(out.message).toBe('all good');
    });

    it('caps a long array and says how many were dropped', () => {
        const out = deepSanitize({ items: Array.from({ length: 120 }, (_, i) => i) });
        expect(out.items).toHaveLength(51);
        expect(out.items[50]).toBe('[+70 more items omitted]');
    });

    it('keeps the whole log line under the CloudWatch ceiling — via the SIZE bounds, not the denylist', () => {
        // Deliberately NOT content-named: an earlier version of this test used
        // existingCode/improvedCode/llmPrompt, which the denylist omits
        // outright, so it passed without the size bounds doing any work.
        const suggestion = {
            id: 'x',
            relevantFile: 'src/a.ts',
            snippet: 'a'.repeat(50_000),
            patch: 'b'.repeat(50_000),
            context: 'c'.repeat(50_000),
        };
        const out = deepSanitize({
            items: Array.from({ length: 30 }, () => suggestion),
        });
        expect(JSON.stringify(out).length).toBeLessThan(262_144);
    });

    it('bounds the AGGREGATE: many fields each sitting exactly AT the per-value cap', () => {
        // 100 × 4096 chars serialized to ~410KB before the budget existed.
        const flat: Record<string, string> = {};
        for (let i = 0; i < 100; i++) flat[`field${i}`] = 'x'.repeat(4096);
        expect(JSON.stringify(deepSanitize(flat)).length).toBeLessThan(262_144);
    });

    it('bounds an object with an unreasonable number of small keys', () => {
        const wide: Record<string, string> = {};
        for (let i = 0; i < 50_000; i++) wide[`k${i}`] = 'v';
        expect(JSON.stringify(deepSanitize(wide)).length).toBeLessThan(262_144);
    });

    it('counts UTF-8 bytes, not UTF-16 code units', () => {
        // 4096 CJK chars are 12,288 bytes. Reporting "4.0KB" under-reports 3x.
        const out = deepSanitize({ note: '算'.repeat(5000) });
        expect(out.note).toContain('[truncated: 14.6KB total]');
    });

    it('bounds a deeply nested structure that stays under every per-value cap', () => {
        let nested: any = { leaf: 'z'.repeat(4000) };
        for (let i = 0; i < 20; i++) {
            nested = { pad: 'y'.repeat(4000), items: Array.from({ length: 40 }, () => nested) };
        }
        expect(JSON.stringify(deepSanitize(nested)).length).toBeLessThan(262_144);
    });
});

describe('deepSanitize — the guard must never throw', () => {
    it('survives a content key whose length getter throws', () => {
        const hostile = new Proxy([], {
            get(t, p) {
                if (p === 'length') throw new Error('boom');
                return (t as any)[p];
            },
        });
        const out = deepSanitize({ improvedCode: hostile });
        expect(out.improvedCode).toBe('[content omitted]');
    });

    it('survives a circular value under a content key', () => {
        const circular: any = { a: 1 };
        circular.self = circular;
        expect(() => deepSanitize({ existingCode: circular })).not.toThrow();
    });

    it('survives a BigInt under a content key', () => {
        expect(() => deepSanitize({ llmPrompt: { n: BigInt(9) } })).not.toThrow();
    });

    it('reports byte length for a typed array', () => {
        const out = deepSanitize({ improvedCode: new Uint8Array(2048) });
        expect(out.improvedCode).toBe('[content omitted: 2.0KB]');
    });
});

describe('deepSanitize — a throwing property getter must not escape', () => {
    it('survives a throwing getter on a content key', () => {
        const out = deepSanitize({
            get improvedCode(): string {
                throw new Error('boom');
            },
        });
        expect(out.improvedCode).toBe('[unreadable]');
    });

    it('survives a throwing getter on an ordinary key (pre-existing hazard)', () => {
        const out = deepSanitize({
            ok: 1,
            get anyField(): string {
                throw new Error('boom');
            },
        });
        expect(out.anyField).toBe('[unreadable]');
        expect(out.ok).toBe(1);
    });

    it('survives a throwing getter on a sensitive key', () => {
        const out = deepSanitize({
            get password(): string {
                throw new Error('boom');
            },
        });
        expect(out.password).toBe('[REDACTED]');
    });
});

describe('deepSanitize — every read is guarded, not just obj[key]', () => {
    const hostileArray = () =>
        new Proxy([], {
            get(t, p) {
                if (p === 'length') throw new Error('boom');
                return (t as any)[p];
            },
        });

    it('survives a hostile array under an ORDINARY key', () => {
        // Array.isArray() is true through a Proxy, so the array branch reads
        // .length and used to throw straight out of deepSanitize.
        const out = deepSanitize({ anyField: hostileArray() });
        expect(out.anyField).toBe('[unreadable]');
    });

    it('survives an element read that throws', () => {
        const hostile = new Proxy([1, 2, 3], {
            get(t, p) {
                if (p === '1') throw new Error('boom');
                return (t as any)[p];
            },
        });
        const out = deepSanitize({ items: hostile });
        expect(out.items[1]).toBe('[unreadable]');
        expect(out.items[0]).toBe(1);
    });
});

describe('deepSanitize — the budget bounds the LINE, not one call', () => {
    it('charges non-string primitives, so a numeric tree cannot escape', () => {
        // A tree of numbers paid only for its root key and serialized to 721KB.
        const nums: any = {};
        for (let i = 0; i < 30; i++) {
            nums[`m${i}`] = Array.from({ length: 40 }, () =>
                Array.from({ length: 40 }, (_, j) => j * 1.23456789),
            );
        }
        // The guarantee is about the emitted LINE, which carries this object
        // up to MAX_LINE_COPIES times. The budget is checked before a value is
        // processed, so a bounded overshoot past it is expected by design.
        expect(JSON.stringify(deepSanitize(nums)).length * 3).toBeLessThan(262_144);
    });

    it('charges key names on the sensitive and content branches too', () => {
        // isSensitiveName strips every non-[a-z0-9] char, so these thousands of
        // distinct raw keys all normalize to "password" and each emitted
        // "key":"[REDACTED]" used to cost the budget nothing.
        const k: any = {};
        for (let i = 0; i < 50_000; i++) k[`password${'.'.repeat(i % 3)}${i}`] = 'x';
        expect(JSON.stringify(deepSanitize(k)).length * 3).toBeLessThan(262_144);
    });

    it('leaves room for the copies buildLogObject makes of the same object', () => {
        // The line carries it spread at top level, again under `metadata`, and
        // possibly a third time via the pino `err` serializer's own budget.
        const flat: Record<string, string> = {};
        for (let i = 0; i < 200; i++) flat[`field${i}`] = 'x'.repeat(4096);
        const once = JSON.stringify(deepSanitize(flat)).length;
        expect(once * 3).toBeLessThan(262_144);
    });
});

describe('deepSanitize — an exhausted budget must not evict small trailing keys', () => {
    const fatMetadata = () => {
        const m: Record<string, string> = {};
        for (let i = 0; i < 20; i++) m[`f${i}`] = 'x'.repeat(4000);
        return m;
    };

    it('keeps createdAt, which the collection TTL index is built on', () => {
        // Key order used to decide survival, and createdAt is the LAST key of
        // the exporter's log document — so it was dropped and the document
        // never expired, inverting the retention this guard enforces.
        const createdAt = new Date();
        const out = deepSanitize({
            timestamp: new Date(),
            level: 'info',
            message: 'm',
            metadata: fatMetadata(),
            attributes: { a: 1 },
            createdAt,
        });
        expect(out.createdAt).toBe(createdAt);
    });

    it('keeps tu, which startSpan appends last and credits metering reads', () => {
        const attributes: Record<string, string> = {};
        for (let i = 0; i < 20; i++) attributes[`a${i}`] = 'y'.repeat(4000);
        const out = deepSanitize({ name: 's', attributes, tu: { credits: 42 } });
        expect(out.tu).toEqual({ credits: 42 });
    });

    it('still collapses the heavy values that spent the budget', () => {
        const out = deepSanitize({ metadata: fatMetadata(), big: fatMetadata(), id: 'x' });
        expect(out.id).toBe('x');
        expect(out.big).toBe('[budget spent]');
    });

    it('still bounds an object with tens of thousands of keys', () => {
        const wide: Record<string, string> = { head: 'z'.repeat(70_000) };
        for (let i = 0; i < 50_000; i++) wide[`k${i}`] = 'v';
        // The guarantee is the byte bound, not a key count: 50,000 keys of
        // ~10 bytes each take ~6,300 keys to spend the budget, and only then
        // does KEY_TAIL_ALLOWANCE cap what follows.
        const out = deepSanitize(wide);
        expect(JSON.stringify(out).length * 3).toBeLessThan(262_144);
        expect(JSON.stringify(out)).toContain('more keys omitted');
    });
});

describe('deepSanitize — redaction survives budget exhaustion', () => {
    // The gap every earlier test missed: none combined an exhausted budget
    // with a secret. An earlier version emitted "cheap" tail values raw, and
    // past exhaustion it leaked everything the normal path redacts.
    const fat = () => {
        const m: Record<string, string> = {};
        for (let i = 0; i < 20; i++) m[`f${i}`] = 'x'.repeat(4000);
        return m;
    };

    it('redacts credentials embedded in a trailing string', () => {
        const out = JSON.stringify(
            deepSanitize({
                metadata: fat(),
                dbUrl: 'mongodb://admin:hunter2@db.internal/app',
            }),
        );
        expect(out).not.toContain('hunter2');
    });

    it('redacts an Authorization header in a trailing string', () => {
        const out = JSON.stringify(
            deepSanitize({
                metadata: fat(),
                header: 'Authorization: Bearer sk-live-SECRET123',
            }),
        );
        expect(out).not.toContain('SECRET123');
    });

    it('redacts sensitive keys nested in a trailing flat object', () => {
        const out = deepSanitize({
            metadata: fat(),
            creds: { token: 'tok-SECRET', password: 'pw-SECRET', user: 'bob' },
        });
        expect(JSON.stringify(out)).not.toContain('SECRET');
        expect(out.creds.user).toBe('bob');
    });

    it('omits customer code nested in a trailing flat object', () => {
        const out = deepSanitize({
            metadata: fat(),
            s: { improvedCode: 'const k = 1;', id: 'x' },
        });
        expect(out.s.improvedCode).toMatch(/^\[content omitted: /);
        expect(out.s.id).toBe('x');
    });
});

describe('deepSanitize — the tail is bounded in bytes, not just in keys', () => {
    it('cannot blow the line with many cheap flat objects', () => {
        // 100 trailing keys x flat 12x256-char objects produced a 1.1MB line.
        const b: Record<string, any> = {};
        const m: Record<string, string> = {};
        for (let i = 0; i < 20; i++) m[`f${i}`] = 'x'.repeat(4000);
        b.metadata = m;
        for (let i = 0; i < 100; i++) {
            const o: Record<string, string> = {};
            for (let j = 0; j < 12; j++) o[`k${j}`] = 'z'.repeat(256);
            b[`t${i}`] = o;
        }
        expect(JSON.stringify(deepSanitize(b)).length * 3).toBeLessThan(262_144);
    });

    it('shares one tail allowance across nested objects', () => {
        // `child` MUST come first. An earlier version of this test put it last,
        // so once the budget was spent the child collapsed to a marker and no
        // nested tail was ever processed — the test passed against code that
        // had no byte cap on the tail at all. With child first, every level
        // returns into its own tail of cheap strings after exhaustion, which is
        // exactly where a per-object (unshared) allowance would multiply.
        const nest = (d: number): any => {
            const o: Record<string, any> = {};
            if (d > 0) o.child = nest(d - 1);
            const m: Record<string, string> = {};
            for (let i = 0; i < 20; i++) m[`f${i}`] = 'x'.repeat(4000);
            o.fat = m;
            for (let i = 0; i < 100; i++) o[`s${i}`] = 's'.repeat(256);
            return o;
        };
        expect(JSON.stringify(deepSanitize(nest(20))).length * 3).toBeLessThan(262_144);
    });
});

describe('deepSanitize — the tail never enumerates large values', () => {
    const fat = () => {
        const m: Record<string, string> = {};
        for (let i = 0; i < 20; i++) m[`f${i}`] = 'x'.repeat(4000);
        return m;
    };

    it('rejects a Buffer without walking its bytes', () => {
        // Object.keys() on a 1MB Buffer built a million index strings (~53ms).
        const buf = Buffer.alloc(1024 * 1024);
        const t0 = Date.now();
        const out = deepSanitize({ metadata: fat(), payload: buf });
        expect(Date.now() - t0).toBeLessThan(20);
        expect(out.payload).toBe('[budget spent]');
    });

});
