/**
 * #2384 — prose recovery failed whenever the model answered `null`.
 *
 * LLM.run sends every field of a zod schema to a strict provider as
 * required-or-null and reads a `null` back as absent before the schema parses
 * (strict-wire-schema.ts). The recovery schemas declared their fields
 * `.nullable()`, which requires the key: an answer with `"label": null` (the
 * way DeepSeek V4.1 Flash, GLM 5.3, GPT-6 and Kimi K2.7 Code answered in
 * production) failed the schema, the structured call asked the model again,
 * failed the same way, and only the lenient read in the catch kept the items.
 *
 * Runs the real stack (recoverFindingsFromProse → LLM.run → provider module →
 * AI SDK) and stops at fetch, as json-object-contract.spec.ts does.
 */
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { recoverFindingsFromProse } from './finder.agent';

const PROSE =
    'Reviewed the change. src/billing/total.ts line 12 sums amounts as floats, which is incorrect because it loses cents; it should sum integer cents instead.';

function answering(body: unknown) {
    const requests: any[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_input: any, init: any) => {
        requests.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return new Response(
            JSON.stringify({
                id: 'x',
                object: 'chat.completion',
                created: 1,
                model: 'm',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: JSON.stringify(body),
                        },
                        finish_reason: 'stop',
                    },
                ],
                usage: {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    total_tokens: 2,
                },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;
    return { requests, restore: () => (globalThis.fetch = real) };
}

const ROUTES = [
    {
        id: 'open_router / z-ai/glm-5.3 (json_object)',
        slot: { apiKey: 'k', provider: 'open_router', model: 'z-ai/glm-5.3' },
    },
    {
        id: 'openai_compatible / kimi-k2.7-code',
        slot: {
            apiKey: 'k',
            provider: 'openai_compatible',
            model: 'kimi-k2.7-code',
            baseURL: 'https://llm.example.test/v1',
        },
    },
];

describe('#2384 — prose recovery reads a null field as absent', () => {
    for (const route of ROUTES) {
        it(`lean recovery, one call: ${route.id}`, async () => {
            const wire = answering({
                suggestions: [
                    {
                        relevantFile: 'src/billing/total.ts',
                        suggestionContent:
                            'Sums amounts as floats and loses cents.',
                        label: null,
                        relevantLinesStart: null,
                        relevantLinesEnd: null,
                    },
                ],
            });
            try {
                const out = await recoverFindingsFromProse(
                    PROSE,
                    route.slot as any,
                    'org',
                    'code-review-generalist',
                );

                expect(wire.requests).toHaveLength(1);
                expect(out).toHaveLength(1);
                expect(out[0].relevantFile).toBe('src/billing/total.ts');
                expect(out[0].label ?? undefined).toBeUndefined();
            } finally {
                wire.restore();
            }
        });

        it(`full recovery (custom agent), one call: ${route.id}`, async () => {
            const wire = answering({
                suggestions: [
                    {
                        relevantFile: 'src/billing/total.ts',
                        suggestionContent:
                            'Sums amounts as floats and loses cents.',
                        existingCode: 'total += amount',
                        improvedCode: 'totalCents += amountCents',
                        language: 'typescript',
                        label: 'bug',
                        oneSentenceSummary: 'Float sum loses cents',
                        relevantLinesStart: null,
                        relevantLinesEnd: null,
                        severity: 'high',
                        confidence: null,
                    },
                ],
            });
            try {
                const out = await recoverFindingsFromProse(
                    PROSE,
                    route.slot as any,
                    'org',
                    'code-review-custom-billing',
                    undefined,
                    undefined,
                    true,
                    ['src/billing/total.ts'],
                );

                expect(wire.requests).toHaveLength(1);
                expect(out).toHaveLength(1);
                expect(out[0].improvedCode).toBe('totalCents += amountCents');
            } finally {
                wire.restore();
            }
        });
    }

    it('a strict json_schema route still declares every recovery field, null allowed', async () => {
        const wire = answering({ suggestions: [] });
        try {
            await recoverFindingsFromProse(
                PROSE,
                {
                    apiKey: 'k',
                    provider: 'openai_compatible',
                    model: 'kimi-k2.7-code',
                    baseURL: 'https://llm.example.test/v1',
                } as any,
                'org',
                'code-review-generalist',
            );
            // openai_compatible sends the schema itself first (json_schema):
            // the one route where a strict provider reads every field.
            expect(wire.requests).toHaveLength(1);
            const schema =
                wire.requests[0].response_format?.json_schema?.schema;
            expect(schema).toBeDefined();
            const item = schema.properties.suggestions.items;
            expect(item.required).toEqual(
                expect.arrayContaining([
                    'label',
                    'relevantLinesStart',
                    'relevantLinesEnd',
                ]),
            );
            expect(JSON.stringify(item.properties.label)).toContain('null');
        } finally {
            wire.restore();
        }
    });
});
