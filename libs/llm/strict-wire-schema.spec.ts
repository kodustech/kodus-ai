import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { zodToStrictWireSchema } from '@libs/llm/strict-wire-schema';
import { kodyRulesIDEGeneratorSchema } from '@libs/common/utils/langchainCommon/prompts/kodyRules';
import { kodyMemoryResolutionSchema } from '@libs/common/utils/langchainCommon/prompts/kodyMemoryResolution';
import { kodyRulesRecommendationSchema } from '@libs/common/utils/langchainCommon/prompts/kodyRulesRecommendation';
import { compilerOutputSchema } from '@libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler';
import { decomposeOutputSchema } from '@libs/kodyRules/infrastructure/adapters/services/kody-rule-summary.service';
import { shardViolationsWireSchema } from '@libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge';
import {
    MERGE_MATCHES_SCHEMA,
    ISSUE_VERIFICATION_SCHEMA,
} from '@libs/ee/codeBase/kodyIssuesAnalysis.service';

// OpenAI strict structured outputs impose TWO rules on every object node, and
// 400 the request if either is violated:
//   1. `required` must list EVERY key in `properties` ("'required' is required
//      to be supplied and to be an array including every key in properties").
//   2. `additionalProperties` must be `false`.
// Checked recursively because the live failures were on NESTED nodes
// (rules.items, violations.items), not just the root.
function assertStrictRequired(node: any, path = '$'): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        node.forEach((n, i) => assertStrictRequired(n, `${path}[${i}]`));
        return;
    }
    if (node.type === 'object' && node.properties) {
        expect({
            path,
            required: [...(node.required ?? [])].sort(),
            additionalProperties: node.additionalProperties,
        }).toEqual({
            path,
            required: Object.keys(node.properties).sort(),
            additionalProperties: false,
        });
    }
    for (const key of Object.keys(node)) {
        assertStrictRequired(node[key], `${path}.${key}`);
    }
}

describe('zodToStrictWireSchema', () => {
    // EVERY zod schema passed to runStructuredReviewCall — not just the ones
    // that failed live. runStructuredReviewCall routes zod schemas through
    // zodToStrictWireSchema centrally, so any of these developing an
    // unaccounted-for `.optional()` (or a shape the converter can't handle,
    // which degrades to the raw zod schema and 400s OpenAI-strict) fails here
    // BEFORE it 400s a BYOK-OpenAI customer's shards.
    const realSchemas: Array<[string, z.ZodType]> = [
        ['kodyRulesIDEGeneratorSchema (guidance-file extraction)', kodyRulesIDEGeneratorSchema],
        ['kodyMemoryResolutionSchema', kodyMemoryResolutionSchema],
        ['compilerOutputSchema (detector compiler)', compilerOutputSchema],
        ['kodyRulesRecommendationSchema (rule recommendation)', kodyRulesRecommendationSchema],
        ['decomposeOutputSchema (atom decomposition)', decomposeOutputSchema],
        ['MERGE_MATCHES_SCHEMA (issue merge)', MERGE_MATCHES_SCHEMA],
        ['ISSUE_VERIFICATION_SCHEMA (issue resolve)', ISSUE_VERIFICATION_SCHEMA],
    ];

    it.each(realSchemas)(
        '%s → wire schema is OpenAI-strict compatible',
        (_name, schema) => {
            const wire = (zodToStrictWireSchema(schema) as any).jsonSchema;
            assertStrictRequired(wire);
        },
    );

    it('previously-optional fields become nullable on the wire', () => {
        const wire = (zodToStrictWireSchema(compilerOutputSchema) as any)
            .jsonSchema;
        // pattern was .optional() — must now be required AND accept null
        expect(wire.required).toContain('pattern');
        expect(JSON.stringify(wire.properties.pattern)).toContain('"null"');
        // mechanical was already required — left untouched
        expect(JSON.stringify(wire.properties.mechanical)).not.toContain(
            '"null"',
        );
    });

    it('validate(): strict-provider null fills round-trip to absent', () => {
        const result = (zodToStrictWireSchema(compilerOutputSchema) as any)
            .validate({
                mechanical: false,
                pattern: null,
                flags: null,
                reason: null,
            });
        expect(result.success).toBe(true);
        expect(result.value.pattern).toBeUndefined();
        expect(result.value.mechanical).toBe(false);
    });

    it('validate(): lenient providers that omit optional keys still parse', () => {
        const result = (zodToStrictWireSchema(kodyRulesIDEGeneratorSchema) as any)
            .validate({
                rules: [
                    {
                        title: 't',
                        rule: 'r',
                        path: '**/*.rb',
                        sourcePath: 'CLAUDE.md',
                        severity: 'high',
                        examples: [{ snippet: 's', isCorrect: true }],
                    },
                ],
            });
        expect(result.success).toBe(true);
        expect(result.value.rules).toHaveLength(1);
    });

    it('validate(): a literal __proto__ key in LLM output cannot touch prototypes', () => {
        const schema = z.object({ a: z.string().optional() });
        const payload = JSON.parse('{"a":"x","__proto__":{"polluted":true}}');
        const result = (zodToStrictWireSchema(schema) as any).validate(payload);
        expect(result.success).toBe(true);
        expect(({} as any).polluted).toBeUndefined();
        expect((result.value as any).polluted).toBeUndefined();
    });

    it('validate(): real type errors still fail parse', () => {
        const result = (zodToStrictWireSchema(compilerOutputSchema) as any)
            .validate({ mechanical: 'yes' });
        expect(result.success).toBe(false);
    });
});

/**
 * runStructuredReviewCall contract (issue #1452 matrix-gaps item 4).
 *
 * Two gaps the per-schema tests above don't close:
 *
 *  1. runStructuredReviewCall passes AI-SDK `Schema` objects through
 *     UNTOUCHED (it only runs zod schemas through zodToStrictWireSchema).
 *     A pre-built wire Schema with a non-`required` key therefore has NO net
 *     and 400s OpenAI-strict exactly like the original bug. Assert every
 *     pass-through wire schema is born strict-required.
 *
 *  2. The per-schema list is hand-maintained; a NEW call site with a new
 *     schema silently escapes coverage. A source scan asserts every
 *     runStructuredReviewCall call site lives in a known file whose schema is
 *     registered above — a new call site fails CI until it's added here.
 */
describe('runStructuredReviewCall — strict-wire contract across ALL call sites', () => {
    // AI-SDK Schema objects passed directly to runStructuredReviewCall (they
    // bypass zodToStrictWireSchema). MUST already be OpenAI-strict compatible.
    const passThroughWireSchemas: Array<[string, any]> = [
        ['shardViolationsWireSchema (sharded kody-rules judge)', shardViolationsWireSchema],
    ];

    it.each(passThroughWireSchemas)(
        'pass-through wire schema %s is born OpenAI-strict (every key required)',
        (_name, schema) => {
            assertStrictRequired((schema as any).jsonSchema);
        },
    );

    // The files that call runStructuredReviewCall today, each with the schema
    // covered above. Keep this in lockstep with the schema lists — the scan
    // below fails if a call site appears in a file that isn't listed here.
    const REGISTERED_CALL_SITE_FILES = new Set<string>([
        'libs/ee/kodyRules/service/kody-rule-detector-compiler.service.ts', // compilerOutputSchema
        'libs/ee/kodyRules/service/kodyRules.service.ts', // kodyRulesRecommendationSchema, kodyMemoryResolutionSchema
        'libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider.ts', // shardViolationsWireSchema
        'libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service.ts', // kodyRulesIDEGeneratorSchema
        'libs/kodyRules/infrastructure/adapters/services/kody-rule-summary.service.ts', // decomposeOutputSchema (+ compilerOutputSchema, already covered)
        'libs/ee/codeBase/kodyIssuesAnalysis.service.ts', // MERGE_MATCHES_SCHEMA, ISSUE_VERIFICATION_SCHEMA
    ]);

    it('every runStructuredReviewCall call site is registered (schema is under test)', () => {
        const root = process.cwd();
        const callers: string[] = [];

        const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const abs = join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === 'dist') {
                        continue;
                    }
                    walk(abs);
                } else if (
                    entry.name.endsWith('.ts') &&
                    !entry.name.endsWith('.spec.ts') &&
                    // the definition itself (`runStructuredReviewCall<S…>(`)
                    // never matches the call pattern `runStructuredReviewCall(`
                    entry.name !== 'structured-review-call.ts'
                ) {
                    const src = readFileSync(abs, 'utf8');
                    if (src.includes('runStructuredReviewCall(')) {
                        callers.push(abs.slice(root.length + 1));
                    }
                }
            }
        };
        walk(join(root, 'libs'));

        const unregistered = callers
            .filter((f) => !REGISTERED_CALL_SITE_FILES.has(f))
            .sort();

        // A new call site means a new schema flowing to the strict-wire path.
        // Register its file above AND add its schema to realSchemas /
        // passThroughWireSchemas so this contract covers it.
        expect({ unregisteredCallSites: unregistered }).toEqual({
            unregisteredCallSites: [],
        });

        // Sanity: the scan actually found the known call sites (guards against
        // the walk silently matching nothing and passing vacuously).
        expect(callers.length).toBeGreaterThanOrEqual(
            REGISTERED_CALL_SITE_FILES.size,
        );
    });
});
