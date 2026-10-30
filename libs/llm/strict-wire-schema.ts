/**
 * OpenAI structured outputs (strict `json_schema`) reject any schema whose
 * `required` array doesn't list EVERY key in `properties`. Zod schemas with
 * `.optional()` fields therefore 400 instantly on `openai.responses` — this
 * silently killed every kody-rules shard AND every guidance-file rule
 * extraction for BYOK-OpenAI orgs (found live in QA; two call sites, same
 * class, and any future `.optional()` schema would reintroduce it).
 *
 * `zodToStrictWireSchema` converts a zod schema into an AI-SDK `Schema` whose
 * WIRE format is strict-compatible while the PARSE stays lenient:
 *
 *  - wire: OUTPUT-side JSON schema, then every object property is forced into
 *    `required` — previously-optional ones become nullable (`anyOf [T, null]`)
 *    so a strict provider has a way to express "absent".
 *  - validate: `null` object properties are stripped back to ABSENT, then the
 *    original zod schema parses. Lenient providers that omit keys entirely
 *    parse unchanged; strict providers' `null` fills round-trip to undefined.
 *
 * Constraint: fields that MUST be `null` as a meaningful value are not
 * supported (null is normalized to absent). All review-pipeline schemas use
 * `.optional()`, not `.nullable()`, so this holds — assert it stays that way
 * in the schema, not here.
 *
 * NOTE deliberately NOT using the AI SDK's `zodSchema()`: it derives the JSON
 * schema from the zod INPUT side, where `.optional()`/preprocess fields accept
 * `undefined`, so it drops them from `required` — that exact gap shipped one
 * broken fix already (#1525).
 */
import { jsonSchema, type Schema } from 'ai';
import { z } from 'zod';

const NULL_TYPE = { type: 'null' };

function allowsNull(node: any): boolean {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'null') return true;
    if (Array.isArray(node.type) && node.type.includes('null')) return true;
    return ['anyOf', 'oneOf'].some(
        (k) => Array.isArray(node[k]) && node[k].some(allowsNull),
    );
}

/** Recursively force strict-mode required semantics onto a JSON schema. */
function makeStrictRequired(node: any): void {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
        node.forEach(makeStrictRequired);
        return;
    }

    if (node.type === 'object' && node.properties) {
        const required = new Set<string>(node.required ?? []);
        for (const key of Object.keys(node.properties)) {
            if (!required.has(key)) {
                const prop = node.properties[key];
                if (!allowsNull(prop)) {
                    node.properties[key] = { anyOf: [prop, NULL_TYPE] };
                }
            }
        }
        node.required = Object.keys(node.properties);
    }

    for (const key of [
        'properties',
        'items',
        'anyOf',
        'oneOf',
        'allOf',
        '$defs',
        'definitions',
        'additionalProperties',
    ]) {
        const child = node[key];
        if (child && typeof child === 'object') {
            if (key === 'properties' || key === '$defs' || key === 'definitions') {
                Object.values(child).forEach(makeStrictRequired);
            } else {
                makeStrictRequired(child);
            }
        }
    }
}

/** Strip null-valued object properties so lenient zod parse sees them as absent. */
function stripNullProps(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripNullProps);
    if (value && typeof value === 'object') {
        // Null-prototype target: the keys come from raw LLM output, so a
        // literal "__proto__" key on a plain {} would hit the prototype
        // setter instead of creating an own property.
        const out: Record<string, unknown> = Object.create(null);
        for (const [k, v] of Object.entries(value)) {
            if (v === null) continue;
            out[k] = stripNullProps(v);
        }
        return out;
    }
    return value;
}

export function zodToStrictWireSchema<T extends z.ZodType>(
    schema: T,
): Schema<z.infer<T>> {
    const wire = z.toJSONSchema(schema, {
        target: 'draft-7',
        io: 'output',
    }) as any;
    makeStrictRequired(wire);

    return jsonSchema(wire, {
        validate: (value) => {
            const result = schema.safeParse(stripNullProps(value));
            return result.success
                ? { success: true, value: result.data }
                : { success: false, error: result.error };
        },
    });
}
