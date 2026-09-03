/**
 * The "Test" button must answer, even when the provider does not.
 *
 * `probeSlotCall` arms an AbortController and aborts at PROBE_TIMEOUT_MS. That
 * covers a provider that honours the abort. The ones this probe exists to
 * diagnose are exactly the ones that do not: an operator pastes a key for an
 * OpenAI-compatible proxy, the proxy accepts the connection and never answers,
 * and the abort is ignored. The await then settles never — nothing thrown, no
 * catch reached — and the dialog spins with no verdict.
 *
 * Same failure the agent loop had (see agent-loop-call.timeout.spec.ts); this
 * one costs a browser tab rather than a review, which is why it is smaller,
 * not why it should be left open.
 */
jest.mock('ai', () => {
    const actual = jest.requireActual('ai');
    return { ...actual, generateText: jest.fn() };
});
jest.mock('@libs/llm/model-invocation', () => ({ resolveModelConfig: jest.fn() }));
jest.mock('@libs/llm/reasoning-options', () => ({
    buildReasoningProviderOptions: jest.fn(() => ({})),
    reasoningEffortWasDropped: jest.fn(() => false),
}));

import { generateText } from 'ai';
import { probeSlotCall } from '@libs/llm/probe-slot-call';
import { resolveModelConfig } from '@libs/llm/model-invocation';

const mockGenerate = generateText as unknown as jest.Mock;
const mockResolve = resolveModelConfig as unknown as jest.Mock;

const slot = () =>
    ({
        provider: 'openai_compatible',
        model: 'stub',
        baseURL: 'https://stub.invalid/v1',
    }) as any;

beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockReturnValue({
        model: { __model: 'probe' },
        modelName: 'openai_compatible:stub',
        callOptions: {},
        providerOptions: {},
    });
});

describe('probeSlotCall — an unanswering provider must still produce a verdict', () => {
    it('does not hang when the provider ignores the abort and never answers', async () => {
        mockGenerate.mockImplementation(
            (opts: any) =>
                new Promise(() => {
                    // Takes the signal, ignores it — the shape the probe is for.
                    void opts?.abortSignal;
                }),
        );

        // What it must never do is leave the caller waiting forever. Whether
        // the verdict arrives as a resolved failure or a throw is the probe's
        // business; settling at all is the contract under test.
        const settled = await probeSlotCall(slot(), { timeoutMs: 40 }).then(
            () => 'resolved',
            (e: Error) => e.message,
        );

        expect(settled).toMatch(/resolved|\[HARD-TIMEOUT\]/);
    }, 15000);
});
