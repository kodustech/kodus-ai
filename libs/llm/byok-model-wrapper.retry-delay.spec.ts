/**
 * A per-minute 429 names its window ("Please retry in 17s", Google puts it in
 * the body, with no retry header). The agent loop retries through the AI SDK,
 * whose backoff (2 s, 4 s, 8 s) gave up inside a 20 s window (#2130 QA). The
 * wrapper hands the SDK the provider's delay as `retry-after-ms`, which the
 * SDK waits for under a minute.
 */
import { APICallError } from '@ai-sdk/provider';
import { generateText } from 'ai';

import { BYOKProvider } from '@libs/llm/model-providers';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { wrapByokModel } from './byok-model-wrapper';

const googlePerMinute = (seconds: string) =>
    new APICallError({
        message:
            'You exceeded your current quota, please check your plan and billing details.',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent',
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: {},
        responseBody: JSON.stringify({
            error: {
                code: 429,
                message: `Quota exceeded for metric: generate_content_paid_tier_input_token_count. Please retry in ${seconds}s.`,
                details: [
                    {
                        '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                        'retryDelay': `${seconds.split('.')[0]}s`,
                    },
                ],
            },
        }),
        isRetryable: true,
    });

function flakyModel(first: () => Error) {
    const at: number[] = [];
    const doGenerate = jest.fn(async () => {
        at.push(Date.now());
        if (at.length === 1) throw first();
        return {
            content: [{ type: 'text', text: 'ok' }],
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
        };
    });
    const model = {
        specificationVersion: 'v4',
        provider: 'test-provider',
        modelId: 'gemini-3.8-flash',
        supportedUrls: {},
        doGenerate,
        doStream: jest.fn(),
    } as any;
    return { model, at };
}

const slot = {
    provider: BYOKProvider.GOOGLE_GEMINI,
    apiKey: 'fake-key-retry-delay',
    model: 'gemini-3.8-flash',
} as NormalizedModel;

const wrap = (model: unknown) =>
    wrapByokModel(model as never, {
        byokConfig: slot,
        organizationId: 'org-retry-delay',
        provider: 'google_gemini',
    });

describe('a per-minute 429 retried by the agent loop', () => {
    it("waits the provider's window, not the SDK's 2 s first backoff", async () => {
        const { model, at } = flakyModel(() => googlePerMinute('0.3'));
        await generateText({
            model: wrap(model) as never,
            prompt: 'hi',
            maxRetries: 1,
        });
        const gap = at[1] - at[0];
        expect(gap).toBeGreaterThanOrEqual(250);
        expect(gap).toBeLessThan(1500);
    });

    it('keeps a retry header the provider sent', async () => {
        const { model } = flakyModel(() => {
            const err = googlePerMinute('20');
            (
                err as { responseHeaders: Record<string, string> }
            ).responseHeaders = { 'retry-after': '1' };
            return err;
        });
        const thrown = await Promise.resolve(
            wrap(model).doGenerate({
                prompt: [
                    { role: 'user', content: [{ type: 'text', text: 'x' }] },
                ],
            } as never),
        ).catch(
            (e: unknown) => e as { responseHeaders: Record<string, string> },
        );
        expect(
            (thrown as { responseHeaders: Record<string, string> })
                .responseHeaders,
        ).toEqual({ 'retry-after': '1' });
    });

    // The SDK honors a retry header only under 60 s (`getRetryDelayInMs`):
    // "retry in 60s" handed over as 60000 fell back to its 2 s backoff,
    // inside the window (#2792 review).
    it('hands a full minute as just under it, which the SDK still honors', async () => {
        const { model } = flakyModel(() => googlePerMinute('60'));
        const thrown = await Promise.resolve(
            wrap(model).doGenerate({
                prompt: [
                    { role: 'user', content: [{ type: 'text', text: 'x' }] },
                ],
            } as never),
        ).catch(
            (e: unknown) => e as { responseHeaders: Record<string, string> },
        );
        expect(
            (thrown as { responseHeaders: Record<string, string> })
                .responseHeaders['retry-after-ms'],
        ).toBe('59999');
    });

    it('hands no delay past a minute: that is a daily cap, not a window', async () => {
        const { model } = flakyModel(() => googlePerMinute('3600'));
        const thrown = await Promise.resolve(
            wrap(model).doGenerate({
                prompt: [
                    { role: 'user', content: [{ type: 'text', text: 'x' }] },
                ],
            } as never),
        ).catch(
            (e: unknown) => e as { responseHeaders: Record<string, string> },
        );
        expect(
            (thrown as { responseHeaders: Record<string, string> })
                .responseHeaders['retry-after-ms'],
        ).toBeUndefined();
    });
});
