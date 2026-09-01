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
import { tracedGenerateText as generateText } from '../llm-call';

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
 * Run one BYOK slot through the real resolve→build→call path and return the
 * HTTP request it produced. Never touches the network.
 *
 * `opts` mirrors the review call-sites: they pass `reasoningEffortDefault:
 * 'none'` (an unset slot means "no extra thinking"), so that is the default
 * here too — a case that wants the agent-loop default states it.
 */
export async function captureByokWire(
    slot: NormalizedModel,
    opts: {
        // The contract's own vocabulary, not `string`: spreading a widened
        // literal into resolveModelConfig's options is a type error, and the
        // harness should reject an effort the runtime cannot mean.
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
        const { model, callOptions, providerOptions } = resolveModelConfig(
            slot,
            {
                runName: 'byok-wire-harness',
                reasoningEffortDefault: 'none',
                // Mirror the review call-sites: they read OpenRouter routing off the
                // slot and hand it to resolveModelConfig as options. A case may still
                // override explicitly.
                openrouterProviderOrder: (slot as any)?.openrouterProviderOrder,
                openrouterAllowFallbacks: (slot as any)
                    ?.openrouterAllowFallbacks,
                ...opts,
            },
        );

        await generateText({
            model,
            maxRetries: 0,
            ...callOptions,
            // resolveModelConfig hands back the open provider-namespace record
            // the SDK ultimately indexes by key; the SDK's own parameter type is
            // narrower than what a provider namespace can legally hold.
            providerOptions: providerOptions as Parameters<
                typeof generateText
            >[0]['providerOptions'],
            messages: [{ role: 'user', content: 'ping' }],
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
    return captured[captured.length - 1];
}
