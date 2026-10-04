jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { z } from 'zod';

import { LLM } from './llm';
import {
    clearRefusals,
    MAX_REFUSAL_RETRIES,
    type ReasoningField,
} from './rejected-reasoning-field';
import PROD_SHAPES from './testing/__fixtures__/byok-prod-shapes.json';
import './providers';

/**
 * Every stored production slot, every protocol we speak, both executors, run
 * against an upstream that refuses a reasoning field in each way we know of.
 *
 * The oracle is the request itself, never a list of models: a call may be
 * asked again only when the refused field was a top-level key of the body that
 * went out, the retry may differ from it by that field and nothing else, and an
 * upstream that accepts the body costs exactly one request.
 */

const FIELDS: ReasoningField[] = ['thinking', 'reasoning_effort'];
const SCHEMA = z.object({ ok: z.boolean() });

const SLOTS = (PROD_SHAPES as any[])
    // Vertex needs a service-account token exchange before the model call.
    .filter((s) => s.provider !== 'google_vertex')
    .map(({ orgs: _orgs, ...slot }, i) => ({ ...slot, __i: i }));

type Mode = 'loop' | 'structured';
const MODES: Mode[] = ['loop', 'structured'];

const label = (slot: any, mode: Mode) =>
    `#${slot.__i} ${slot.provider} | ${slot.model} | ${slot.baseURL ?? '-'} | effort=${slot.reasoningEffort ?? '-'} | ${mode}`;

// ---------------------------------------------------------------------------
// A valid answer in each protocol, so an accepted body really is ONE request:
// an answer the SDK cannot parse would set off its own recovery and blur the
// count this spec is about.

function okFor(url: string, body: any, mode: Mode): unknown {
    const text = mode === 'structured' ? '{"ok":true}' : 'ok';
    const input = { ok: true };

    if (/\/converse\b/.test(url)) {
        const tool =
            body?.toolConfig?.toolChoice &&
            body.toolConfig.tools?.[0]?.toolSpec?.name;
        return {
            output: {
                message: {
                    role: 'assistant',
                    content: tool
                        ? [{ toolUse: { toolUseId: 't', name: tool, input } }]
                        : [{ text }],
                },
            },
            stopReason: tool ? 'tool_use' : 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            metrics: { latencyMs: 1 },
        };
    }
    if (/\/responses\b/.test(url)) {
        return {
            id: 'r',
            object: 'response',
            created_at: 0,
            model: 'm',
            status: 'completed',
            output: [
                {
                    type: 'message',
                    id: 'm',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text, annotations: [] }],
                },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
    }
    if (/generateContent/.test(url)) {
        return {
            candidates: [
                {
                    content: { parts: [{ text }], role: 'model' },
                    finishReason: 'STOP',
                },
            ],
            usageMetadata: {
                promptTokenCount: 1,
                candidatesTokenCount: 1,
                totalTokenCount: 2,
            },
        };
    }
    if (/\/messages\b/.test(url)) {
        const forced =
            body?.tool_choice &&
            ['any', 'tool'].includes(body.tool_choice.type) &&
            body.tools?.[0]?.name;
        return {
            id: 'a',
            type: 'message',
            role: 'assistant',
            model: 'm',
            content: forced
                ? [{ type: 'tool_use', id: 't', name: forced, input }]
                : [{ type: 'text', text }],
            stop_reason: forced ? 'tool_use' : 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
        };
    }
    const forced =
        body?.tool_choice && body.tool_choice !== 'auto' && body.tools?.length
            ? (body.tool_choice.function?.name ?? body.tools[0].function.name)
            : undefined;
    return {
        id: 'c',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [
            {
                index: 0,
                message: forced
                    ? {
                          role: 'assistant',
                          content: null,
                          tool_calls: [
                              {
                                  id: 't',
                                  type: 'function',
                                  function: {
                                      name: forced,
                                      arguments: JSON.stringify(input),
                                  },
                              },
                          ],
                      }
                    : { role: 'assistant', content: text },
                finish_reason: forced ? 'tool_calls' : 'stop',
            },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
}

// ---------------------------------------------------------------------------
// Refusals, in the wordings production and the gateways' own trackers show.

/** OpenCode Go, verbatim from production (2026-09-30). */
const goRefusal = (field: string) => ({
    error: {
        param: field,
        type: 'invalid_request_error',
        message: `Upstream request failed: [unknown_parameter] invalid request body: json: unknown field "${field}"`,
    },
});
/** pydantic extra="forbid" (sst/opencode#43089). */
const pydanticRefusal = (field: string) => ({
    error: {
        type: 'invalid_request_error',
        message: `Error from provider (Console Go): Extra inputs are not permitted, field: '${field}', value: 'x'`,
    },
});
/** OpenAI's wording for an argument it does not know. */
const openAiRefusal = (field: string) => ({
    error: {
        type: 'invalid_request_error',
        message: `Unrecognized request argument supplied: ${field}`,
    },
});
const WORDINGS = {
    go: goRefusal,
    pydantic: pydanticRefusal,
    openai: openAiRefusal,
};

type Responder = (body: any, n: number) => unknown | undefined;

interface Outcome {
    bodies: any[];
    rejected: boolean;
}

async function call(
    slot: any,
    mode: Mode,
    respond: Responder,
    organizationId = 'org-matrix',
): Promise<Outcome> {
    const bodies: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
        const url =
            typeof input === 'string' ? input : String(input?.url ?? input);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        bodies.push(body);
        const error = respond(body, bodies.length);
        return new Response(JSON.stringify(error ?? okFor(url, body, mode)), {
            status: error ? 400 : 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;
    let rejected = false;
    try {
        await LLM.run({
            byokConfig: { ...without(slot, ['__i']), apiKey: 'k' },
            organizationId,
            runName: 'rejected-reasoning-field-matrix',
            ...(mode === 'structured'
                ? { user: 'ping', schema: SCHEMA }
                : {
                      messages: [{ role: 'user', content: 'ping' }],
                      loop: { tools: {}, maxSteps: 1 },
                  }),
        } as any);
    } catch {
        rejected = true;
    } finally {
        globalThis.fetch = realFetch;
    }
    return { bodies, rejected };
}

const has = (body: any, field: string) =>
    !!body && typeof body === 'object' && body[field] !== undefined;

/**
 * Keys the SDK itself derives from `thinking`: the Anthropic adapters add the
 * thinking budget to `max_tokens` and drop sampling while thinking, so a body
 * without `thinking` legitimately carries a smaller `max_tokens` and its
 * `temperature` back. Anything else changing is a defect of the retry.
 */
const DERIVED_FROM: Record<string, string[]> = {
    thinking: ['max_tokens', 'temperature', 'top_p', 'top_k'],
    reasoning_effort: [],
};

/** Top-level keys whose value differs between two bodies. */
const changedKeys = (a: any, b: any) =>
    [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter(
        (k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]),
    );

/** Why the retry body is wrong, if it is: it may only lose `dropped` and the
 *  keys the SDK derives from them. */
const retryProblem = (first: any, retry: any, dropped: string[]) => {
    const allowed = new Set(dropped.flatMap((f) => [f, ...DERIVED_FROM[f]]));
    const stray = changedKeys(first, retry).filter((k) => !allowed.has(k));
    if (stray.length) return `the retry also changed ${stray.join(', ')}`;
    const kept = dropped.filter((f) => has(retry, f));
    if (kept.length) return `the retry still sent ${kept.join(', ')}`;
    return undefined;
};

const without = (body: any, fields: string[]) => {
    const copy = { ...body };
    for (const f of fields) delete copy[f];
    return copy;
};

/** Refuse `fields` whenever one of them is in the body, first one first. */
const refusing =
    (
        fields: string[],
        wording: (field: string) => unknown = goRefusal,
    ): Responder =>
    (body) => {
        const f = fields.find((x) => has(body, x));
        return f ? wording(f) : undefined;
    };

/** Run `check` for every slot and mode; collect what broke instead of stopping
 *  at the first, so one red run names every model it broke. */
async function everySlot(
    check: (slot: any, mode: Mode) => Promise<string | undefined>,
): Promise<string[]> {
    const broken: string[] = [];
    for (const slot of SLOTS) {
        for (const mode of MODES) {
            clearRefusals();
            const problem = await check(slot, mode);
            if (problem) broken.push(`${label(slot, mode)} :: ${problem}`);
        }
    }
    clearRefusals();
    return broken;
}

/** What each slot sends with nothing refused, computed once. */
const firstBodies = new Map<string, any>();
async function firstBody(slot: any, mode: Mode) {
    const key = label(slot, mode);
    if (!firstBodies.has(key)) {
        const { bodies } = await call(slot, mode, () => undefined);
        firstBodies.set(key, bodies[0]);
    }
    return firstBodies.get(key);
}

const MATRIX_TIMEOUT = 600000;

describe('reasoning-field refusals — every production slot × protocol × executor', () => {
    afterEach(() => clearRefusals());

    it(
        'covers the corpus it claims to',
        async () => {
            // A filter that silently emptied the corpus would make every check below
            // a green assertion over nothing.
            expect(SLOTS.length).toBeGreaterThan(250);
            const providers = new Set(SLOTS.map((s) => s.provider));
            for (const p of [
                'openai_compatible',
                'open_router',
                'openai',
                'anthropic',
                'anthropic_compatible',
                'google_gemini',
                'amazon_bedrock',
                'novita',
            ]) {
                expect(providers).toContain(p);
            }

            // The retry path is exercised on real shapes, not just on a fixture:
            // count the slots that actually send each field.
            const sending: Record<string, number> = {};
            for (const slot of SLOTS) {
                for (const mode of MODES) {
                    const body = await firstBody(slot, mode);
                    for (const f of FIELDS) {
                        if (has(body, f)) sending[f] = (sending[f] ?? 0) + 1;
                    }
                }
            }
            expect(sending.thinking).toBeGreaterThan(20);
            expect(sending.reasoning_effort).toBeGreaterThan(20);
        },
        MATRIX_TIMEOUT,
    );

    it(
        'an upstream that accepts the body costs exactly one request',
        async () => {
            const broken = await everySlot(async (slot, mode) => {
                const { bodies, rejected } = await call(
                    slot,
                    mode,
                    () => undefined,
                );
                if (rejected) return 'the call failed';
                if (bodies.length !== 1) return `${bodies.length} requests`;
            });
            expect(broken).toEqual([]);
        },
        MATRIX_TIMEOUT,
    );

    for (const [name, wording] of Object.entries(WORDINGS)) {
        for (const field of FIELDS) {
            it(
                `a ${name}-worded refusal of \`${field}\` is retried only when the body carried it, and only without it`,
                async () => {
                    const broken = await everySlot(async (slot, mode) => {
                        const sent = await firstBody(slot, mode);
                        const { bodies, rejected } = await call(
                            slot,
                            mode,
                            refusing([field], wording),
                        );
                        if (!has(sent, field)) {
                            // Nothing of ours to drop: the upstream never refuses,
                            // so this is the accepted path and must stay one call.
                            if (bodies.length !== 1)
                                return `${bodies.length} requests`;
                            return rejected ? 'the call failed' : undefined;
                        }
                        if (bodies.length !== 2)
                            return `${bodies.length} requests`;
                        if (rejected) return 'the retry failed';
                        return retryProblem(bodies[0], bodies[1], [field]);
                    });
                    expect(broken).toEqual([]);
                },
                MATRIX_TIMEOUT,
            );
        }
    }

    it(
        'an upstream that refuses both fields costs one request per field it refuses',
        async () => {
            const broken = await everySlot(async (slot, mode) => {
                const sent = await firstBody(slot, mode);
                const present = FIELDS.filter((f) => has(sent, f));
                const { bodies, rejected } = await call(
                    slot,
                    mode,
                    refusing(FIELDS),
                );
                if (bodies.length !== 1 + present.length)
                    return `${bodies.length} requests for ${present.length} field(s)`;
                if (rejected) return 'the call failed';
                return retryProblem(bodies[0], bodies.at(-1), present);
            });
            expect(broken).toEqual([]);
        },
        MATRIX_TIMEOUT,
    );

    it(
        'an upstream that refuses whatever it receives cannot make a loop',
        async () => {
            for (const field of FIELDS) {
                const broken = await everySlot(async (slot, mode) => {
                    const sent = await firstBody(slot, mode);
                    const { bodies, rejected } = await call(slot, mode, () =>
                        goRefusal(field),
                    );
                    if (!rejected) return 'a permanent refusal was swallowed';
                    const expected = has(sent, field) ? 2 : 1;
                    if (bodies.length !== expected)
                        return `${bodies.length} requests, expected ${expected} (${field})`;
                });
                expect(broken).toEqual([]);
            }
        },
        MATRIX_TIMEOUT,
    );

    it(
        'an upstream that names a different field every time stops at the cap',
        async () => {
            const broken = await everySlot(async (slot, mode) => {
                const { bodies, rejected } = await call(slot, mode, (_b, n) =>
                    goRefusal(FIELDS[(n - 1) % FIELDS.length]),
                );
                if (!rejected) return 'a permanent refusal was swallowed';
                if (bodies.length > 1 + MAX_REFUSAL_RETRIES)
                    return `${bodies.length} requests`;
            });
            expect(broken).toEqual([]);
        },
        MATRIX_TIMEOUT,
    );

    it(
        'a 400 about anything but a reasoning field is never asked again',
        async () => {
            const others: Record<string, unknown> = {
                'unknown field of a client': goRefusal('agent'),
                'extra input of a client': pydanticRefusal('__managed_by'),
                'the value of a reasoning field': {
                    error: {
                        param: 'reasoning_effort',
                        type: 'invalid_request_error',
                        message:
                            "Unsupported value: 'reasoning_effort' does not support 'max' with this model.",
                    },
                },
                'a thinking budget': {
                    type: 'error',
                    error: {
                        type: 'invalid_request_error',
                        message:
                            'thinking.budget_tokens: Input should be greater than or equal to 1024',
                    },
                },
                'a tool schema': {
                    error: {
                        type: 'invalid_request_error',
                        message:
                            'Upstream request failed: [missing_required_parameter] tools[0]: function.description is required',
                    },
                },
            };
            for (const [what, error] of Object.entries(others)) {
                const broken = await everySlot(async (slot, mode) => {
                    const { bodies, rejected } = await call(
                        slot,
                        mode,
                        () => error,
                    );
                    if (!rejected) return `${what}: swallowed`;
                    if (bodies.length !== 1)
                        return `${what}: ${bodies.length} requests`;
                });
                expect(broken).toEqual([]);
            }
        },
        MATRIX_TIMEOUT,
    );

    it(
        'a refusal is remembered for the slot and org that got it, and only for them',
        async () => {
            const broken = await everySlot(async (slot, mode) => {
                const sent = await firstBody(slot, mode);
                const field = FIELDS.find((f) => has(sent, f));
                if (!field) return undefined;
                await call(slot, mode, refusing([field]), 'org-a');

                // Same slot, same org: the next call goes out without it at once.
                const again = await call(
                    slot,
                    mode,
                    refusing([field]),
                    'org-a',
                );
                if (again.bodies.length !== 1)
                    return `same org: ${again.bodies.length} requests`;
                if (has(again.bodies[0], field))
                    return 'same org: field sent again';

                // Another org on the same slot never saw the refusal.
                const other = await call(slot, mode, () => undefined, 'org-b');
                if (!has(other.bodies[0], field))
                    return 'another org lost the field';
            });
            expect(broken).toEqual([]);
        },
        MATRIX_TIMEOUT,
    );
});
