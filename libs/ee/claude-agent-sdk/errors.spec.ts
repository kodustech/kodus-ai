/**
 * An upstream error on the SDK path must reach the banner, the reporter and
 * the failover cascade as the same category the AI SDK path gives it today.
 * Each case runs the same scripted answer through @ai-sdk/anthropic (today's
 * path) and through the gateway record (SDK path), and classifies both.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

import { classifyLLMError } from '@libs/llm/error-classifier';

import { apiErrorFromUpstream, ClaudeSdkInfraError, isClaudeSdkInfraError } from './errors';

const { startFakeLlmServer } = require('../../../evals/shared/fake-llm-server');

const CASES: Array<[number, unknown, Record<string, string>]> = [
    [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, {}],
    [402, { type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, {}],
    [403, { type: 'error', error: { type: 'permission_error', message: 'Your API key does not have permission to use the specified resource.' } }, {}],
    [404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-sonnet-9' } }, {}],
    [429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }, { 'retry-after': '12' }],
    [400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } }, {}],
    [500, { type: 'error', error: { type: 'api_error', message: 'Internal server error' } }, {}],
    [529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, {}],
];

describe('SDK path errors', () => {
    let fake: any;
    beforeAll(async () => {
        fake = await startFakeLlmServer({ auth: { anthropicKey: 'k' } });
    });
    afterAll(async () => fake.close());

    it.each(CASES)('%s: same category, status and provider message as the AI SDK path', async (status, body, headers) => {
        fake.failNext({ status, body, headers });
        const today = await generateText({
            model: createAnthropic({ apiKey: 'k', baseURL: `${fake.origin}/v1` })('claude-sonnet-5-5'),
            prompt: 'x',
            maxRetries: 0,
        }).catch((e) => e);

        const sdk = apiErrorFromUpstream({ status, body: JSON.stringify(body), ...(headers['retry-after'] ? { retryAfter: headers['retry-after'] } : {}) }, `${fake.origin}/v1/messages`);

        const a = classifyLLMError(today, 'anthropic');
        const b = classifyLLMError(sdk, 'anthropic');
        expect({ category: b.category, httpStatus: b.httpStatus }).toEqual({ category: a.category, httpStatus: a.httpStatus });
        expect(sdk.message).toBe((body as any).error.message);
    });

    it('infra errors carry their reason and are told apart from provider errors', () => {
        const e = new ClaudeSdkInfraError('spawn', 'ENOENT claude');
        expect(isClaudeSdkInfraError(e)).toBe(true);
        expect(e.reason).toBe('spawn');
        expect(e.message).toBe('[claude-sdk:spawn] ENOENT claude');
        expect(isClaudeSdkInfraError(apiErrorFromUpstream({ status: 500, body: '' }, 'u'))).toBe(false);
    });
});
