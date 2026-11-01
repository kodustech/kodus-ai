import { jsonSchema } from 'ai';
import {
    openRouterHonorsJsonSchema,
    openAiCompatibleHonorsJsonSchema,
    isNeverDowngradeModel,
} from './structured-output-gate';
import {
    ensureValidatingSchema,
    repairAndValidate,
} from './structured-output-repair';

describe('openRouterHonorsJsonSchema', () => {
    it('enables for known schema-honoring prefixes', () => {
        expect(openRouterHonorsJsonSchema('openai/gpt-5')).toBe(true);
        expect(openRouterHonorsJsonSchema('anthropic/claude-opus-5')).toBe(true);
        expect(openRouterHonorsJsonSchema('google/gemini-3')).toBe(true);
        expect(openRouterHonorsJsonSchema('moonshotai/kimi-k2')).toBe(true);
        // case-insensitive on the id
        expect(openRouterHonorsJsonSchema('OpenAI/GPT-5')).toBe(true);
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

describe('#1786 fallback decision — N-model robustness (Layer 2a)', () => {
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
            'the right data under the WRONG key (items not suggestions)',
            '{"items":[{"id":"1","body":"x"}]}',
        ],
        [
            'right container, wrong item keys (comment not body)',
            '{"suggestions":[{"id":"1","comment":"x"}]}',
        ],
        ['a partial object (missing required body)', '{"suggestions":[{"id":"1"}]}'],
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

describe('a code block quoted before the answer does not hide the answer', () => {
    const answer = { suggestions: [{ id: '3', body: 'ok' }] };

    it.each([
        [
            'a labeled non-JSON block, then bare JSON',
            'The credential is read here:\n```ruby\n[ENV["KEY"] || "x"]\n```\n' +
                JSON.stringify(answer),
        ],
        [
            'an unlabeled block holding {}, then bare JSON',
            'The call looks like:\n```\n{}\n```\n' + JSON.stringify(answer),
        ],
        [
            'a labeled block, then a ```json block',
            'Quoting the code:\n```ts\nconst a = { b: 1 };\n```\n```json\n' +
                JSON.stringify(answer) +
                '\n```',
        ],
    ])('recovers the answer after %s', async (_label, raw) => {
        await expect(repairAndValidate(reviewWire, raw)).resolves.toEqual(answer);
    });

    it('keeps Markdown fences that sit inside the string values of a bare answer', async () => {
        const withCode = {
            suggestions: [
                { id: '4', body: 'use:\n```ts\nconst a = 1;\n```\ninstead' },
            ],
        };
        const raw =
            'The call looks like:\n```\n{}\n```\n' + JSON.stringify(withCode);
        await expect(repairAndValidate(reviewWire, raw)).resolves.toEqual(
            withCode,
        );
    });

    it('prefers the bare answer after the quotes over a schema-valid example quoted earlier', async () => {
        const example = { suggestions: [{ id: '0', body: 'example' }] };
        const raw =
            'Not JSON:\n```\nfoo\n```\nExample:\n```json\n' +
            JSON.stringify(example) +
            '\n```\n' +
            JSON.stringify(answer);
        await expect(repairAndValidate(reviewWire, raw)).resolves.toEqual(answer);
    });

    it('does not take a schema-valid example from the reasoning as the answer', async () => {
        const example = { suggestions: [{ id: '0', body: 'example' }] };
        const raw =
            '<think>Output looks like:\n```json\n' +
            JSON.stringify(example) +
            '\n```\n</think>\nNo findings.';
        await expect(repairAndValidate(reviewWire, raw)).resolves.toBeUndefined();
    });

    it('still rejects text whose only JSON is off-schema', async () => {
        const raw = 'See:\n```\n{}\n```\n{"items":[{"id":"1","body":"x"}]}';
        await expect(repairAndValidate(reviewWire, raw)).resolves.toBeUndefined();
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
