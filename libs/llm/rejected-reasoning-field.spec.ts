jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { z } from 'zod';

import { LLM } from './llm';
import {
    clearRefusals,
    MAX_REFUSAL_RETRIES,
    REFUSAL_MEMORY_MS,
    rejectedReasoningField,
} from './rejected-reasoning-field';
import PROD_SHAPES from './testing/__fixtures__/byok-prod-shapes.json';
import './providers';

/** The body OpenCode Go returned in production (2026-09-30), verbatim. */
const refusalOf = (field: string) => ({
    error: {
        param: field,
        type: 'invalid_request_error',
        message: `Upstream request failed: [unknown_parameter] invalid request body: json: unknown field "${field}"`,
    },
});

const OK = {
    id: 'x',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
        {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
        },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

/**
 * A fake upstream. By default it answers 400 to any body carrying one of
 * `refuses`; `respond` replaces that rule entirely. Records every body.
 */
function upstream(opts: {
    refuses?: string[];
    respond?: (body: any, n: number) => unknown | undefined;
}) {
    const bodies: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: any, init: any) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        bodies.push(body);
        const errorBody = opts.respond
            ? opts.respond(body, bodies.length)
            : (() => {
                  const f = (opts.refuses ?? []).find((k) => body && k in body);
                  return f ? refusalOf(f) : undefined;
              })();
        return new Response(JSON.stringify(errorBody ?? OK), {
            status: errorBody ? 400 : 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;
    return { bodies, restore: () => (globalThis.fetch = realFetch) };
}

const run = (slot: any, organizationId = 'org-1') =>
    LLM.run({
        byokConfig: { ...slot, apiKey: 'k' },
        organizationId,
        messages: [{ role: 'user', content: 'ping' }],
        loop: { tools: {}, maxSteps: 1 },
        runName: 'rejected-reasoning-field-spec',
    } as any);

const runStructured = (slot: any) =>
    LLM.run({
        byokConfig: { ...slot, apiKey: 'k' },
        organizationId: 'org-1',
        user: 'ping',
        schema: z.object({ ok: z.boolean() }),
        runName: 'rejected-reasoning-field-spec',
    } as any);

// DeepSeek still takes `thinking` + `reasoning_effort` through the gateway.
const deepseek = {
    provider: 'openai_compatible',
    model: 'deepseek-v4-flash',
    baseURL: 'https://opencode.ai/zen/go/v1',
    reasoningEffort: 'high',
};

describe('a reasoning field the upstream refuses', () => {
    let up: ReturnType<typeof upstream> | undefined;
    afterEach(() => {
        up?.restore();
        up = undefined;
        clearRefusals();
        jest.useRealTimers();
    });

    it('is dropped and the call is asked once more', async () => {
        up = upstream({ refuses: ['thinking'] });
        await run(deepseek);
        expect(up.bodies).toHaveLength(2);
        expect(up.bodies[0].thinking).toEqual({ type: 'enabled' });
        expect(up.bodies[1].thinking).toBeUndefined();
        // Only the refused field goes: the effort the upstream did not refuse
        // still reaches it.
        expect(up.bodies[1].reasoning_effort).toBe('max');
    });

    it('is dropped on a structured call too', async () => {
        up = upstream({ refuses: ['thinking'] });
        OK.choices[0].message.content = '{"ok":true}';
        try {
            await runStructured(deepseek);
        } finally {
            OK.choices[0].message.content = 'ok';
        }
        expect(up.bodies).toHaveLength(2);
        expect(up.bodies[1].thinking).toBeUndefined();
    });

    it('is dropped one field at a time when the upstream refuses both', async () => {
        up = upstream({ refuses: ['thinking', 'reasoning_effort'] });
        await run(deepseek);
        // Go's decoder names the first unknown field only, so each costs one ask.
        expect(up.bodies).toHaveLength(3);
        expect(up.bodies[2].thinking).toBeUndefined();
        expect(up.bodies[2].reasoning_effort).toBeUndefined();
    });

    it('is not sent again to the same slot for a while, then tried again', async () => {
        up = upstream({ refuses: ['thinking'] });
        await run(deepseek);
        await run(deepseek);
        // Two calls, three requests: the second call did not pay the 400.
        expect(up.bodies).toHaveLength(3);
        expect(up.bodies[2].thinking).toBeUndefined();

        jest.useFakeTimers({
            now: Date.now() + REFUSAL_MEMORY_MS + 1,
            doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
        });
        await run(deepseek);
        expect(up.bodies[3].thinking).toEqual({ type: 'enabled' });
    });

    it('is remembered per slot, not per host', async () => {
        up = upstream({ refuses: ['thinking'] });
        await run(deepseek);
        up.restore();
        up = upstream({});
        await run({ ...deepseek, model: 'deepseek-v4-pro' });
        expect(up.bodies[0].thinking).toEqual({ type: 'enabled' });
    });

    it('is remembered per organization', async () => {
        up = upstream({ refuses: ['thinking'] });
        await run(deepseek, 'org-1');
        up.restore();
        up = upstream({});
        await run(deepseek, 'org-2');
        expect(up.bodies[0].thinking).toEqual({ type: 'enabled' });
    });

    it('costs at most one extra request per call when calls run at once', async () => {
        up = upstream({ refuses: ['thinking'] });
        await Promise.all(Array.from({ length: 8 }, () => run(deepseek)));
        // Every call that started before the first refusal pays one 400; none
        // pays two.
        expect(up.bodies.length).toBeLessThanOrEqual(16);
        expect(
            up.bodies.filter((b) => 'thinking' in b).length,
        ).toBeLessThanOrEqual(8);
    });
});

describe('what never triggers another request', () => {
    let up: ReturnType<typeof upstream> | undefined;
    afterEach(() => {
        up?.restore();
        up = undefined;
        clearRefusals();
    });

    it('an upstream that accepts the body: one request for every opencode slot in production', async () => {
        const slots = (PROD_SHAPES as any[]).filter((s) =>
            /opencode\.ai/.test(s.baseURL ?? ''),
        );
        expect(slots.length).toBeGreaterThan(0);
        for (const { orgs: _orgs, ...slot } of slots) {
            up = upstream({});
            await run(slot);
            expect({ model: slot.model, requests: up.bodies.length }).toEqual({
                model: slot.model,
                requests: 1,
            });
            up.restore();
        }
    });

    it('an upstream that keeps refusing the field after it is gone', async () => {
        // A gateway that answers the same refusal whatever it receives must not
        // turn into a loop: the field is gone, so there is nothing left to drop.
        up = upstream({ respond: () => refusalOf('thinking') });
        await expect(run(deepseek)).rejects.toBeDefined();
        expect(up.bodies).toHaveLength(2);
    });

    it('an upstream that names a different reasoning field every time', async () => {
        up = upstream({
            respond: (_b, n) =>
                refusalOf(n % 2 ? 'thinking' : 'reasoning_effort'),
        });
        await expect(run(deepseek)).rejects.toBeDefined();
        // One ask per field we could add, then the error reaches the caller.
        expect(up.bodies).toHaveLength(1 + MAX_REFUSAL_RETRIES);
    });

    it('a refusal of a field we did not send', async () => {
        // MiMo gets no reasoning field at all, so a refusal naming one cannot be
        // about our body: repeating the call would send the same thing.
        up = upstream({ respond: () => refusalOf('thinking') });
        await expect(
            run({
                provider: 'openai_compatible',
                model: 'mimo-v2.5',
                baseURL: 'https://opencode.ai/zen/go/v1',
                reasoningEffort: 'high',
            }),
        ).rejects.toBeDefined();
        expect(up.bodies).toHaveLength(1);
    });

    it('a 400 about anything else', async () => {
        up = upstream({
            respond: () => ({
                error: {
                    type: 'invalid_request_error',
                    message:
                        'invalid request body: json: unknown field "agent"',
                },
            }),
        });
        await expect(run(deepseek)).rejects.toBeDefined();
        expect(up.bodies).toHaveLength(1);
    });

    it('a 400 about the value of a reasoning field', async () => {
        // The field is known and its value is wrong: that is the user's
        // configuration, and dropping it would hide the error.
        up = upstream({
            respond: () => ({
                error: {
                    param: 'reasoning_effort',
                    type: 'invalid_request_error',
                    message:
                        "Unsupported value: 'reasoning_effort' does not support 'max' with this model.",
                },
            }),
        });
        await expect(run(deepseek)).rejects.toBeDefined();
        expect(up.bodies).toHaveLength(1);
    });
});

describe('rejectedReasoningField', () => {
    const SENT = {
        model: 'm',
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
    };
    const apiError = (
        status: number,
        responseBody: string,
        requestBodyValues: unknown = SENT,
    ) =>
        Object.assign(new Error('Bad Request'), {
            statusCode: status,
            responseBody,
            requestBodyValues,
        });

    it.each([
        [
            'Go decoder',
            'invalid request body: json: unknown field "thinking"',
            'thinking',
        ],
        [
            'pydantic',
            "Extra inputs are not permitted, field: 'reasoning_effort', value: 'high'",
            'reasoning_effort',
        ],
        [
            'OpenAI unknown argument',
            'Unrecognized request argument supplied: reasoning_effort',
            'reasoning_effort',
        ],
    ])('reads the field from a %s refusal', (_k, body, field) => {
        expect(rejectedReasoningField(apiError(400, body))).toBe(field);
    });

    it('ignores an envelope that only names the field', () => {
        expect(
            rejectedReasoningField(
                apiError(400, '{"error":{"param":"thinking","message":"bad"}}'),
            ),
        ).toBeUndefined();
    });

    it('ignores a refusal of a field the request did not carry', () => {
        expect(
            rejectedReasoningField(
                apiError(400, 'json: unknown field "reasoning_effort"', {
                    model: 'm',
                    reasoning: { effort: 'high' },
                }),
            ),
        ).toBeUndefined();
    });

    it('ignores a field the SDK recorded as undefined, which never reached the wire', () => {
        expect(
            rejectedReasoningField(
                apiError(400, 'json: unknown field "reasoning_effort"', {
                    model: 'm',
                    reasoning_effort: undefined,
                }),
            ),
        ).toBeUndefined();
    });

    it('ignores a refusal whose error does not say what was sent', () => {
        expect(
            rejectedReasoningField(
                apiError(400, 'json: unknown field "thinking"', null),
            ),
        ).toBeUndefined();
    });

    it('reads the sent body from the last attempt of a retry error', () => {
        const last = apiError(400, 'json: unknown field "thinking"');
        expect(
            rejectedReasoningField(
                Object.assign(new Error('Failed after 3 attempts'), {
                    name: 'AI_RetryError',
                    lastError: last,
                }),
            ),
        ).toBe('thinking');
    });

    it('ignores the same words on a status that is not a refusal', () => {
        expect(
            rejectedReasoningField(
                apiError(500, 'json: unknown field "thinking"'),
            ),
        ).toBeUndefined();
    });
});
