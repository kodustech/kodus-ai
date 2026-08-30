import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { jsonSchema } from 'ai';

import {
    ensureValidatingSchema,
    repairAndValidate,
} from '@libs/llm/structured-output-repair';

/**
 * RETURN-SHAPE CORPUS — deterministic replay of REAL model outputs.
 *
 * Each fixture in evals/structured-outputs/return-corpus/*.json is the RAW text
 * a specific model/provider actually returned to a structured-review ask
 * (captured once via `capture-return.js`, no key needed here). This test feeds
 * every captured return back through the SAME parser the pipeline uses
 * (`repairAndValidate`) and asserts it recovers a valid `{ findings: [...] }`.
 *
 * Why: "the parse must work for diverse models" is guarded WITHOUT a flaky live
 * matrix — add a fixture once, and that model's real wrapping style (fence,
 * prose, thinking, trailing comma, clean) is a permanent regression guard.
 * To add a model: `node evals/structured-outputs/capture-return.js --model=X`.
 */
const CORPUS_DIR = join(
    __dirname,
    '../../../evals/structured-outputs/return-corpus',
);

const REVIEW_SCHEMA = ensureValidatingSchema(
    jsonSchema({
        type: 'object',
        properties: {
            findings: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        title: { type: 'string' },
                        severity: { type: 'string' },
                    },
                    required: ['title', 'severity'],
                    additionalProperties: true,
                },
            },
        },
        required: ['findings'],
        additionalProperties: true,
    } as any),
);

type Fixture = { model: string; resolvedModel?: string; raw: string };

const fixtures: Array<{ name: string; fx: Fixture }> = existsSync(CORPUS_DIR)
    ? readdirSync(CORPUS_DIR)
          .filter((f) => f.endsWith('.json'))
          .map((f) => ({
              name: f.replace(/\.json$/, ''),
              fx: JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')) as Fixture,
          }))
    : [];

describe('structured-output return corpus (real per-model returns)', () => {
    it('has at least one captured fixture', () => {
        // Guards against the corpus silently emptying (a deleted dir would make
        // every per-model check below vanish and the suite look green for free).
        expect(fixtures.length).toBeGreaterThan(0);
    });

    if (fixtures.length === 0) return;

    describe.each(fixtures)('$name', ({ fx }) => {
        it('repairAndValidate recovers a valid { findings: [...] } from the raw return', async () => {
            const parsed = (await repairAndValidate(
                REVIEW_SCHEMA,
                fx.raw,
            )) as { findings?: unknown } | undefined;
            expect(parsed).toBeDefined();
            expect(Array.isArray(parsed?.findings)).toBe(true);
        });
    });
});
