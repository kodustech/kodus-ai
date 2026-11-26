import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { classifyLLMError, LlmErrorCategory } from '@libs/llm/error-classifier';
import { providerErrorFromResult } from './provider-error';

describe('providerErrorFromResult', () => {
    it('returns null for a healthy result', () => {
        expect(providerErrorFromResult({ finishReason: 'stop' })).toBeNull();
    });

    it('returns null for a non-error stop (timeout/budget)', () => {
        expect(providerErrorFromResult({ finishReason: 'timeout' })).toBeNull();
        expect(providerErrorFromResult(undefined)).toBeNull();
    });

    it('reconstructs a classifiable error carrying the provider message/name', () => {
        const err = providerErrorFromResult({
            finishReason: 'error',
            errorMessage: 'Not found the model kimi-x or Permission denied',
            errorName: 'AI_APICallError',
        });
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toContain('Not found the model kimi-x');
        expect(err!.name).toBe('AI_APICallError');
    });

    it('re-attaches upstream status + body for classifyLLMError', () => {
        const err = providerErrorFromResult({
            finishReason: 'error',
            errorMessage: 'Not Found',
            errorStatus: 404,
            errorResponseBody: '{"error":"model not found"}',
        }) as (Error & { statusCode?: number; responseBody?: string }) | null;
        expect(err?.statusCode).toBe(404);
        expect(err?.responseBody).toBe('{"error":"model not found"}');
    });

    it('falls back to a generic message when none is present', () => {
        const err = providerErrorFromResult({ finishReason: 'error' });
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toMatch(/provider call returned an error/i);
    });
});

/**
 * Review, PR #2700 round 2: the agent runner keeps only the failure's name and
 * message, so a provider that cannot be reached must still read as a connect
 * failure, naming the address, once rebuilt here. The call is a real AI SDK
 * call against a local port nobody listens on, run in a plain Node process:
 * inside Jest's VM the SDK's `instanceof TypeError` misses undici's error and
 * it never wraps it, so the shape would not be production's.
 */
describe('an unreachable provider, rebuilt from what the runner keeps', () => {
    let closedPort: number;

    beforeAll(async () => {
        const probe = createServer();
        await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
        closedPort = (probe.address() as AddressInfo).port;
        await new Promise<void>((r) => probe.close(() => r()));
    });

    /** name + message of a real failed call, as ai-sdk-agent-runner.ts keeps them. */
    function realFailure(maxRetries: number): {
        name: string;
        message: string;
    } {
        const script = `
            import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
            import { generateText } from 'ai';
            const model = createOpenAICompatible({
                name: 'gw', baseURL: process.env.PROBE_URL, apiKey: 'sk-test',
            }).chatModel('m');
            const e = await generateText({
                model, prompt: 'hi', maxRetries: Number(process.env.PROBE_RETRIES),
            }).then(() => ({}), (x) => x);
            process.stdout.write(JSON.stringify({ name: e.name, message: e.message }));
        `;
        return JSON.parse(
            execFileSync(
                process.execPath,
                ['--input-type=module', '-e', script],
                {
                    cwd: process.cwd(),
                    env: {
                        ...process.env,
                        PROBE_URL: `http://127.0.0.1:${closedPort}/v1`,
                        PROBE_RETRIES: String(maxRetries),
                    },
                    timeout: 20_000,
                },
            ).toString(),
        );
    }

    it.each([0, 1])(
        'with maxRetries %i: TRANSIENT, and the message names the address',
        (maxRetries) => {
            const { name, message } = realFailure(maxRetries);
            const info = classifyLLMError(
                providerErrorFromResult({
                    finishReason: 'error',
                    errorName: name,
                    errorMessage: message,
                }),
                'openai_compatible',
            );
            expect(info.category).toBe(LlmErrorCategory.TRANSIENT);
            expect(info.friendlyMessage).toContain(
                `ECONNREFUSED 127.0.0.1:${closedPort}`,
            );
            expect(info.friendlyMessage).toContain('check the base URL');
        },
        30_000,
    );

    it('an unresolvable host, as the retries report it, names the host', () => {
        const info = classifyLLMError(
            providerErrorFromResult({
                finishReason: 'error',
                errorName: 'AI_RetryError',
                // The SDK's own wording, read off a real call.
                errorMessage:
                    'Failed after 4 attempts. Last error: AI_APICallError: Cannot connect to API: getaddrinfo ENOTFOUND llm.example.invalid',
            }),
            'openai_compatible',
        );
        expect(info.category).toBe(LlmErrorCategory.TRANSIENT);
        expect(info.friendlyMessage).toContain('ENOTFOUND llm.example.invalid');
    });

    it('only the code and host are published, not what follows them', () => {
        const info = classifyLLMError(
            providerErrorFromResult({
                finishReason: 'error',
                errorName: 'AI_APICallError',
                errorMessage:
                    'Cannot connect to API: getaddrinfo ENOTFOUND gw.example.test?key=AQ.secretsecret',
            }),
        );
        expect(info.friendlyMessage).toContain('ENOTFOUND gw.example.test');
        expect(info.friendlyMessage).not.toContain('secret');
    });

    it('a validation error quoting the SDK sentence is not a connect failure', () => {
        const info = classifyLLMError(
            providerErrorFromResult({
                finishReason: 'error',
                errorName: 'AI_TypeValidationError',
                errorMessage:
                    'Cannot connect to API: getaddrinfo ENOTFOUND llm.example.invalid',
            }),
        );
        expect(info.friendlyMessage ?? '').not.toContain("Couldn't connect");
    });
});
