// ---------------------------------------------------------------------------
// WIRE-LEVEL test for the formatter's reasoning-off override (kody code-review
// on #1851 / managed-slot.ts).
//
// `format-suggestion-content.spec.ts` mocks `LLM.run` and asserts the
// `providerOptions` ARGUMENT object. That is one abstraction too high: the
// AI SDK forwards `providerOptions` under the provider INSTANCE name (its
// camelCase), so a payload addressed to the wrong namespace is silently
// dropped and the arg-object assertion stays green. This suite drives the REAL
// stack — formatSuggestionContent → LLM.run → resolveModelConfig → provider
// build → SDK — and captures the actual HTTP request body, which is the only
// place the bug was visible.
//
// The managed/env OpenAI-compatible endpoints used to be built with names
// ('fireworks' / 'self-hosted') that did not match the registry namespace
// (`openaiCompatible`), so `thinking:disabled` never reached the network.
// ---------------------------------------------------------------------------

import { formatSuggestionContent } from '@libs/code-review/infrastructure/agents/engine/format-suggestion-content';

const ENV_KEYS = [
    'API_LLM_PROVIDER_MODEL',
    'API_OPEN_AI_API_KEY',
    'API_OPENAI_FORCE_BASE_URL',
    'API_FIREWORKS_API_KEY',
    'FIREWORKS_API_KEY',
    'API_FIREWORKS_BASE_URL',
] as const;

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

interface CapturedWire {
    url: string;
    body: any;
}

interface CaptureResult {
    captured: CapturedWire[];
    formatted: Map<number, { suggestionContent: string; improvedCode: string }>;
    degraded: string[];
}

/** Run the real formatter with `globalThis.fetch` stubbed and return every
 *  captured HTTP request plus the degradation reports. Never touches the
 *  network. `status` lets a test simulate an upstream REJECTING the payload
 *  (e.g. a strict server 400ing on an unknown body field). */
async function captureFormatterWire(
    init: { status?: number; body?: unknown } = {},
): Promise<CaptureResult> {
    const captured: CapturedWire[] = [];
    const degraded: string[] = [];
    const realFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init_: any) => {
        const url =
            typeof input === 'string' ? input : String(input?.url ?? input);
        captured.push({
            url,
            body: init_?.body ? JSON.parse(String(init_.body)) : undefined,
        });
        return new Response(
            init.body !== undefined && init.status
                ? JSON.stringify(init.body)
                : JSON.stringify(OPENAI_OK),
            {
                status: init.status ?? 200,
                headers: { 'content-type': 'application/json' },
            },
        );
    }) as typeof fetch;

    let formatted: Map<
        number,
        { suggestionContent: string; improvedCode: string }
    >;
    try {
        formatted = await formatSuggestionContent(
            [
                {
                    suggestionContent: 'WHAT: x. WHY: y. HOW: z.',
                    existingCode: 'a',
                    improvedCode: 'b',
                    relevantFile: 'src/foo.ts',
                    language: 'TypeScript',
                },
            ],
            {
                onDegraded: (info) => degraded.push(info.reason),
            },
        );
    } finally {
        globalThis.fetch = realFetch;
    }

    if (!captured.length) {
        throw new Error('no HTTP request captured');
    }
    return { captured, formatted, degraded };
}

describe('formatSuggestionContent — reasoning-off reaches the WIRE', () => {
    const snapshot: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of ENV_KEYS) {
            snapshot[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (snapshot[k] === undefined) delete process.env[k];
            else process.env[k] = snapshot[k];
        }
    });

    it('CLOUD managed default (Fireworks) → the request body carries thinking:disabled', async () => {
        // No BYOK slot, no self-hosted env model → Kodus-funded Fireworks
        // DeepSeek managed default. `API_LLM_PROVIDER_MODEL` must be absent.
        process.env.API_FIREWORKS_API_KEY = 'fw-test';

        const { captured } = await captureFormatterWire();
        const { url, body } = captured[0];

        expect(url).toContain('api.fireworks.ai');
        expect(body.model).toBe(
            'accounts/fireworks/models/deepseek-v4-flash-0731',
        );
        // The whole point: the disable must survive the provider-instance
        // namespace, not be dropped because we addressed `openaiCompatible`
        // while the SDK instance was named something else.
        expect(body.thinking).toEqual({ type: 'disabled' });
    });

    it('self-hosted env OpenAI-compatible → the request body carries thinking:disabled', async () => {
        process.env.API_LLM_PROVIDER_MODEL = 'deepseek-v4-pro';
        process.env.API_OPEN_AI_API_KEY = 'sk-test';
        process.env.API_OPENAI_FORCE_BASE_URL = 'https://api.deepseek.com/v1';

        const { captured } = await captureFormatterWire();
        const { url, body } = captured[0];

        expect(url).toContain('api.deepseek.com');
        expect(body.model).toBe('deepseek-v4-pro');
        expect(body.thinking).toEqual({ type: 'disabled' });
    });

    it('A REJECTED Fireworks payload degrades (rule 15) — reports, ships the mechanical strip, never silently passes', async () => {
        // Fireworks is strict with unknown body fields. if a future request
        // shape (or a stricter upstream) were ever refused on this field, the
        // formatter must NOT swallow it into a silent pass — it records a
        // partial degradation and the mechanical fallback still ships comments.
        process.env.API_FIREWORKS_API_KEY = 'fw-test';

        const { captured, formatted, degraded } = await captureFormatterWire({
            status: 400,
            body: { error: { message: 'unknown field: thinking' } },
        });

        // The payload WAS placed on the wire (that's what the upstream rejected).
        expect(captured[0].url).toContain('api.fireworks.ai');
        expect(captured[0].body.thinking).toEqual({ type: 'disabled' });

        // Rejection → pollution to the pipeline (partial), never a throw, and
        // never a silent 200-corrupted run.
        expect(degraded).toHaveLength(1);
        expect(degraded[0]).toContain('provider call failed');
        expect(formatted.size).toBe(1);
        expect(formatted.get(0)?.suggestionContent).toBe('x. y. z.');
    });
});