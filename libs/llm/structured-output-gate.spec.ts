import {
    jsonSchema,
    NoObjectGeneratedError,
    JSONParseError,
    TypeValidationError,
} from 'ai';
import {
    openRouterHonorsJsonSchema,
    openAiCompatibleHonorsJsonSchema,
    isNeverDowngradeModel,
} from './structured-output-gate';
import {
    ensureValidatingSchema,
    repairAndValidate,
    readOutput,
    salvageStructuredError,
} from './structured-output-repair';

describe('openRouterHonorsJsonSchema', () => {
    it('enables for known schema-honoring prefixes', () => {
        expect(openRouterHonorsJsonSchema('openai/gpt-5')).toBe(true);
        expect(openRouterHonorsJsonSchema('anthropic/claude-opus-5')).toBe(true);
        expect(openRouterHonorsJsonSchema('google/gemini-3')).toBe(true);
        expect(openRouterHonorsJsonSchema('moonshotai/kimi-k2')).toBe(true);
    });

    it('rejects unknown upstreams', () => {
        expect(openRouterHonorsJsonSchema('deepseek/deepseek-chat')).toBe(false);
        expect(openRouterHonorsJsonSchema('x-ai/grok-4')).toBe(false);
    });
});

describe('openAiCompatibleHonorsJsonSchema', () => {
    const orig = { ...process.env };
    afterEach(() => {
        process.env = { ...orig };
    });

    it('false without a baseURL', () => {
        expect(openAiCompatibleHonorsJsonSchema(undefined)).toBe(false);
        expect(openAiCompatibleHonorsJsonSchema('')).toBe(false);
    });

    it('true for vLLM :8000 and Fireworks', () => {
        expect(openAiCompatibleHonorsJsonSchema('http://vllm.internal:8000/v1')).toBe(true);
        expect(openAiCompatibleHonorsJsonSchema('https://api.fireworks.ai/inference/v1')).toBe(true);
    });

    it('false for an unknown proxy, true once ops allowlists it', () => {
        expect(openAiCompatibleHonorsJsonSchema('https://my-proxy.example.com/v1')).toBe(false);
        process.env.API_TRUST_JSON_SCHEMA_BASE_URLS = 'my-proxy.example.com,other';
        expect(openAiCompatibleHonorsJsonSchema('https://my-proxy.example.com/v1')).toBe(true);
    });
});

describe('isNeverDowngradeModel', () => {
    it('matches Kimi / Moonshot in any casing/host form', () => {
        expect(isNeverDowngradeModel('kimi-k2.7-code')).toBe(true);
        expect(isNeverDowngradeModel('moonshotai/kimi-k2')).toBe(true);
        expect(isNeverDowngradeModel('Moonshot-v1-128k')).toBe(true);
    });
    it('does not match unrelated models', () => {
        expect(isNeverDowngradeModel('gpt-5')).toBe(false);
        expect(isNeverDowngradeModel('claude-opus-5')).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1786 CONTRACT — the json_object fallback decision must not silently degrade.
//
// The gate is the DECISION half of the structured-output boundary: it picks
// strict `json_schema` (schema goes to the provider) vs the `json_object`
// fallback (schema does NOT reach the provider → the model can invent its own
// envelope). Issue #1786: on kimi/glm/deepseek/z-ai the model returns JSON in
// the WRONG envelope and the pipeline SILENTLY degrades (dedup keeps all →
// duplicate comments ship). These are contract tests for the deterministic
// layer around the model call: the per-provider fallback DECISION, the request
// assembly it feeds, the guaranteed parse/return shape, and the fail-safe.
// Model decision QUALITY is out of scope (that is the eval track).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two production compositions that consume the gate to set the wire flag
 * `supportsStructuredOutputs`, copied verbatim from the provider `build()`s so
 * the assembled decision is pinned, not just the raw helpers:
 *   - openrouter/index.ts build(): `openRouterHonorsJsonSchema(model)`
 *   - openai/index.ts     build(): `isNeverDowngradeModel(model) ||
 *                                    openAiCompatibleHonorsJsonSchema(baseURL)`
 * `false` === the json_object fallback path (the #1786 surface).
 */
const openRouterUsesJsonSchema = (model: string): boolean =>
    openRouterHonorsJsonSchema(model);
const openAiCompatibleUsesJsonSchema = (
    model: string,
    baseURL?: string,
): boolean =>
    isNeverDowngradeModel(model) || openAiCompatibleHonorsJsonSchema(baseURL);

describe('#1786 fallback decision — request assembly (Layer 1: happy path)', () => {
    it('OpenRouter: schema-honoring upstreams assemble json_schema ON', () => {
        // Deep-equal the exact wire decision (true === strict json_schema sent).
        expect(
            [
                'openai/gpt-5',
                'anthropic/claude-opus-5',
                'google/gemini-3-pro',
                'moonshotai/kimi-k2',
            ].map(openRouterUsesJsonSchema),
        ).toEqual([true, true, true, true]);
    });

    it('openai_compatible: known-strict endpoints assemble json_schema ON', () => {
        // vLLM :8000 and Fireworks are the two evidence-backed honorers.
        expect(
            openAiCompatibleUsesJsonSchema('llama-3.3-70b', 'http://vllm.internal:8000/v1'),
        ).toBe(true);
        expect(
            openAiCompatibleUsesJsonSchema(
                'accounts/fireworks/models/deepseek-v4',
                'https://api.fireworks.ai/inference/v1',
            ),
        ).toBe(true);
    });

    it('never-downgrade family keeps json_schema ON regardless of transport', () => {
        // Kimi/Moonshot lose ~50% of structured outputs when forced to
        // json_object (D-00b) — the override must win over BOTH the OpenRouter
        // prefix rule and the openai_compatible baseURL heuristic.
        expect(openRouterUsesJsonSchema('moonshotai/kimi-k2')).toBe(true);
        // Direct-Moonshot upstream: baseURL heuristic ALONE rejects it, but the
        // never-downgrade override flips the assembled decision back ON.
        expect(openAiCompatibleHonorsJsonSchema('https://api.moonshot.ai/v1')).toBe(
            false,
        );
        expect(
            openAiCompatibleUsesJsonSchema('kimi-k2.7-code', 'https://api.moonshot.ai/v1'),
        ).toBe(true);
    });
});

describe('#1786 fallback decision — N-model robustness (Layer 2a)', () => {
    // The models that in production fall back to json_object and are documented
    // to emit off-schema envelopes. The CONTRACT: the gate must route each to
    // the fallback (false) so we never OVER-PROMISE strict json_schema to an
    // upstream that ignores it — an over-promise is what makes the mismatch
    // silent. It must also NEVER route a never-downgrade model to the fallback.
    const nonStrictOverOpenRouter = [
        'deepseek/deepseek-chat',
        'deepseek/deepseek-r1',
        'z-ai/glm-4.6',
        'z-ai/glm-5',
        'x-ai/grok-4',
        'qwen/qwen-2.5-72b',
        'meta-llama/llama-3.3-70b',
        'minimax/minimax-01',
        'mistralai/mistral-large',
    ];

    it.each(nonStrictOverOpenRouter)(
        'OpenRouter routes %s to json_object (no over-promise)',
        (model) => {
            expect(openRouterUsesJsonSchema(model)).toBe(false);
        },
    );

    it('a brand-new/unknown OpenRouter upstream defaults SAFE (json_object)', () => {
        // The safe default is the whole point: an id we have no evidence for
        // must not silently claim strict support.
        expect(openRouterUsesJsonSchema('some-new-vendor/model-v1')).toBe(false);
        expect(openRouterUsesJsonSchema('cohere/command-r-plus')).toBe(false);
    });

    const nonStrictCompatEndpoints: Array<[string, string]> = [
        ['deepseek-chat', 'https://api.deepseek.com/v1'],
        ['glm-4.6', 'https://api.z.ai/api/paas/v4'],
        ['qwen-2.5-72b', 'https://api.together.xyz/v1'],
        ['llama-3.3-70b', 'https://my-llm-proxy.example.com/v1'],
    ];

    it.each(nonStrictCompatEndpoints)(
        'openai_compatible routes %s @ %s to json_object (no over-promise)',
        (model, baseURL) => {
            expect(openAiCompatibleUsesJsonSchema(model, baseURL)).toBe(false);
        },
    );

    it('GLM/DeepSeek over openai_compatible are NOT rescued by never-downgrade', () => {
        // Only Kimi/Moonshot are never-downgrade; GLM & DeepSeek DO fall back.
        expect(isNeverDowngradeModel('glm-4.6')).toBe(false);
        expect(isNeverDowngradeModel('deepseek-r1')).toBe(false);
    });

    it('never-downgrade catches every Kimi/Moonshot id form (no downgrade)', () => {
        // If any of these slips to json_object we hit the measured ~50% loss.
        expect(
            [
                'kimi-k2.7-code',
                'kimi-k3',
                'moonshotai/kimi-k2',
                'Moonshot-v1-128k',
                'MOONSHOT/kimi',
            ].map(isNeverDowngradeModel),
        ).toEqual([true, true, true, true, true]);
    });
});

// The dedup-style contract: a raw jsonSchema() (no built-in validate fn) hardened
// by ensureValidatingSchema — exactly what runStructuredReviewCall hands the
// json_object fallback as `validatingSchema`. This is the guard that must catch a
// wrong envelope instead of shipping it.
const reviewJsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['suggestions'],
    properties: {
        suggestions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'body'],
                properties: {
                    id: { type: 'string' },
                    body: { type: 'string' },
                },
            },
        },
    },
} as const;
const reviewWire = ensureValidatingSchema(jsonSchema(reviewJsonSchema as any));

describe('#1786 off-schema robustness — json_object fallback must SIGNAL, not degrade (Layer 2b)', () => {
    it('happy: the correct envelope parses+validates to the exact object', async () => {
        const good = { suggestions: [{ id: '1', body: 'fix the leak' }] };
        await expect(
            repairAndValidate(reviewWire, JSON.stringify(good)),
        ).resolves.toEqual(good);
    });

    // Each of these is a real shape a non-strict model emits in json_object mode.
    // The fallback parse MUST return undefined (→ the executor re-asks/escalates)
    // — NEVER a wrong-but-truthy object that flows on as if it were valid.
    const offSchemaEnvelopes: Array<[string, string]> = [
        ['a bare array instead of {suggestions:[…]}', '[{"id":"1","body":"x"}]'],
        [
            'a {result:…} wrapper',
            '{"result":{"suggestions":[{"id":"1","body":"x"}]}}',
        ],
        [
            'the right data under the WRONG key (items not suggestions)',
            '{"items":[{"id":"1","body":"x"}]}',
        ],
        [
            'right container, wrong item keys (comment not body)',
            '{"suggestions":[{"id":"1","comment":"x"}]}',
        ],
        ['a partial object (missing required body)', '{"suggestions":[{"id":"1"}]}'],
        ['an empty object', '{}'],
        ['a JSON null', 'null'],
        [
            'a double-stringified JSON payload (string, not object)',
            JSON.stringify(JSON.stringify({ suggestions: [] })),
        ],
    ];

    it.each(offSchemaEnvelopes)(
        'rejects %s (returns undefined, does not keep-all)',
        async (_label, raw) => {
            await expect(repairAndValidate(reviewWire, raw)).resolves.toBeUndefined();
        },
    );

    it('a fenced/prose-wrapped CORRECT envelope is still recovered (not a false reject)', async () => {
        const wrapped =
            'Sure! Here is the review:\n```json\n{"suggestions":[{"id":"7","body":"ok"}]}\n```';
        await expect(repairAndValidate(reviewWire, wrapped)).resolves.toEqual({
            suggestions: [{ id: '7', body: 'ok' }],
        });
    });
});

describe('#1786 off-schema robustness — SDK-error salvage stays non-degrading (Layer 2b)', () => {
    it('salvages a PARSE error whose text repairs to the CORRECT shape', async () => {
        const err = new NoObjectGeneratedError({
            message: 'no object',
            cause: new JSONParseError({ text: 'x', cause: new Error('bad') }),
            text: '```json\n{"suggestions":[{"id":"1","body":"x"}]}\n```',
            response: undefined as any,
            usage: undefined as any,
            finishReason: undefined as any,
        });
        await expect(salvageStructuredError(err, reviewWire)).resolves.toEqual({
            suggestions: [{ id: '1', body: 'x' }],
        });
    });

    it('does NOT salvage a PARSE error whose repaired text is off-schema', async () => {
        const err = new NoObjectGeneratedError({
            message: 'no object',
            cause: new JSONParseError({ text: 'x', cause: new Error('bad') }),
            text: 'noise {"items":[{"id":"1","body":"x"}]} tail',
            response: undefined as any,
            usage: undefined as any,
            finishReason: undefined as any,
        });
        await expect(
            salvageStructuredError(err, reviewWire),
        ).resolves.toBeUndefined();
    });

    it('does NOT salvage a SHAPE mismatch (TypeValidationError cause → model re-ask)', async () => {
        // Valid JSON, wrong shape: string surgery can't fix it, so salvage must
        // defer to the model rather than fabricate a pass.
        const err = new NoObjectGeneratedError({
            message: 'wrong shape',
            cause: new TypeValidationError({
                value: { items: [] },
                cause: new Error('shape'),
            }),
            text: '{"items":[]}',
            response: undefined as any,
            usage: undefined as any,
            finishReason: undefined as any,
        });
        await expect(
            salvageStructuredError(err, reviewWire),
        ).resolves.toBeUndefined();
    });
});

describe('#1786 guaranteed return shape + fail-safe (Layer 3)', () => {
    it('gate helpers ALWAYS return a boolean and never throw on garbage input', () => {
        // A caller assembling the request relies on a definite yes/no.
        for (const bad of ['', ' ', '/', '::::', 'UNKNOWN', 'moON', '8000']) {
            expect(typeof openRouterHonorsJsonSchema(bad)).toBe('boolean');
            expect(typeof isNeverDowngradeModel(bad)).toBe('boolean');
        }
        for (const bad of [undefined, '', 'not-a-url', ':8000', 'http://x:80000/']) {
            expect(typeof openAiCompatibleHonorsJsonSchema(bad as any)).toBe(
                'boolean',
            );
        }
        // The empty/whitespace model must default to the SAFE fallback, never
        // an accidental strict claim.
        expect(openRouterHonorsJsonSchema('')).toBe(false);
        expect(isNeverDowngradeModel('')).toBe(false);
        expect(openAiCompatibleHonorsJsonSchema(undefined)).toBe(false);
    });

    it('the fallback parser degrades to undefined (never throws) on junk text', async () => {
        for (const junk of ['', '   ', 'totally not json', '<html></html>', '42abc']) {
            await expect(
                repairAndValidate(reviewWire, junk),
            ).resolves.toBeUndefined();
        }
    });

    it('readOutput returns the object or a defined undefined — never throws', () => {
        expect(readOutput({ output: { suggestions: [] } })).toEqual({
            suggestions: [],
        });
        expect(readOutput({ experimental_output: { a: 1 } })).toEqual({ a: 1 });
        // Guaranteed shape: a caller can rely on `undefined` (not a throw) when
        // the SDK produced no object channel at all.
        expect(readOutput({})).toBeUndefined();
        expect(readOutput(undefined)).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// MATRIX BACKFILL — the full LLM.run I/O contract matrix for THIS boundary.
//
// This boundary is the structured-output GATE (the yes/no json_schema decision)
// plus the deterministic parse/validate layer it delegates to
// (structured-output-repair.ts). It takes NO list input — it decides a boolean
// and, on the fallback path, parses one model text into the declared schema D.
// So the batch rows of dimension D (37 large-crossing-batch, 41 off-by-one) and
// the cross-input semantic rows (25 index-out-of-range) and the async-transport
// row (34 abort — this boundary is a pure sync decision + parse, it holds no
// live call to abort) are recorded N/A in the structured result, not skipped.
//
// The declared schema D under test is reviewWire = {suggestions:[{id,body}]}
// (additionalProperties:false, both levels). Extra local wires below exercise the
// semantic-but-wrong rows (B) that D itself has no field to express.
// ─────────────────────────────────────────────────────────────────────────────

// A boolean-field wire for B21–B23 (D has only string fields).
const keepWire = ensureValidatingSchema(
    jsonSchema({
        type: 'object',
        additionalProperties: false,
        required: ['keep'],
        properties: { keep: { type: 'boolean' } },
    } as any),
);
// An enum wire for B24.
const severityWire = ensureValidatingSchema(
    jsonSchema({
        type: 'object',
        additionalProperties: false,
        required: ['severity'],
        properties: {
            severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        },
    } as any),
);
// A tolerant wire (no additionalProperties:false) for row 13 — the matrix asks
// that unknown keys alongside the right ones be TOLERATED, not crash.
const tolerantWire = ensureValidatingSchema(
    jsonSchema({
        type: 'object',
        required: ['suggestions'],
        properties: {
            suggestions: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['id', 'body'],
                    properties: {
                        id: { type: 'string' },
                        body: { type: 'string' },
                    },
                },
            },
        },
    } as any),
);

describe('MATRIX A — output-shape zoo (fallback parse must recover or SIGNAL)', () => {
    // Row 1 — exact D is re-asserted here as the anchor of the zoo.
    it('[1] exact D parses+validates to the exact object', async () => {
        const good = { suggestions: [{ id: '1', body: 'fix the leak' }] };
        await expect(repairAndValidate(reviewWire, JSON.stringify(good))).resolves.toEqual(
            good,
        );
    });

    // Row 3 — single object where D expects an array (the vice-versa of the
    // bare-array row): suggestions is an object, not a list → reject, don't ship.
    it('[3] object where an array is expected → undefined', async () => {
        await expect(
            repairAndValidate(reviewWire, '{"suggestions":{"id":"1","body":"x"}}'),
        ).resolves.toBeUndefined();
    });

    // Row 4 — every wrapper-key form the SDK/models emit. {result:D} is pinned in
    // Layer 2b; here are data/output/response/json.
    const wrappers: Array<[string, string]> = [
        ['{data:D}', '{"data":{"suggestions":[{"id":"1","body":"x"}]}}'],
        ['{output:D}', '{"output":{"suggestions":[{"id":"1","body":"x"}]}}'],
        ['{response:D}', '{"response":{"suggestions":[{"id":"1","body":"x"}]}}'],
        ['{json:D}', '{"json":{"suggestions":[{"id":"1","body":"x"}]}}'],
    ];
    it.each(wrappers)('[4] wrapper %s → undefined (not shipped as-is)', async (_l, raw) => {
        await expect(repairAndValidate(reviewWire, raw)).resolves.toBeUndefined();
    });

    // Row 5 — double wrapper {result:{result:D}}.
    it('[5] double wrapper {result:{result:D}} → undefined', async () => {
        await expect(
            repairAndValidate(
                reviewWire,
                '{"result":{"result":{"suggestions":[{"id":"1","body":"x"}]}}}',
            ),
        ).resolves.toBeUndefined();
    });

    // Row 6 — numeric/opaque single-key wrap.
    it('[6] numeric/opaque single-key wrap ({"0":D} / {content:D}) → undefined', async () => {
        await expect(
            repairAndValidate(reviewWire, '{"0":{"suggestions":[{"id":"1","body":"x"}]}}'),
        ).resolves.toBeUndefined();
        await expect(
            repairAndValidate(
                reviewWire,
                '{"content":{"suggestions":[{"id":"1","body":"x"}]}}',
            ),
        ).resolves.toBeUndefined();
    });

    // Row 11 — case/convention mismatch, both at container and item level.
    it('[11] case/convention mismatch (Suggestions / ID,Body) → undefined', async () => {
        await expect(
            repairAndValidate(reviewWire, '{"Suggestions":[{"id":"1","body":"x"}]}'),
        ).resolves.toBeUndefined();
        await expect(
            repairAndValidate(reviewWire, '{"suggestions":[{"ID":"1","Body":"x"}]}'),
        ).resolves.toBeUndefined();
    });

    // Row 13 — extra unknown keys must be TOLERATED, not crash. Under the strict
    // wire they are an explicit reject (still non-degrading, observable); under a
    // tolerant wire they are recovered whole.
    it('[13] extra unknown keys: tolerated by a permissive schema', async () => {
        const withExtra = {
            suggestions: [{ id: '1', body: 'x', note: 'ignore me' }],
            meta: 'info',
        };
        await expect(
            repairAndValidate(tolerantWire, JSON.stringify(withExtra)),
        ).resolves.toEqual(withExtra);
    });
    it('[13] extra unknown keys under a strict schema → explicit reject (not a crash)', async () => {
        await expect(
            repairAndValidate(
                reviewWire,
                '{"suggestions":[{"id":"1","body":"x"}],"meta":"info"}',
            ),
        ).resolves.toBeUndefined();
    });

    // Row 15 — empty array. A BARE [] is a reject; the correct empty D
    // ({suggestions:[]}) is a happy recover, not a false reject.
    it('[15] bare empty array [] → undefined; empty-but-correct D recovers', async () => {
        await expect(repairAndValidate(reviewWire, '[]')).resolves.toBeUndefined();
        await expect(repairAndValidate(reviewWire, '{"suggestions":[]}')).resolves.toEqual({
            suggestions: [],
        });
    });

    // Row 18 — a primitive where an object is expected.
    it.each(['true', '0', '"ok"'])('[18] primitive %s → undefined', async (raw) => {
        await expect(repairAndValidate(reviewWire, raw)).resolves.toBeUndefined();
    });

    // Row 19 — provider envelope leak (raw chat-completions shape / tool_call args).
    it('[19] provider envelope leak {choices:[{message:{content}}]} → undefined', async () => {
        await expect(
            repairAndValidate(
                reviewWire,
                '{"choices":[{"message":{"content":"{\\"suggestions\\":[]}"}}]}',
            ),
        ).resolves.toBeUndefined();
    });

    // Row 20 — reasoning/thinking leak wrapping a CORRECT payload: the extractor
    // slices the balanced JSON out, so this RECOVERS rather than degrading.
    it('[20] thinking-leak prefix around a correct D is recovered', async () => {
        const raw =
            '<thinking>let me reason about the diff</thinking>\n{"suggestions":[{"id":"1","body":"x"}]}';
        await expect(repairAndValidate(reviewWire, raw)).resolves.toEqual({
            suggestions: [{ id: '1', body: 'x' }],
        });
    });
});

describe('MATRIX B — semantic-but-wrong (valid JSON, wrong value encoding)', () => {
    // Rows 21–23 — boolean encoded as string / yes-no / number → validation fails,
    // the boundary must reject rather than coerce a wrong truthy value onward.
    it('[21] boolean-as-string keep:"true"/"false" → undefined', async () => {
        await expect(repairAndValidate(keepWire, '{"keep":"true"}')).resolves.toBeUndefined();
        await expect(
            repairAndValidate(keepWire, '{"keep":"false"}'),
        ).resolves.toBeUndefined();
        // sanity: a real boolean recovers.
        await expect(repairAndValidate(keepWire, '{"keep":true}')).resolves.toEqual({
            keep: true,
        });
    });
    it('[22] boolean-as-yes/no keep:"yes"/"no" → undefined', async () => {
        await expect(repairAndValidate(keepWire, '{"keep":"yes"}')).resolves.toBeUndefined();
        await expect(repairAndValidate(keepWire, '{"keep":"no"}')).resolves.toBeUndefined();
    });
    it('[23] boolean-as-number keep:1/0 → undefined', async () => {
        await expect(repairAndValidate(keepWire, '{"keep":1}')).resolves.toBeUndefined();
        await expect(repairAndValidate(keepWire, '{"keep":0}')).resolves.toBeUndefined();
    });

    // Row 24 — enum out of the allowed set.
    it('[24] enum out of set (severity:"URGENT") → undefined; in-set recovers', async () => {
        await expect(
            repairAndValidate(severityWire, '{"severity":"URGENT"}'),
        ).resolves.toBeUndefined();
        await expect(
            repairAndValidate(severityWire, '{"severity":"HIGH"}'),
        ).resolves.toEqual({ severity: 'HIGH' });
    });

    // Row 26 — duplicate object keys resolve last-wins deterministically (JSON
    // spec / V8) and the surviving value still validates → recovered, not crashed.
    it('[26] duplicate object keys resolve last-wins, deterministically', async () => {
        const raw =
            '{"suggestions":[{"id":"1","body":"first"}],"suggestions":[{"id":"2","body":"last"}]}';
        await expect(repairAndValidate(reviewWire, raw)).resolves.toEqual({
            suggestions: [{ id: '2', body: 'last' }],
        });
    });

    // Row 27 — unicode / escaped newlines / emoji inside string fields survive
    // extraction+validation byte-exact.
    it('[27] unicode / escaped newline / emoji in a field is preserved exactly', async () => {
        const good = { suggestions: [{ id: '1', body: 'fix 🚀 café\nline-2 — dash' }] };
        await expect(repairAndValidate(reviewWire, JSON.stringify(good))).resolves.toEqual(
            good,
        );
    });
});

describe('MATRIX C — unparseable / transport (the fail-safe layer)', () => {
    // Row 28 — truncated mid-object JSON: no balanced close → does not parse →
    // documented fallback (undefined), never a throw past the boundary.
    it('[28] truncated JSON (max_tokens mid-object) → undefined, no throw', async () => {
        await expect(
            repairAndValidate(reviewWire, '{"suggestions":[{"id":"1","body":"fi'),
        ).resolves.toBeUndefined();
    });

    // Row 29 — malformed JSON. Trailing comma is deterministically repairable;
    // single-quoted and unquoted-key JSON are not string-surgery-fixable → reject.
    it('[29] trailing comma is repaired; single-quote/unquoted-key JSON → undefined', async () => {
        await expect(
            repairAndValidate(reviewWire, '{"suggestions":[{"id":"1","body":"x"},]}'),
        ).resolves.toEqual({ suggestions: [{ id: '1', body: 'x' }] });
        await expect(
            repairAndValidate(reviewWire, "{'suggestions':[]}"),
        ).resolves.toBeUndefined();
        await expect(
            repairAndValidate(reviewWire, '{suggestions:[]}'),
        ).resolves.toBeUndefined();
    });

    // Row 30 — the model call threw (network/timeout): the salvage entry point
    // fails safe (undefined) instead of crashing the stage; gate helpers likewise
    // never throw (pinned in Layer 3). A non-SDK error is not salvageable.
    it('[30] a thrown transport error is not salvaged and does not crash', async () => {
        await expect(
            salvageStructuredError(new Error('ETIMEDOUT socket hang up'), reviewWire),
        ).resolves.toBeUndefined();
        await expect(
            salvageStructuredError('a bare string error', reviewWire),
        ).resolves.toBeUndefined();
    });

    // Row 31 — an {error:…} object returned in place of D.
    it('[31] error-object payload {error:…} → undefined', async () => {
        await expect(
            repairAndValidate(reviewWire, '{"error":"rate limited","code":429}'),
        ).resolves.toBeUndefined();
    });

    // Row 32 — empty success (content:'' / finish_reason:'length'): no JSON →
    // undefined, both through the primary parser and the salvage path.
    it('[32] empty success (empty/whitespace content) → undefined', async () => {
        await expect(repairAndValidate(reviewWire, '')).resolves.toBeUndefined();
        await expect(repairAndValidate(reviewWire, '   \n\t ')).resolves.toBeUndefined();
        const emptyErr = new NoObjectGeneratedError({
            message: 'no object',
            cause: new JSONParseError({ text: '', cause: new Error('empty') }),
            text: '',
            response: undefined as any,
            usage: undefined as any,
            finishReason: 'length' as any,
        });
        await expect(salvageStructuredError(emptyErr, reviewWire)).resolves.toBeUndefined();
    });

    // Row 33 — a refusal in prose (content_filter / "I cannot help").
    it('[33] refusal prose (no JSON) → undefined', async () => {
        await expect(
            repairAndValidate(
                reviewWire,
                "I'm sorry, but I cannot help with that request.",
            ),
        ).resolves.toBeUndefined();
    });
});

describe('MATRIX D — input variants (the applicable, non-batch rows)', () => {
    // Row 35 — empty input: empty model string → SAFE fallback; empty text →
    // undefined (re-asserted here for the input dimension).
    it('[35] empty input: empty model → false; empty text → undefined', async () => {
        expect(openRouterHonorsJsonSchema('')).toBe(false);
        expect(openAiCompatibleUsesJsonSchema('', undefined)).toBe(false);
        await expect(repairAndValidate(reviewWire, '')).resolves.toBeUndefined();
    });

    // Row 36 — single item: one model id, one suggestion.
    it('[36] single item: one model decides; one-suggestion D recovers', async () => {
        expect(openRouterHonorsJsonSchema('openai/gpt-5')).toBe(true);
        await expect(
            repairAndValidate(reviewWire, '{"suggestions":[{"id":"1","body":"only"}]}'),
        ).resolves.toEqual({ suggestions: [{ id: '1', body: 'only' }] });
    });

    // Row 38 — duplicate items in the input must NOT be silently dropped by the
    // parse boundary (dedup is a downstream concern; the boundary preserves them).
    it('[38] duplicate items in D are preserved, not dropped', async () => {
        const dup = {
            suggestions: [
                { id: '1', body: 'x' },
                { id: '1', body: 'x' },
            ],
        };
        await expect(repairAndValidate(reviewWire, JSON.stringify(dup))).resolves.toEqual(
            dup,
        );
    });

    // Row 39 — a required field is null/undefined.
    it('[39] item with a null required field → undefined', async () => {
        await expect(
            repairAndValidate(reviewWire, '{"suggestions":[{"id":null,"body":"x"}]}'),
        ).resolves.toBeUndefined();
    });

    // Row 40 — special chars / whitespace-only / control-char-heavy input.
    it('[40] whitespace-only → undefined; heavy special chars in a field recover', async () => {
        await expect(repairAndValidate(reviewWire, '\n\t   \r\n')).resolves.toBeUndefined();
        const special = {
            suggestions: [{ id: 'a/b\\c', body: 'tabs\tand "quotes" and </xml> & %s' }],
        };
        await expect(
            repairAndValidate(reviewWire, JSON.stringify(special)),
        ).resolves.toEqual(special);
    });

    // Row 42 — order permutation → equivalent decision. The gate decision is
    // independent of prefix-list order / model casing; JSON key order does not
    // change the validated result.
    it('[42] gate decision is order/casing invariant', () => {
        expect(openRouterHonorsJsonSchema('OpenAI/GPT-5')).toBe(
            openRouterHonorsJsonSchema('openai/gpt-5'),
        );
        expect(openRouterHonorsJsonSchema('google/gemini-3')).toBe(
            openRouterHonorsJsonSchema('anthropic/claude-opus-5'),
        );
    });
    it('[42] JSON key order does not change the validated result', async () => {
        await expect(
            repairAndValidate(reviewWire, '{"suggestions":[{"body":"x","id":"1"}]}'),
        ).resolves.toEqual({ suggestions: [{ id: '1', body: 'x' }] });
    });
});

describe('MATRIX E — off-schema zoo under BOTH policy branches', () => {
    // The gate BRANCHES per model; the parse guard does NOT. So the invariant is:
    // (1) strict-json_schema models are trusted to receive the schema (decision
    // true), while (2) json_object-fallback models get false — and the SAME
    // deterministic guard (repairAndValidate) protects the output regardless, so
    // even a "strict" upstream that lies is caught by exactly the same rejection.
    const strictModels = [
        'openai/gpt-5',
        'anthropic/claude-opus-5',
        'google/gemini-3-pro',
        'moonshotai/kimi-k2',
    ];
    const fallbackModels = [
        'deepseek/deepseek-chat',
        'z-ai/glm-4.6',
        'x-ai/grok-4',
        'some-new-vendor/model-v1',
    ];

    it('[E] strict branch trusts (true), fallback branch guards (false)', () => {
        expect(strictModels.map(openRouterUsesJsonSchema)).toEqual([
            true, true, true, true,
        ]);
        expect(fallbackModels.map(openRouterUsesJsonSchema)).toEqual([
            false, false, false, false,
        ]);
    });

    // A representative A/B/C off-schema row run through the guard — the guard is
    // branch-independent, so an off-schema envelope is rejected identically no
    // matter which model would have produced it.
    const zoo: Array<[string, string]> = [
        ['A2 bare array', '[{"id":"1","body":"x"}]'],
        ['A10 wrong key', '{"items":[{"id":"1","body":"x"}]}'],
        ['B24-ish wrong item keys', '{"suggestions":[{"id":"1","comment":"x"}]}'],
        ['C31 error object', '{"error":"boom"}'],
    ];
    it.each(zoo)(
        '[E] off-schema %s is rejected by the shared guard (both branches)',
        async (_l, raw) => {
            await expect(repairAndValidate(reviewWire, raw)).resolves.toBeUndefined();
        },
    );
});

describe('#1786 KNOWN DEGRADATION — fallback ships an unvalidated off-schema object', () => {
    // When ensureValidatingSchema CANNOT attach a validator (uncompilable body →
    // ajv returns null → the wire is returned as-is with NO validate fn), the
    // json_object fallback's repairAndValidate parses and returns the object
    // WITHOUT checking its shape. That is the literal #1786 mechanism: a wrong
    // envelope flows on as valid. The CORRECT contract is to reject (undefined)
    // and escalate. This is currently degrading, so it is pinned with it.failing:
    // it stays green today and flips to a real failure the day the fallback
    // refuses to emit an unvalidated object.
    const unguardable = ensureValidatingSchema(
        jsonSchema({ type: 'not-a-real-type' } as any),
    );

    it.failing(
        'a fallback with an unvalidatable wire schema must NOT return an off-schema object',
        async () => {
            const offSchema = '{"items":[{"id":"1"}]}';
            await expect(
                repairAndValidate(unguardable, offSchema),
            ).resolves.toBeUndefined();
        },
    );
});
