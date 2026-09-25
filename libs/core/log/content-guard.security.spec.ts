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
            oneSentenceSummary: CODE,
            LLM_PROMPT: CODE,
            'existing-code': CODE,
        });
        for (const v of Object.values(out)) {
            expect(v).toMatch(/^\[content omitted: /);
        }
        expect(JSON.stringify(out)).not.toContain('apiKey');
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

    it('keeps the whole log line well under the CloudWatch 256KB ceiling', () => {
        const suggestion = {
            id: 'x',
            relevantFile: 'src/a.ts',
            existingCode: 'a'.repeat(50_000),
            improvedCode: 'b'.repeat(50_000),
            llmPrompt: 'c'.repeat(50_000),
        };
        const out = deepSanitize({
            validSuggestions: Array.from({ length: 30 }, () => suggestion),
        });
        expect(JSON.stringify(out).length).toBeLessThan(262_144);
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
