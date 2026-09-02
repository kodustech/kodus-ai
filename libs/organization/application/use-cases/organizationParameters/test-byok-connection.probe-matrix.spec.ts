/**
 * Contract: EVERY provider id in the registry is probe-able, and the probe is a
 * real model call.
 *
 * Why this file exists: the probe used to dispatch through a hand-kept switch,
 * so a provider could ship, appear in the connect form, and have no probe at
 * all — `azure` did exactly that and threw "Unsupported provider: azure",
 * making it impossible to connect. A switch will always lag the registry, so
 * the guarantee is asserted here, over `REGISTRY.ids()`, and a new provider
 * joins this matrix the moment it registers.
 */
// @ts-nocheck

// 
import { REGISTRY } from '@libs/llm/providers';
import { TestByokConnectionUseCase } from './test-byok-connection.use-case';

jest.mock('dns/promises', () => ({
    lookup: jest
        .fn()
        .mockResolvedValue([{ address: '203.0.113.10', family: 4 }]),
}));

const generateText = jest.fn();
jest.mock('ai', () => ({
    ...jest.requireActual('ai'),
    generateText: (...args: any[]) => generateText(...args),
}));

function useCase() {
    return new TestByokConnectionUseCase({
        isProviderSupported: () => true,
    } as any);
}

// Vertex and Bedrock validate auth material (SA JSON / STS) before any model
// call, so they need real-shaped credentials and are covered by their own specs.
const AUTH_PREFLIGHT_IDS = new Set(['google_vertex', 'amazon_bedrock']);

const PROBED_IDS = REGISTRY.ids()
    .filter((id) => !AUTH_PREFLIGHT_IDS.has(id))
    .sort();

describe('connection probe covers every registered provider', () => {
    beforeEach(() => {
        generateText.mockReset();
        generateText.mockResolvedValue({ text: 'pong' });
    });

    it.each(PROBED_IDS)('%s issues one real model call', async (id) => {
        const result = await useCase().execute({
            provider: id,
            apiKey: 'sk-test',
            baseURL: 'https://example.com/v1',
            model: 'some-model',
        });

        expect(result.ok).toBe(true);
        expect(result.code).toBe('ok');
        // A real inference call — not a /models listing, which returns 200 for a
        // valid key even when the configured model doesn't exist.
        expect(generateText).toHaveBeenCalledTimes(1);
    });

    it('sends the configured tuning, not a bare ping', async () => {
        await useCase().execute({
            provider: 'openai_compatible',
            apiKey: 'sk-test',
            baseURL: 'https://example.com/v1',
            model: 'some-model',
            temperature: 0.4,
        });

        const call = generateText.mock.calls[0][0];
        expect(call.temperature).toBe(0.4);
        // The SDK retries twice by default; a probe must report the first answer
        // rather than triple a user's failing request.
        expect(call.maxRetries).toBe(0);
        expect(call.abortSignal).toBeDefined();
    });

    /**
     * 674ca706b decided NOT to force `thinking` onto a plain upstream — a param
     * an unknown endpoint may reject. The probe now resolves reasoning through
     * the runtime, so it must inherit that restraint: an unconfigured slot sends
     * no reasoning at all, and only what the user actually set goes on the wire.
     */
    it('sends no reasoning when the user configured none', async () => {
        await useCase().execute({
            provider: 'openai_compatible',
            apiKey: 'sk-test',
            baseURL: 'https://example.com/v1',
            model: 'some-model',
        });

        const call = generateText.mock.calls[0][0];
        const sent = call.providerOptions ?? {};
        expect(JSON.stringify(sent)).not.toMatch(/thinking|reasoning/i);
    });

    it('reports a provider rejection with its status, not a generic failure', async () => {
        const err: any = new Error('model not found');
        err.name = 'AI_APICallError';
        err.statusCode = 404;
        generateText.mockRejectedValue(err);

        const result = await useCase().execute({
            provider: 'openai',
            apiKey: 'sk-test',
            model: 'nope',
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe('not_found');
        expect(result.httpStatus).toBe(404);
    });

    it('treats a bad key as an auth failure', async () => {
        const err: any = new Error('invalid api key');
        err.name = 'AI_APICallError';
        err.statusCode = 401;
        generateText.mockRejectedValue(err);

        const result = await useCase().execute({
            provider: 'anthropic',
            apiKey: 'sk-bad',
            model: 'claude-x',
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe('auth');
    });
});
