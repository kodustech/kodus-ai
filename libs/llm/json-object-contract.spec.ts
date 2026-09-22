/**
 * Issue #1916 — the permanent, network-free guard.
 *
 * ─── WHAT WENT WRONG ───────────────────────────────────────────────────────
 * A structured call on a bare `response_format: { type: 'json_object' }` route
 * tells the model NOTHING: not the shape it must answer in, and not even the
 * word "json", which OpenAI and every OpenAI-compatible proxy require in the
 * messages before they will accept that response_format at all. Both halves
 * were missing for every model outside the four allowlisted OpenRouter
 * prefixes, so the same request either 400'd ("'messages' must contain the word
 * 'json' in some form") or came back in a shape the parse rejected. Either way
 * the dedup pass fell into its `failed-keep-all` catch and published every
 * duplicate: 460 reviews across 47 organizations between 2026-09-02 and 09-14.
 *
 * ─── WHY THE ASSERTION IS THE REQUEST BODY ─────────────────────────────────
 * The bug was invisible to every unit test of the pieces. `capabilities()`,
 * `planStructuredCall`, the prompt builder and the recovery ladder were each
 * individually right; what was wrong was the COMPOSITION — which channel the
 * request actually went out on, and what the messages carried on that channel.
 * So this runs the real stack (LLM.run → slot resolution → the real provider
 * module → the real AI SDK) and stops at the last observable point before the
 * network.
 *
 * ─── THE INVARIANT ─────────────────────────────────────────────────────────
 * For EVERY route that resolves to `json_object`, the request body must carry
 * the literal word "json" and the schema's own property names. For every route
 * that carries the schema itself (json_schema, or the Anthropic protocol's own
 * channel), the prompt
 * is left exactly as the caller wrote it — the fix must not tax the routes that
 * were never broken.
 *
 * Adding a provider or a model family is one row. Nothing else to wire.
 *
 * SIBLING TABLE: `byok-config-matrix.spec.ts` asks the other wire question —
 * what a stored config puts in the body for reasoning, temperature and routing,
 * over a plain (loop) turn. This file owns the STRUCTURED channel and what the
 * messages carry on it. Same harness, different question; a new case belongs in
 * whichever of the two asks its question, not in a third table.
 */
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { z } from 'zod';
import { jsonSchema } from 'ai';
import type { NormalizedModel } from '@libs/llm/byok-config';
import {
    DEDUP_SCHEMA,
    buildDedupPrompt,
} from '@libs/code-review/infrastructure/agents/engine/dedup-prompt';
import { captureByokWire } from '@libs/llm/testing/byok-wire';
import { REGISTRY } from '@libs/llm/providers';
import { resolveStructuredOutputPolicy } from '@libs/llm/providers/kernel/structured-output';

/** A distinctive property name: generic enough to be a real dedup-shaped
 *  envelope, specific enough that finding it in the body proves the SCHEMA
 *  reached the model and not just some boilerplate sentence. */
const SCHEMA = z.object({
    groups: z.array(z.object({ keep: z.number() })),
    unique: z.array(z.number()),
});
const VALID_ANSWER = JSON.stringify({ groups: [], unique: [] });

const SYSTEM_NOTE = 'You are a careful reviewer.';

type Row = {
    id: string;
    why: string;
    slot: Record<string, unknown>;
    /** What the module declares this config puts on the wire. */
    wire: 'json_schema' | 'json_object' | 'none';
};

const CASES: Row[] = [
    // ── json_object: the broken class ──────────────────────────────────────
    {
        id: 'open_router / z-ai/glm-5.3',
        why: 'GLM through OpenRouter is outside the four allowlisted prefixes — the exact route of the confirmed Kapybara case',
        slot: { provider: 'open_router', model: 'z-ai/glm-5.3' },
        wire: 'json_object',
    },
    {
        id: 'open_router / deepseek/deepseek-v4-pro',
        why: 'DeepSeek through OpenRouter: same route, different upstream',
        slot: { provider: 'open_router', model: 'deepseek/deepseek-v4-pro' },
        wire: 'json_object',
    },
    {
        id: 'open_router / minimax/minimax-m2',
        why: 'an upstream nobody has an opinion about still gets a contract',
        slot: { provider: 'open_router', model: 'minimax/minimax-m2' },
        wire: 'json_object',
    },
    {
        id: 'novita / deepseek/deepseek-v4-pro',
        why: 'Novita declares json_object for EVERY model it hosts',
        slot: { provider: 'novita', model: 'deepseek/deepseek-v4-pro' },
        wire: 'json_object',
    },
    {
        id: 'openai_compatible / glm-5.3 @ api.z.ai',
        why: 'the same model on its own OpenAI-protocol endpoint — an unvetted baseURL, so no strict schema',
        slot: {
            provider: 'openai_compatible',
            model: 'glm-5.3',
            baseURL: 'https://api.z.ai/api/paas/v4',
        },
        wire: 'json_object',
    },

    // ── the routes that already carried a contract: must not change ────────
    {
        id: 'open_router / openai/gpt-5.4',
        why: 'an allowlisted prefix: response_format carries the schema itself',
        slot: { provider: 'open_router', model: 'openai/gpt-5.4' },
        wire: 'json_schema',
    },
    {
        id: 'openai_compatible / llama-3-70b @ vLLM :8000',
        why: 'the baseURL heuristic enables strict schema — the policy must see the URL, not just the model id',
        slot: {
            provider: 'openai_compatible',
            model: 'llama-3-70b',
            baseURL: 'http://vllm.internal:8000/v1',
        },
        wire: 'json_schema',
    },
    {
        id: 'openai / gpt-5.4',
        why: 'native OpenAI: strict schema, always',
        slot: { provider: 'openai', model: 'gpt-5.4' },
        wire: 'json_schema',
    },
    {
        id: 'anthropic / claude-opus-5',
        why: "the Anthropic protocol has no response_format: the schema rides the protocol's own channel (output_config / a forced tool)",
        slot: { provider: 'anthropic', model: 'claude-opus-5' },
        wire: 'none',
    },
];

const capture = (row: Row) =>
    captureByokWire(
        { apiKey: 'k', ...row.slot } as unknown as NormalizedModel,
        {
            schema: SCHEMA,
            system: SYSTEM_NOTE,
            cannedText: VALID_ANSWER,
        } as any,
    );

/** The MESSAGES channel of this request, lower-cased — every shape the four
 *  protocols use, and deliberately NOT the response_format / output_config
 *  block. The provider's keyword check reads the messages, so asserting over a
 *  body that also contains the literal string "json_object" would pass itself. */
function promptText(body: any): string {
    return JSON.stringify([
        body?.messages, // OpenAI chat completions · Anthropic
        body?.input, // OpenAI Responses API
        body?.system, // Anthropic system blocks
        body?.contents, // Gemini
        body?.systemInstruction, // Gemini system
    ]).toLowerCase();
}

describe('every route declares what it puts on the wire', () => {
    it.each(CASES.map((c) => [c.id, c] as const))('%s', (_id, row) => {
        const cfg = { apiKey: 'k', ...row.slot } as any;
        const declared = resolveStructuredOutputPolicy(
            REGISTRY.get(row.slot.provider as string),
            cfg,
        );
        expect(declared).toBe(row.wire);
    });

    it('the declaration is what build() turns on — one expression, no drift', () => {
        // The disagreement `structured-output.contract.spec.ts` pinned was
        // between `capabilities(model)` and `build()`. The POLICY is the one
        // both the executor and `build()` now read, so it cannot be the odd one
        // out: a row whose strict-schema flag contradicts its policy would send
        // a body the executor did not plan for.
        const mismatched = CASES.filter((row) => {
            const cfg = { apiKey: 'k', ...row.slot } as any;
            const policy = resolveStructuredOutputPolicy(
                REGISTRY.get(row.slot.provider as string),
                cfg,
            );
            const model: any = REGISTRY.get(row.slot.provider as string).build(
                cfg,
                { structuredOutputs: true },
            );
            // @ai-sdk/openai-compatible keeps the flag on the built model's
            // config; a native/Anthropic build has none, and answers 'none' or
            // 'json_schema' through its own protocol instead.
            const flag = model?.config?.supportsStructuredOutputs;
            if (flag === undefined) return false;
            return flag !== (policy === 'json_schema');
        });
        expect(mismatched.map((r) => r.id)).toEqual([]);
    });
});

describe('#1916 — a json_object route carries the contract in the prompt', () => {
    const jsonObjectRows = CASES.filter((c) => c.wire === 'json_object');

    it.each(jsonObjectRows.map((c) => [c.id, c] as const))(
        '%s — %s',
        async (_id, row) => {
            const wire = await capture(row);

            // The channel is what we said it is.
            expect(wire.body?.response_format).toEqual({ type: 'json_object' });

            const text = promptText(wire.body);
            // (1) The keyword. Without it OpenAI-compatible providers reject the
            //     request outright and NOTHING downstream recovers it.
            expect(text).toContain('json');
            // (2) The shape. Without it the model invents one and the parse
            //     silently mismatches — the dedup keep-all class.
            expect(text).toContain('groups');
            expect(text).toContain('unique');
            // The caller's own system prompt is kept, not replaced.
            expect(text).toContain(SYSTEM_NOTE.toLowerCase());
        },
        30_000,
    );
});

describe('#1916 — a route that carries the schema is left alone', () => {
    const contractRows = CASES.filter((c) => c.wire !== 'json_object');

    it.each(contractRows.map((c) => [c.id, c] as const))(
        '%s — %s',
        async (_id, row) => {
            const wire = await capture(row);
            const text = promptText(wire.body);

            // No prompt tax on a route that was never broken: the schema travels
            // on the wire (response_format or the tool definition), so the
            // messages stay exactly as the caller wrote them.
            expect(text).not.toContain('conforms exactly to this json schema');
            expect(text).toContain(SYSTEM_NOTE.toLowerCase());
        },
        30_000,
    );
});

describe("#1916 — the issue's own call, end to end", () => {
    // The table above proves the ROUTE behaves. This proves the CALLER the
    // issue is about still rides it: the real `buildDedupPrompt` (which contains
    // the word "json" exactly zero times) and the real `DEDUP_SCHEMA` (a raw
    // `jsonSchema()`, not a zod object — a different path through the wire-schema
    // conversion). A generic row would stay green if dedup stopped going through
    // `LLM.run`, or started passing its own `system` and shadowing the contract.
    it('carries the dedup prompt AND the contract on a json_object route', async () => {
        const user = buildDedupPrompt(
            [
                {
                    relevantFile: 'src/a.ts',
                    relevantLinesStart: 10,
                    relevantLinesEnd: 12,
                    oneSentenceSummary: 'missing idempotency guard on POST /complete',
                },
                {
                    relevantFile: 'src/a.ts',
                    relevantLinesStart: 10,
                    relevantLinesEnd: 14,
                    oneSentenceSummary: 'POST /complete can be replayed, no guard',
                },
            ],
            (severity) => severity ?? 'medium',
        );

        const wire = await captureByokWire(
            {
                provider: 'open_router',
                model: 'z-ai/glm-5.2',
                apiKey: 'k',
            } as unknown as NormalizedModel,
            {
                schema: jsonSchema(DEDUP_SCHEMA as any),
                user,
                cannedText: JSON.stringify({ groups: [], unique: [] }),
            } as any,
        );

        expect(wire.body?.response_format).toEqual({ type: 'json_object' });
        const text = promptText(wire.body);
        // The caller's own prompt is still there, unchanged...
        expect(text).toContain('cross-location duplicates');
        // ...and the contract the route needs is there with it.
        expect(text).toContain('json');
        expect(text).toContain('groups');
        expect(text).toContain('unique');
    }, 30_000);
});
