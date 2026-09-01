import {
    jsonSchema,
    NoObjectGeneratedError,
    JSONParseError,
    TypeValidationError,
} from 'ai';
import {
    ajvValidator,
    ensureValidatingSchema,
    extractJsonFromText,
    readOutput,
    repairAndValidate,
    repairJsonText,
    salvageStructuredError,
} from './structured-output-repair';

describe('repairJsonText', () => {
    it('unwraps a ```json markdown fence', () => {
        const out = repairJsonText('```json\n{"a":1}\n```');
        expect(out).toBe('{"a":1}');
        expect(JSON.parse(out!)).toEqual({ a: 1 });
    });

    it('unwraps a bare ``` fence', () => {
        expect(repairJsonText('```\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('slices the object out of surrounding prose', () => {
        const out = repairJsonText('Here is the result: {"a":1,"b":2} — done.');
        expect(JSON.parse(out!)).toEqual({ a: 1, b: 2 });
    });

    it('handles braces inside string values without truncating', () => {
        const out = repairJsonText('noise {"msg":"a } b","n":1} tail');
        expect(JSON.parse(out!)).toEqual({ msg: 'a } b', n: 1 });
    });

    it('extracts a top-level array', () => {
        const out = repairJsonText('```json\n[{"a":1},{"a":2}]\n```');
        expect(JSON.parse(out!)).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it('removes trailing commas', () => {
        const out = repairJsonText('prefix {"a":1,"b":[1,2,],} ');
        expect(JSON.parse(out!)).toEqual({ a: 1, b: [1, 2] });
    });

    it('returns null for already-clean JSON (nothing to repair)', () => {
        // Identical input means the SDK already failed on this exact text for a
        // reason string surgery cannot fix — escalate instead of looping.
        expect(repairJsonText('{"a":1}')).toBeNull();
    });

    it('returns null when the result is still not JSON', () => {
        expect(repairJsonText('not json at all')).toBeNull();
        expect(repairJsonText('```json\nstill not json\n```')).toBeNull();
    });

    it('returns null for empty / blank input', () => {
        expect(repairJsonText('')).toBeNull();
        expect(repairJsonText('   ')).toBeNull();
        expect(repairJsonText(undefined as any)).toBeNull();
    });
});

describe('extractJsonFromText', () => {
    it('extracts even when the text is ALREADY clean JSON (unlike repairJsonText)', () => {
        // The key difference: repairJsonText returns null for clean input; the
        // extractor returns the JSON so callers that always need the substring work.
        expect(extractJsonFromText('{"a":1}')).toBe('{"a":1}');
        expect(repairJsonText('{"a":1}')).toBeNull();
    });

    it('unwraps a fence, prose, and trailing commas', () => {
        expect(extractJsonFromText('```json\n{"a":1}\n```')).toBe('{"a":1}');
        expect(
            JSON.parse(extractJsonFromText('note: {"a":1,"b":2} end')!),
        ).toEqual({ a: 1, b: 2 });
        expect(extractJsonFromText('{"a":1,}')).toBe('{"a":1}');
    });

    it('is string-aware (braces inside strings do not truncate)', () => {
        expect(
            JSON.parse(extractJsonFromText('x {"msg":"a } b"} y')!),
        ).toEqual({ msg: 'a } b' });
    });

    it('extracts a top-level array', () => {
        expect(extractJsonFromText('[{"a":1}]')).toBe('[{"a":1}]');
    });

    it('returns null when there is no JSON delimiter', () => {
        expect(extractJsonFromText('just prose')).toBeNull();
        expect(extractJsonFromText('```\nstill prose\n```')).toBeNull();
        expect(extractJsonFromText('')).toBeNull();
    });
});

describe('ajvValidator', () => {
    const schema = {
        type: 'object',
        properties: { keep: { type: 'number' } },
        required: ['keep'],
        additionalProperties: false,
    };

    it('accepts a conforming object', () => {
        const validate = ajvValidator(schema)!;
        const r = validate({ keep: 1 });
        expect(r.success).toBe(true);
        if (r.success) expect(r.value).toEqual({ keep: 1 });
    });

    it('rejects a missing required key with a TypeValidationError', () => {
        const validate = ajvValidator(schema)!;
        const r = validate({ nope: 1 });
        expect(r.success).toBe(false);
        if ('error' in r) expect(r.error.name).toMatch(/TypeValidationError/);
    });

    it('rejects an extra key when additionalProperties is false', () => {
        const validate = ajvValidator(schema)!;
        expect(validate({ keep: 1, extra: 2 }).success).toBe(false);
    });

    it('returns null (fail-soft) for an uncompilable schema', () => {
        expect(ajvValidator({ type: 'not-a-real-type' } as any)).toBeNull();
    });
});

describe('ensureValidatingSchema', () => {
    it('attaches a validator to a raw jsonSchema() that had none', async () => {
        const raw = jsonSchema({
            type: 'object',
            properties: { keep: { type: 'number' } },
            required: ['keep'],
            additionalProperties: false,
        } as any);
        // A raw jsonSchema() has no validate fn → shape mismatch would slip through.
        expect(typeof (raw as any).validate).not.toBe('function');

        const guarded = ensureValidatingSchema(raw) as any;
        expect(typeof guarded.validate).toBe('function');
        expect((await guarded.validate({ keep: 1 })).success).toBe(true);
        expect((await guarded.validate({ wrong: 1 })).success).toBe(false);
    });

    it('leaves a schema that already validates untouched', () => {
        const withValidate = jsonSchema(
            { type: 'object' } as any,
            { validate: (v) => ({ success: true, value: v }) },
        );
        expect(ensureValidatingSchema(withValidate)).toBe(withValidate);
    });

    it('is fail-soft for a non-schema input', () => {
        expect(ensureValidatingSchema(null)).toBeNull();
        expect(ensureValidatingSchema(undefined)).toBeUndefined();
    });
});

describe('repairAndValidate', () => {
    const wire = jsonSchema({
        type: 'object',
        properties: { keep: { type: 'number' } },
        required: ['keep'],
        additionalProperties: false,
    } as any);
    const guarded = ensureValidatingSchema(wire);

    it('repairs a fenced object AND validates it against the schema', async () => {
        const v = await repairAndValidate(guarded, '```json\n{"keep":7}\n```');
        expect(v).toEqual({ keep: 7 });
    });

    it('validates ALREADY-CLEAN JSON with no fence or trailing whitespace', async () => {
        // The reroute-json path (always-thinking models — Kimi k2.7-code/k3,
        // Claude Fable/Mythos) hands the model's RAW text straight here. When the
        // model nails the format (pristine JSON, no fence, no trailing newline)
        // the parse MUST succeed. Regression for the Kimi kody-rules
        // "reroute-json produced no valid object" failure: the old repairJsonText
        // returned null for unchanged input ("nothing to repair"), so clean output
        // was wrongly rejected. See PR#152 in the incident logs.
        expect(await repairAndValidate(guarded, '{"keep":7}')).toEqual({
            keep: 7,
        });
    });

    it('accepts a valid but EMPTY-collection result (not a failure)', async () => {
        const listWire = ensureValidatingSchema(
            jsonSchema({
                type: 'object',
                properties: {
                    violations: { type: 'array', items: { type: 'object' } },
                },
                required: ['violations'],
                additionalProperties: false,
            } as any),
        );
        // "No violations found" is a legitimate answer — the exact shard payload
        // Kimi returned on PR#152. It must parse, never degrade the shard to error.
        expect(await repairAndValidate(listWire, '{"violations":[]}')).toEqual({
            violations: [],
        });
    });

    it('returns undefined when repaired JSON has the wrong shape', async () => {
        // Deterministic repair fixes the fence, but the shape is wrong → the
        // executor must escalate to a model re-ask, not accept bad data.
        const v = await repairAndValidate(guarded, '```json\n{"nope":7}\n```');
        expect(v).toBeUndefined();
    });

    it('returns undefined when nothing is repairable', async () => {
        expect(await repairAndValidate(guarded, 'not json')).toBeUndefined();
    });
});

describe('readOutput', () => {
    it('reads ai@7 `output`', () => {
        expect(readOutput({ output: { a: 1 } })).toEqual({ a: 1 });
    });
    it('prefers ai@6 `experimental_output` when present', () => {
        expect(
            readOutput({ experimental_output: { a: 1 }, output: { a: 2 } }),
        ).toEqual({ a: 1 });
    });
    it('returns undefined for an empty/absent result', () => {
        expect(readOutput({})).toBeUndefined();
        expect(readOutput(undefined)).toBeUndefined();
    });
});

describe('salvageStructuredError', () => {
    const wire = ensureValidatingSchema(
        jsonSchema({
            type: 'object',
            properties: { keep: { type: 'number' } },
            required: ['keep'],
            additionalProperties: false,
        } as any),
    );
    const noObjectError = (cause: Error, text: string) =>
        new NoObjectGeneratedError({
            message: 'No object generated (test)',
            cause,
            text,
            response: {} as any,
            usage: {} as any,
            finishReason: 'stop',
        });

    it('salvages a JSON PARSE error whose text repairs + validates', async () => {
        const text = '```json\n{"keep":9}\n```';
        const err = noObjectError(
            new JSONParseError({ text, cause: new Error('fence') }),
            text,
        );
        expect(await salvageStructuredError(err, wire)).toEqual({ keep: 9 });
    });

    it('does NOT salvage a shape mismatch (TypeValidationError cause)', async () => {
        const err = noObjectError(
            new TypeValidationError({
                value: { wrong: 1 },
                cause: new Error('shape'),
            }),
            '{"wrong":1}',
        );
        expect(await salvageStructuredError(err, wire)).toBeUndefined();
    });

    it('does NOT salvage a parse error whose repaired text is the wrong shape', async () => {
        const text = '```json\n{"wrong":9}\n```';
        const err = noObjectError(
            new JSONParseError({ text, cause: new Error('fence') }),
            text,
        );
        expect(await salvageStructuredError(err, wire)).toBeUndefined();
    });

    it('returns undefined for a non-NoObjectGeneratedError', async () => {
        expect(
            await salvageStructuredError(new Error('network'), wire),
        ).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Mutation-killing edge cases: pin branch boundaries, exact literals, `??` vs
// `||` defaults, fail-soft reference identity, and string-aware slicing that
// the happy-path tests above do not distinguish.
// ---------------------------------------------------------------------------
describe('structured-output-repair — mutation killers', () => {
    describe('ajvValidator', () => {
        const schema = {
            type: 'object',
            properties: { keep: { type: 'number' } },
            required: ['keep'],
            additionalProperties: false,
        };

        it('returns the exact input value on success (not a copy/other)', () => {
            const validate = ajvValidator(schema)!;
            const input = { keep: 42 };
            const r = validate(input);
            expect(r).toEqual({ success: true, value: input });
            // Pins that `value` is the validated object itself, byte-for-byte.
            if (r.success) expect(r.value).toBe(input);
        });

        it('encodes the detail with the "/" instancePath default for a missing required key', () => {
            // Kills `instancePath || "/"` → the empty instancePath must render as
            // "/", and the "schema validation failed: " literal prefix must survive.
            const validate = ajvValidator(schema)!;
            const r = validate({});
            expect(r.success).toBe(false);
            if (!r.success) {
                expect((r as any).error.cause.message).toBe(
                    "schema validation failed: / must have required property 'keep'",
                );
            }
        });

        it('encodes a non-empty instancePath for a nested type mismatch', () => {
            // The complement of the "/" case: a property-level error keeps its
            // real instancePath ("/keep"), so the `|| "/"` default does NOT apply.
            const validate = ajvValidator(schema)!;
            const r = validate({ keep: 'not-a-number' });
            expect(r.success).toBe(false);
            if (!r.success) {
                expect((r as any).error.cause.message).toBe(
                    'schema validation failed: /keep must be number',
                );
            }
        });
    });

    describe('ensureValidatingSchema', () => {
        it('returns a primitive input unchanged (typeof object guard)', () => {
            // Kills the `!wire || typeof wire !== "object"` guard both ways.
            expect(ensureValidatingSchema('not-an-object')).toBe('not-an-object');
            expect(ensureValidatingSchema(42)).toBe(42);
            expect(ensureValidatingSchema(0)).toBe(0);
        });

        it('returns an object with NO jsonSchema body untouched (same reference)', () => {
            const o = { foo: 1 };
            expect(ensureValidatingSchema(o)).toBe(o);
        });

        it('returns an object whose jsonSchema is not an object untouched (same reference)', () => {
            // Kills the `typeof s.jsonSchema !== "object"` branch: a string body
            // must NOT be handed to ajv.
            const o = { jsonSchema: 'nope' };
            expect(ensureValidatingSchema(o)).toBe(o);
        });

        it('returns the wire untouched (same reference) when ajv cannot compile the body', () => {
            // Kills the `if (!validate) return wire` fail-soft: an uncompilable
            // body must yield the ORIGINAL object, never a freshly-wrapped one.
            const o = { jsonSchema: { type: 'not-a-real-type' } };
            expect(ensureValidatingSchema(o)).toBe(o);
        });
    });

    describe('extractJsonFromText', () => {
        it('returns null for non-string inputs (typeof guard)', () => {
            expect(extractJsonFromText(null as any)).toBeNull();
            expect(extractJsonFromText(123 as any)).toBeNull();
            expect(extractJsonFromText({} as any)).toBeNull();
        });

        it('passes through an UNBALANCED object as-is (slice returns null, delimiter test still true)', () => {
            // slice cannot balance `{"a":1`, so the trimmed text survives and the
            // final /^[{[]/ test keeps it. Pins that extraction is NOT a parse.
            expect(extractJsonFromText('{"a":1')).toBe('{"a":1');
        });

        it('trims surrounding whitespace off already-clean JSON', () => {
            // Kills a dropped `.trim()`: the returned substring must be tight.
            expect(extractJsonFromText('  {"a":1}  ')).toBe('{"a":1}');
        });

        it('unwraps an UPPERCASE ```JSON fence (case-insensitive flag)', () => {
            expect(extractJsonFromText('```JSON\n{"a":1}\n```')).toBe('{"a":1}');
        });

        it('slices a top-level array whose string values contain the object close-brace', () => {
            // Exercises open/close derived from the FIRST delimiter ("[" → "]"),
            // ignoring the inner "{"/"}" and the "}" living inside a string.
            expect(extractJsonFromText('pre [{"x":"}"}] post')).toBe(
                '[{"x":"}"}]',
            );
        });

        it('is escape-aware: an escaped quote inside a string does not end the string early', () => {
            // Without escape handling the slice would fail and the prose-wrapped
            // input would be rejected. Correct handling returns the tight object.
            expect(extractJsonFromText('noise {"msg":"a \\" b"} tail')).toBe(
                '{"msg":"a \\" b"}',
            );
        });
    });

    describe('repairJsonText', () => {
        it('repairs whitespace-padded clean JSON (differs from input → not the null-on-unchanged case)', () => {
            // The trimmed candidate `{"a":1}` !== `  {"a":1}  `, so unlike the
            // already-clean case it is returned. Pins the `=== text` comparison.
            expect(repairJsonText('  {"a":1}  ')).toBe('{"a":1}');
        });

        it('returns null when the extracted candidate is non-null but does not parse', () => {
            // `{"a":1` survives extraction (delimiter present) but JSON.parse
            // throws → the try/catch must yield null, not the raw substring.
            expect(repairJsonText('{"a":1')).toBeNull();
        });
    });

    describe('repairAndValidate', () => {
        it('returns the parsed value UNVALIDATED when the wire has no validate fn', async () => {
            // Kills the `typeof schema.validate !== "function"` branch: a raw
            // jsonSchema() (no validator) must let a wrong-shape object through.
            const raw = jsonSchema({
                type: 'object',
                properties: { keep: { type: 'number' } },
                required: ['keep'],
            } as any);
            expect(typeof (raw as any).validate).not.toBe('function');
            expect(await repairAndValidate(raw, '{"wrong":1}')).toEqual({
                wrong: 1,
            });
        });

        it('returns undefined when a non-null candidate fails to parse', async () => {
            // `{"a":1` extracts non-null then throws in JSON.parse → the
            // try/catch must return undefined (distinct from the null-candidate path).
            const guarded = ensureValidatingSchema(
                jsonSchema({
                    type: 'object',
                    properties: { keep: { type: 'number' } },
                    required: ['keep'],
                    additionalProperties: false,
                } as any),
            );
            expect(await repairAndValidate(guarded, '{"a":1')).toBeUndefined();
        });
    });

    describe('readOutput', () => {
        it('returns a falsy-but-defined experimental_output (?? not ||)', () => {
            // `0 ?? 5` is 0; a `||` mutant would wrongly return 5.
            expect(readOutput({ experimental_output: 0, output: 5 })).toBe(0);
            expect(
                readOutput({ experimental_output: false, output: { a: 1 } }),
            ).toBe(false);
        });

        it('falls through to output when experimental_output is null/undefined', () => {
            expect(readOutput({ experimental_output: null, output: 9 })).toBe(9);
            expect(readOutput({ output: 0 })).toBe(0);
        });
    });

    describe('salvageStructuredError', () => {
        const wire = ensureValidatingSchema(
            jsonSchema({
                type: 'object',
                properties: { keep: { type: 'number' } },
                required: ['keep'],
                additionalProperties: false,
            } as any),
        );
        const noObjectError = (cause: Error, text: unknown) =>
            new NoObjectGeneratedError({
                message: 'No object generated (test)',
                cause,
                text: text as any,
                response: {} as any,
                usage: {} as any,
                finishReason: 'stop',
            });

        it('does NOT salvage when the parse-error text is not a string', async () => {
            // Kills the `typeof text !== "string"` guard: a JSONParseError cause
            // with a non-string text must short-circuit to undefined.
            const err = noObjectError(
                new JSONParseError({ text: 'x', cause: new Error('parse') }),
                undefined,
            );
            expect(await salvageStructuredError(err, wire)).toBeUndefined();
        });
    });
});
