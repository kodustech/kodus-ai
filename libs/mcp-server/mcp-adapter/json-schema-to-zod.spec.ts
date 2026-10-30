import { z } from 'zod';

import { jsonSchemaToZod } from './json-schema-to-zod';

/**
 * Mutation-killing tests for the deterministic JSON-Schema -> Zod converter.
 *
 * All three deterministic functions are reached through the single exported
 * entry point `jsonSchemaToZod`:
 *   - jsonSchemaToZod       (top-level dispatch)
 *   - jsonSchemaPropertyToZod ("convertProperty" — reached via `properties`)
 *   - jsonSchemaTypeToZod     ("convertPrimitive" — reached via a `type` schema
 *                              or via a property that carries a `type`)
 *
 * We assert on the RUNTIME BEHAVIOUR of the produced Zod schema (safeParse
 * success/failure and, where relevant, the preserved `.description`) because a
 * plausible bug in the conversion changes exactly those observable outcomes.
 */
describe('jsonSchemaToZod', () => {
    // Convenience: build the schema and report whether `value` validates.
    const accepts = (schema: unknown, value: unknown): boolean =>
        jsonSchemaToZod(schema).safeParse(value).success;

    describe('top-level dispatch (jsonSchemaToZod)', () => {
        it('returns z.any() for null / non-object inputs (accepts everything)', () => {
            // A mutant that returned z.string()/z.never() here would reject
            // numbers, objects or strings — assert all three pass.
            for (const input of [null, undefined, 42, 'a string', true]) {
                expect(accepts(input, 123)).toBe(true);
                expect(accepts(input, 'hello')).toBe(true);
                expect(accepts(input, { any: 'thing' })).toBe(true);
            }
        });

        it('builds an object schema honouring the required list', () => {
            const schema = {
                properties: {
                    a: { type: 'string' },
                    b: { type: 'number' },
                },
                required: ['a'],
            };

            // required 'a' present, optional 'b' omitted -> valid
            expect(accepts(schema, { a: 'x' })).toBe(true);
            // required 'a' missing -> invalid (kills "required is ignored")
            expect(accepts(schema, { b: 1 })).toBe(false);
            // optional 'b' present but wrong type -> invalid
            expect(accepts(schema, { a: 'x', b: 'not-a-number' })).toBe(false);
        });

        it('treats every property as optional when `required` is absent (|| [] default)', () => {
            // With no `required` key, `required.includes` would throw if the
            // `|| []` default were dropped; an empty object must validate.
            const schema = { properties: { a: { type: 'string' } } };
            expect(accepts(schema, {})).toBe(true);
            expect(accepts(schema, { a: 'x' })).toBe(true);
            // present-but-wrong-type still rejected
            expect(accepts(schema, { a: 1 })).toBe(false);
        });

        it('ignores a non-object `properties` value (typeof guard) and falls back to z.any()', () => {
            // properties is truthy but not an object -> guard skips the object
            // branch; with no `type` it lands on the z.any() fallback, which
            // accepts a bare number. A mutant dropping the typeof guard would
            // build an object schema and reject the number.
            expect(accepts({ properties: 'not-an-object' }, 123)).toBe(true);
        });

        it('dispatches to type conversion when only `type` is present', () => {
            expect(accepts({ type: 'string' }, 'ok')).toBe(true);
            expect(accepts({ type: 'string' }, 123)).toBe(false);
        });

        it('falls back to z.any() for a schema with neither type nor properties', () => {
            expect(accepts({ description: 'lonely' }, 123)).toBe(true);
            expect(accepts({ description: 'lonely' }, { x: 1 })).toBe(true);
        });
    });

    describe('convertProperty (jsonSchemaPropertyToZod, via `properties`)', () => {
        // Build an object schema with a single REQUIRED property so the inner
        // schema is not wrapped in .optional() (which would drop .description),
        // then reach the property's schema via `.shape[key]`.
        const propSchema = (prop: unknown): z.ZodTypeAny => {
            const built = jsonSchemaToZod({
                properties: { field: prop },
                required: ['field'],
            }) as z.ZodObject<any>;
            return built.shape.field as z.ZodTypeAny;
        };

        it('converts a typed property and preserves its description', () => {
            const p = propSchema({ type: 'number', description: 'a count' });
            expect(p.description).toBe('a count');
            expect(p.safeParse(5).success).toBe(true);
            expect(p.safeParse('x').success).toBe(false);
        });

        it('converts a string-valued enum property to z.enum', () => {
            const p = propSchema({ enum: ['red', 'green'] });
            expect(p.safeParse('red').success).toBe(true);
            expect(p.safeParse('green').success).toBe(true);
            expect(p.safeParse('blue').success).toBe(false);
            // not one of the members and not even a listed value -> rejected
            expect(p.safeParse(1).success).toBe(false);
        });

        it('preserves description on an enum property', () => {
            const p = propSchema({ enum: ['a', 'b'], description: 'pick one' });
            expect(p.description).toBe('pick one');
        });

        it('converts a numeric enum property to a union of number literals', () => {
            const p = propSchema({ enum: [1, 2, 3] });
            expect(p.safeParse(1).success).toBe(true);
            expect(p.safeParse(3).success).toBe(true);
            expect(p.safeParse(4).success).toBe(false);
            // a string is not one of the numeric literals
            expect(p.safeParse('1').success).toBe(false);
        });

        it('falls back to z.any() for a mixed-type enum property', () => {
            // every-string is false AND every-number is false -> z.any(),
            // which accepts a value that is in NEITHER branch's members.
            const p = propSchema({ enum: [1, 'a'] });
            expect(p.safeParse(true).success).toBe(true);
            expect(p.safeParse(999).success).toBe(true);
            expect(p.safeParse('anything').success).toBe(true);
        });

        it('converts oneOf with >= 2 options to a discriminating union', () => {
            const p = propSchema({
                oneOf: [{ type: 'string' }, { type: 'number' }],
            });
            expect(p.safeParse('s').success).toBe(true);
            expect(p.safeParse(7).success).toBe(true);
            // boolean matches neither option
            expect(p.safeParse(true).success).toBe(false);
        });

        it('does NOT build a union for oneOf with a single option (boundary: length >= 2)', () => {
            // length 1 fails the `>= 2` guard, so it falls through to the
            // z.any() fallback which accepts a value the lone option rejects.
            const p = propSchema({ oneOf: [{ type: 'string' }] });
            expect(p.safeParse(12345).success).toBe(true);
        });

        it('converts anyOf with >= 2 options to a union', () => {
            const p = propSchema({
                anyOf: [{ type: 'boolean' }, { type: 'number' }],
            });
            expect(p.safeParse(true).success).toBe(true);
            expect(p.safeParse(3).success).toBe(true);
            expect(p.safeParse('nope').success).toBe(false);
        });

        it('does NOT build a union for anyOf with a single option (boundary: length >= 2)', () => {
            const p = propSchema({ anyOf: [{ type: 'number' }] });
            expect(p.safeParse('a string').success).toBe(true);
        });

        it('falls back to z.any() and preserves description for an untyped/plain property', () => {
            const p = propSchema({ description: 'freeform' });
            expect(p.description).toBe('freeform');
            expect(p.safeParse(123).success).toBe(true);
            expect(p.safeParse({ nested: true }).success).toBe(true);
        });
    });

    describe('convertPrimitive (jsonSchemaTypeToZod, via a typed schema)', () => {
        describe('string', () => {
            it('accepts strings and rejects non-strings', () => {
                expect(accepts({ type: 'string' }, 'hi')).toBe(true);
                expect(accepts({ type: 'string' }, 123)).toBe(false);
            });

            it('uses z.enum when the string schema carries an all-string enum', () => {
                const s = { type: 'string', enum: ['on', 'off'] };
                expect(accepts(s, 'on')).toBe(true);
                expect(accepts(s, 'off')).toBe(true);
                expect(accepts(s, 'maybe')).toBe(false);
            });

            it('falls back to plain z.string() when the enum is not all-strings', () => {
                const s = { type: 'string', enum: ['on', 1] };
                // any string is accepted (NOT restricted to the enum members)
                expect(accepts(s, 'off')).toBe(true);
                expect(accepts(s, 'on')).toBe(true);
                // still a string type, so a number is rejected
                expect(accepts(s, 1)).toBe(false);
            });

            it('enforces minLength at the boundary', () => {
                const s = { type: 'string', minLength: 3 };
                expect(accepts(s, 'ab')).toBe(false); // 2 < 3
                expect(accepts(s, 'abc')).toBe(true); // 3 == 3
            });

            it('enforces maxLength at the boundary', () => {
                const s = { type: 'string', maxLength: 3 };
                expect(accepts(s, 'abc')).toBe(true); // 3 == 3
                expect(accepts(s, 'abcd')).toBe(false); // 4 > 3
            });

            it('enforces a regex pattern', () => {
                const s = { type: 'string', pattern: '^a+$' };
                expect(accepts(s, 'aaa')).toBe(true);
                expect(accepts(s, 'aba')).toBe(false);
            });

            it('enforces the uri format', () => {
                const s = { type: 'string', format: 'uri' };
                expect(accepts(s, 'https://example.com')).toBe(true);
                expect(accepts(s, 'not a url')).toBe(false);
            });

            it('enforces the email format', () => {
                const s = { type: 'string', format: 'email' };
                expect(accepts(s, 'a@b.com')).toBe(true);
                expect(accepts(s, 'nope')).toBe(false);
            });

            it('enforces the date format', () => {
                const s = { type: 'string', format: 'date' };
                expect(accepts(s, '2020-01-01')).toBe(true);
                expect(accepts(s, 'nope')).toBe(false);
            });

            it('enforces the uuid format', () => {
                const s = { type: 'string', format: 'uuid' };
                expect(accepts(s, '123e4567-e89b-12d3-a456-426614174000')).toBe(
                    true,
                );
                expect(accepts(s, 'not-a-uuid')).toBe(false);
            });

            it('enforces the time format via regex', () => {
                const s = { type: 'string', format: 'time' };
                expect(accepts(s, '13:45:00')).toBe(true);
                expect(accepts(s, '99:00:00')).toBe(false);
            });

            it('enforces the ipv4 format via regex', () => {
                const s = { type: 'string', format: 'ipv4' };
                expect(accepts(s, '192.168.0.1')).toBe(true);
                expect(accepts(s, '999.1.1.1')).toBe(false);
            });

            it('enforces the ipv6 format via regex', () => {
                const s = { type: 'string', format: 'ipv6' };
                expect(accepts(s, '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(
                    true,
                );
                expect(accepts(s, 'not-ipv6')).toBe(false);
            });
        });

        describe('number / integer', () => {
            it('accepts numbers and rejects non-numbers for type number', () => {
                expect(accepts({ type: 'number' }, 3.14)).toBe(true);
                expect(accepts({ type: 'number' }, 'x')).toBe(false);
            });

            it('treats integer the same as number (z.number())', () => {
                expect(accepts({ type: 'integer' }, 7)).toBe(true);
                expect(accepts({ type: 'integer' }, 'x')).toBe(false);
            });

            it('enforces minimum at the boundary', () => {
                const s = { type: 'number', minimum: 10 };
                expect(accepts(s, 9)).toBe(false); // below
                expect(accepts(s, 10)).toBe(true); // exactly
            });

            it('applies a minimum of 0 (guard is `!== undefined`, not truthiness)', () => {
                // A mutant using `schema.minimum &&` would treat 0 as falsy and
                // skip the constraint, letting -1 through.
                const s = { type: 'number', minimum: 0 };
                expect(accepts(s, -1)).toBe(false);
                expect(accepts(s, 0)).toBe(true);
            });

            it('enforces maximum at the boundary', () => {
                const s = { type: 'number', maximum: 10 };
                expect(accepts(s, 10)).toBe(true); // exactly
                expect(accepts(s, 11)).toBe(false); // above
            });

            it('enforces multipleOf', () => {
                const s = { type: 'number', multipleOf: 3 };
                expect(accepts(s, 6)).toBe(true);
                expect(accepts(s, 7)).toBe(false);
            });
        });

        describe('boolean', () => {
            it('accepts booleans and rejects non-booleans', () => {
                expect(accepts({ type: 'boolean' }, true)).toBe(true);
                expect(accepts({ type: 'boolean' }, false)).toBe(true);
                expect(accepts({ type: 'boolean' }, 'true')).toBe(false);
            });
        });

        describe('array', () => {
            it('validates element type when items is present', () => {
                const s = { type: 'array', items: { type: 'string' } };
                expect(accepts(s, ['a', 'b'])).toBe(true);
                expect(accepts(s, [1, 2])).toBe(false);
                expect(accepts(s, 'not-an-array')).toBe(false);
            });

            it('uses z.array(z.unknown()) when items is absent', () => {
                const s = { type: 'array' };
                expect(accepts(s, [1, 'a', true])).toBe(true);
                expect(accepts(s, 'not-an-array')).toBe(false);
            });

            it('enforces minItems at the boundary', () => {
                const s = { type: 'array', items: { type: 'number' }, minItems: 2 };
                expect(accepts(s, [1])).toBe(false); // 1 < 2
                expect(accepts(s, [1, 2])).toBe(true); // 2 == 2
            });

            it('enforces maxItems at the boundary', () => {
                const s = { type: 'array', items: { type: 'number' }, maxItems: 2 };
                expect(accepts(s, [1, 2])).toBe(true); // 2 == 2
                expect(accepts(s, [1, 2, 3])).toBe(false); // 3 > 2
            });

            it('enforces uniqueItems only when it is strictly === true', () => {
                const unique = {
                    type: 'array',
                    items: { type: 'number' },
                    uniqueItems: true,
                };
                expect(accepts(unique, [1, 2])).toBe(true);
                expect(accepts(unique, [1, 1])).toBe(false);

                // A truthy-but-not-true value must NOT trigger the constraint
                // (kills `=== true` -> truthiness mutant): duplicates allowed.
                const truthy = {
                    type: 'array',
                    items: { type: 'number' },
                    uniqueItems: 'yes',
                };
                expect(accepts(truthy, [1, 1])).toBe(true);
            });
        });

        describe('object', () => {
            it('recurses into a nested object schema with properties', () => {
                const s = {
                    type: 'object',
                    properties: { a: { type: 'string' } },
                    required: ['a'],
                };
                expect(accepts(s, { a: 'x' })).toBe(true);
                expect(accepts(s, {})).toBe(false); // required a missing
                expect(accepts(s, { a: 5 })).toBe(false); // wrong type
            });

            it('uses z.record(string, unknown) for an object without properties', () => {
                const s = { type: 'object' };
                expect(accepts(s, { anything: 1, more: 'x' })).toBe(true);
                expect(accepts(s, 'not-an-object')).toBe(false);
            });
        });

        describe('null and unknown types', () => {
            it('accepts only null for type null', () => {
                expect(accepts({ type: 'null' }, null)).toBe(true);
                expect(accepts({ type: 'null' }, 0)).toBe(false);
                expect(accepts({ type: 'null' }, 'null')).toBe(false);
            });

            it('falls back to z.unknown() for an unrecognised type (accepts anything)', () => {
                const s = { type: 'mystery-type' };
                expect(accepts(s, 123)).toBe(true);
                expect(accepts(s, 'x')).toBe(true);
                expect(accepts(s, { nested: true })).toBe(true);
            });
        });

        it('preserves description on a top-level typed schema', () => {
            const built = jsonSchemaToZod({ type: 'string', description: 'a name' });
            expect(built.description).toBe('a name');
        });
    });
});
