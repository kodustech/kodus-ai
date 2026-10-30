import { asSchema, jsonSchema, type Schema } from 'ai';
import { z } from 'zod';

import {
    ensureValidatingSchema,
    repairAndValidate,
} from './structured-output-repair';
import { zodToStrictWireSchema } from './strict-wire-schema';
import {
    DEDUP_SCHEMA,
    DEDUP_TIEBREAK_SCHEMA,
} from '@libs/code-review/infrastructure/agents/engine/dedup-prompt';
import {
    classificationBatchSchema,
    PR_TYPES,
} from '@libs/ee/analytics-warehouse/classification/classification.prompts';

/**
 * Per-PHASE structured-output contract tests. Each review phase hands the ONE
 * primitive (`LLM.run({schema})`) a DIFFERENT schema — a raw `jsonSchema()`
 * (dedup) or a zod schema (kody-rules / classification / guidance). This suite
 * pins that, for every one of those shapes, the generic recovery machinery:
 *   - guarantees validation (raw schemas get an ajv validator; zod already has
 *     one via strict-wire) — a wrong-shape payload is REJECTED, so the executor
 *     escalates instead of silently accepting it (the #1786 class);
 *   - repairs a conforming-but-fenced payload back to the exact typed value.
 *
 * It uses the REAL phase schemas where they are dependency-light to import
 * (the two dedup constants, the zod classification schema) and a faithful
 * representative for the phases whose schema lives behind heavy service DI
 * (guidance extraction — the `.optional()` shape strict-wire exists for).
 */

/** Guidance-extraction-style contract: the `.optional()` shape the strict-wire
 *  conversion exists for (a strict provider must be able to express "absent"). */
const guidanceExtractionSchema = z.object({
    ruleId: z.string(),
    severity: z.enum(['low', 'medium', 'high']),
    rationale: z.string().optional(),
});

interface PhaseContract {
    /** Human phase label (also the test title via $phase). */
    phase: string;
    /** What the phase actually passes to LLM.run — zod OR a jsonSchema() Schema. */
    schema: z.ZodType | Schema;
    /** A payload that conforms to the contract. */
    valid: unknown;
    /** A realistic wrong-shape payload a flubbing model could return. */
    malformed: unknown;
}

const CONTRACTS: PhaseContract[] = [
    {
        phase: 'dedup (raw jsonSchema, nested groups/unique)',
        schema: jsonSchema(DEDUP_SCHEMA as any),
        valid: { groups: [{ keep: 0, duplicates: [1, 2] }], unique: [3] },
        // renamed key + missing required (groups/unique) + additionalProperties:false
        malformed: { clusters: [{ keep: 0, duplicates: [] }] },
    },
    {
        phase: 'dedup tiebreak (raw jsonSchema, flat strings + boolean)',
        schema: jsonSchema(DEDUP_TIEBREAK_SCHEMA as any),
        valid: { rootCauseA: 'off-by-one', rootCauseB: 'null deref', sameBug: false },
        // sameBug wrong type + required rootCauseA/B missing
        malformed: { sameBug: 'maybe' },
    },
    {
        phase: 'PR classification (zod, array of {string, enum})',
        schema: classificationBatchSchema,
        valid: {
            classifications: [
                { pullRequestId: '42', type: PR_TYPES[1] /* Feature */ },
            ],
        },
        // wrong id type + enum value outside PR_TYPES
        malformed: { classifications: [{ pullRequestId: 42, type: 'Nope' }] },
    },
    {
        phase: 'guidance extraction (zod with .optional() → strict-wire)',
        schema: guidanceExtractionSchema,
        // optional `rationale` omitted — the strict-wire round-trip must accept it
        valid: { ruleId: 'kr-12', severity: 'high' },
        // bad enum + required ruleId missing
        malformed: { severity: 'critical' },
    },
];

/** Mirror EXACTLY what runStructuredReviewCall does to build the wire schema:
 *  zod → strict-wire (carries its own validate), raw Schema → ajv-guarded. */
function toValidatingSchema(input: z.ZodType | Schema): unknown {
    const wire = input instanceof z.ZodType ? zodToStrictWireSchema(input) : input;
    return ensureValidatingSchema(wire);
}

describe('structured-output phase contracts', () => {
    it.each(CONTRACTS)(
        '$phase — accepts a conforming payload and repairs a fenced one',
        async ({ valid, schema }) => {
            const wire = toValidatingSchema(schema);
            const validate = asSchema(wire as any).validate;
            expect(typeof validate).toBe('function');
            expect((await validate!(valid)).success).toBe(true);

            // Model wrapped the (correct) JSON in a ```json fence → recovered
            // deterministically, held to this phase's exact schema.
            const fenced = '```json\n' + JSON.stringify(valid) + '\n```';
            expect(await repairAndValidate(wire, fenced)).toEqual(valid);
        },
    );

    it.each(CONTRACTS)(
        '$phase — REJECTS a malformed payload so the executor escalates (issue #1786)',
        async ({ malformed, schema }) => {
            const wire = toValidatingSchema(schema);
            const validate = asSchema(wire as any).validate;
            expect((await validate!(malformed)).success).toBe(false);

            // A fenced-but-wrong-shape payload is NOT silently accepted — repair
            // returns undefined, which is what drives the model re-ask.
            const fencedBad = '```json\n' + JSON.stringify(malformed) + '\n```';
            expect(await repairAndValidate(wire, fencedBad)).toBeUndefined();
        },
    );
});
