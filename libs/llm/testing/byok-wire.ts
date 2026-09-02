/**
 * BYOK wire harness — "what does this config actually put on the network?"
 *
 * WHY THIS EXISTS
 * We support N providers × N models × N per-slot options. Almost every BYOK bug
 * we have shipped was the same shape: the config the user saved and the HTTP
 * body we emitted disagreed, and nothing in the test suite looked at the body.
 * Unit-testing `reasoning()` or `capabilities()` in isolation cannot catch that —
 * the defect lives in the COMPOSITION (slot → resolveModelConfig → provider
 * build → SDK → request body).
 *
 * So this harness drives the REAL stack end to end and stops at the last
 * observable point before the network: it stubs `globalThis.fetch`, captures the
 * request, and answers with a canned provider-shaped response so the SDK's own
 * parsing still runs. Nothing about the provider modules is mocked.
 *
 * WHY A GLOBAL FETCH STUB (and not the `fetch` build option)
 * `ProviderBuildOptions.fetch` is only threaded through the modules that needed
 * it for the connection probe (openai, anthropic, azure, novita, openrouter).
 * The AI SDK falls back to `globalThis.fetch` everywhere else, so stubbing the
 * global covers EVERY provider — including gemini/bedrock/vertex — and a new
 * provider module is covered the day it is registered, with no wiring to
 * remember.
 *
 * HOW TO ADD A CASE
 * You do not write a test. Add a row to the table in
 * `byok-config-matrix.spec.ts` describing the slot and what must (or must not)
 * appear on the wire. See that file's header.
 */

// `tracedGenerateText`, NOT the raw `generateText` export — this is the wrapper
// every production review call goes through (llm-call.ts). It forwards its args
// untouched and adds a hard-timeout race, so the request shape is identical;
// using it anyway is the point. A harness that proves the stack works through a
// door production does not use proves less than it claims.
import { LLM } from '../llm';
import { resolveModelConfig } from '../model-invocation';

import type { NormalizedModel } from '../byok-config';
import type { ReasoningEffort } from '../providers/kernel/types';

export interface CapturedWire {
    /** Full request URL the SDK built (baseURL + the provider's own path). */
    url: string;
    method: string;
    /** Parsed JSON request body — the thing the upstream actually receives. */
    body: any;
    headers: Record<string, string>;
}

/** The resolved `providerOptions` for a slot, WITHOUT issuing a call — the other
 *  half of a reachability check (what we asked for, next to what was sent). */
export function resolveProviderOptions(
    slot: NormalizedModel,
): Record<string, unknown> {
    return resolveModelConfig(slot, {
        runName: 'byok-wire-harness',
        reasoningEffortDefault: 'none',
        openrouterProviderOrder: (slot as any)?.openrouterProviderOrder,
        openrouterAllowFallbacks: (slot as any)?.openrouterAllowFallbacks,
    }).providerOptions as Record<string, unknown>;
}

/** Minimal successful responses, one per wire protocol, so the SDK's real
 *  response parsing runs instead of being short-circuited by a mock model. */
const OPENAI_OK = {
    id: 'wire',
    object: 'chat.completion',
    created: 0,
    model: 'wire',
    choices: [
        {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
        },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const ANTHROPIC_OK = {
    id: 'wire',
    type: 'message',
    role: 'assistant',
    model: 'wire',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
};

const GEMINI_OK = {
    candidates: [
        {
            content: { parts: [{ text: 'ok' }], role: 'model' },
            finishReason: 'STOP',
        },
    ],
    usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        totalTokenCount: 2,
    },
};

function cannedBodyFor(url: string): unknown {
    if (/generateContent/i.test(url)) return GEMINI_OK;
    if (/\/messages\b/i.test(url)) return ANTHROPIC_OK;
    return OPENAI_OK;
}

/**
 * Run one BYOK slot through `LLM.run` — the ONE door the product calls — and
 * return the HTTP request it produced. Never touches the network.
 *
 * It used to call `resolveModelConfig` and the SDK by hand, which was a harness
 * reimplementing what the executors already do: both of them pass
 * `reasoningEffortDefault: 'none'` and read the OpenRouter routing off the slot,
 * exactly as the hand-rolled version did. So the copy was invisible — it agreed
 * — and a harness that agrees today is a harness that can drift tomorrow while
 * still reporting green. Going through the door removes the copy AND covers the
 * slot resolution and failover the door owns.
 *
 * Loop mode (no tools, one step) is the executor used, because it is the one
 * that runs a plain message turn; a schema would route to the structured
 * executor and change the request under test. `opts` are merged ONTO the slot,
 * since that is where the executors read them from.
 */
export async function captureByokWire(
    slot: NormalizedModel,
    opts: {
        reasoningEffortDefault?: ReasoningEffort;
        openrouterProviderOrder?: string[];
        openrouterAllowFallbacks?: boolean;
    } = {},
): Promise<CapturedWire> {
    const captured: CapturedWire[] = [];
    const realFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init: any) => {
        const url =
            typeof input === 'string' ? input : String(input?.url ?? input);
        captured.push({
            url,
            method: init?.method ?? 'GET',
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
            headers: Object.fromEntries(
                Object.entries(init?.headers ?? {}).map(([k, v]) => [
                    k.toLowerCase(),
                    String(v),
                ]),
            ),
        });
        return new Response(JSON.stringify(cannedBodyFor(url)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;

    try {
        await LLM.run({
            byokConfig: {
                ...slot,
                // The executors read routing and effort off the SLOT, so a
                // per-case override belongs there rather than in a parallel
                // options bag the door does not accept.
                ...(opts.openrouterProviderOrder !== undefined
                    ? { openrouterProviderOrder: opts.openrouterProviderOrder }
                    : {}),
                ...(opts.openrouterAllowFallbacks !== undefined
                    ? {
                          openrouterAllowFallbacks:
                              opts.openrouterAllowFallbacks,
                      }
                    : {}),
                ...(opts.reasoningEffortDefault !== undefined &&
                (slot as any)?.reasoningEffort === undefined
                    ? { reasoningEffort: opts.reasoningEffortDefault }
                    : {}),
            } as NormalizedModel,
            messages: [{ role: 'user', content: 'ping' }],
            loop: { tools: {}, maxSteps: 1 },
            runName: 'byok-wire-harness',
        });
    } catch (err) {
        // The REQUEST is the subject under test. A canned response the provider's
        // parser rejects (or an upstream-shaped error) must not hide the body we
        // just captured — only a failure BEFORE the request is a real failure.
        if (!captured.length) throw err;
    } finally {
        globalThis.fetch = realFetch;
    }

    if (!captured.length) {
        throw new Error(
            'byok-wire: no HTTP request was captured — the provider build threw before reaching the network.',
        );
    }
    // The LAST request is the model call (a provider may fetch a token first).
    // The FIRST request, not the last. Going through the door means a retry or
    // a primary->fallback cascade can issue more than one, and every case here
    // is a claim about the request the stored config produces — the primary. The
    // hand-rolled version could only ever make one, so this distinction did not
    // exist before and would have silently changed what the matrix asserts.
    return captured[0];
}
