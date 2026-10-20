/**
 * #2113: a runtime that makes its own HTTP calls (the Claude Agent SDK's CLI,
 * behind the EE gateway) puts each request through `runInByokEnvelope` instead
 * of the AI SDK wrapper. For a team's slot to behave the same on either
 * runtime, both paths must give the same limiter, the same classification, the
 * same cooldown and the same report for the same failure. Checked over every
 * slot shape stored in production.
 */
import { APICallError } from '@ai-sdk/provider';

import PROD_SHAPES from './testing/__fixtures__/byok-prod-shapes.json';
import type { NormalizedModel } from './byok-config';
import { wrapByokModel } from './byok-model-wrapper';
import { runInByokEnvelope, reportByokFailure } from './byok-call-envelope';
import { getLimiterForSlot, __limiterCacheInternals } from './byok-to-vercel';
import { LlmErrorCategory } from './error-classifier';
import { getClassification } from './error-classifier';

// The limiter keeps the cooldown deadline private; reading it is the only way to
// see an armed cooldown without waiting for a delayed admission.
const coolingDown = (limiter: { isInCooldown(): boolean } | null) => !!limiter && limiter.isInCooldown();

const PROMPT = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] as any;

function apiError(status: number, body: string, headers: Record<string, string> = {}) {
    return new APICallError({
        message: `status ${status}`,
        url: 'https://upstream.example/v1/messages',
        requestBodyValues: {},
        statusCode: status,
        responseHeaders: headers,
        responseBody: body,
        isRetryable: status === 429 || status >= 500,
    });
}

// What a provider answers, by the failures the banner and the cooldown read.
const FAILURES: Array<[string, () => Error]> = [
    ['401 bad key', () => apiError(401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')],
    ['402 billing', () => apiError(402, '{"type":"error","error":{"type":"billing_error","message":"credit balance too low"}}')],
    ['403 permission', () => apiError(403, '{"type":"error","error":{"type":"permission_error","message":"not allowed"}}')],
    ['404 model', () => apiError(404, '{"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}')],
    ['429 rate', () => apiError(429, '{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}', { 'retry-after': '3' })],
    ['429 quota', () => apiError(429, '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}')],
    ['500 server', () => apiError(500, '{"type":"error","error":{"type":"api_error","message":"internal"}}')],
    ['529 overloaded', () => apiError(529, '{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}')],
    ['network', () => Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })],
];

// Each shape with its own key (so limiters never collide across cases) and the
// knobs that make the limiter and the cooldown observable.
function slotOf(shape: Record<string, unknown>, i: number, failure: string): NormalizedModel {
    const { orgs: _orgs, ...rest } = shape;
    return {
        ...rest,
        apiKey: `key-${i}-${failure}`,
        maxConcurrentRequests: 2,
        cooldownMs: 50,
    } as unknown as NormalizedModel;
}

interface Observed {
    report: unknown;
    classification: unknown;
    limiterCreated: boolean;
    cooldownArmed: boolean;
}

async function viaWrapper(slot: NormalizedModel, makeErr: () => Error): Promise<Observed> {
    const reports: unknown[] = [];
    const err = makeErr();
    const model = {
        specificationVersion: 'v4',
        provider: 'test',
        modelId: 'm',
        supportedUrls: {},
        doGenerate: jest.fn(async () => {
            throw err;
        }),
        doStream: jest.fn(),
    } as any;
    const wrapped = wrapByokModel(model, { byokConfig: slot, organizationId: 'org-w', provider: slot.provider, reporter: (r) => reports.push(r) });
    await expect(wrapped.doGenerate({ prompt: PROMPT } as any)).rejects.toBe(err);
    const limiter = getLimiterForSlot({ slot, organizationId: 'org-w' });
    return {
        report: reports[0],
        classification: getClassification(err),
        limiterCreated: !!limiter,
        cooldownArmed: coolingDown(limiter),
    };
}

async function viaEnvelope(slot: NormalizedModel, makeErr: () => Error): Promise<Observed> {
    const reports: unknown[] = [];
    const err = makeErr();
    await expect(
        runInByokEnvelope({ slot, organizationId: 'org-e', provider: slot.provider, reporter: (r) => reports.push(r) }, { prompt: PROMPT }, async () => {
            throw err;
        }),
    ).rejects.toBe(err);
    const limiter = getLimiterForSlot({ slot, organizationId: 'org-e' });
    return {
        report: reports[0],
        classification: getClassification(err),
        limiterCreated: !!limiter,
        cooldownArmed: coolingDown(limiter),
    };
}

const normalize = (o: Observed) => ({ ...o, report: { ...(o.report as object), organizationId: 'org' } });

// 306 shapes × 9 failures through two paths: slow on a loaded machine.
jest.setTimeout(120_000);

describe('BYOK call envelope: same behavior as the AI SDK wrapper', () => {
    const shapes = PROD_SHAPES as Array<Record<string, unknown>>;

    it('covers every stored production slot shape', () => {
        expect(shapes.length).toBeGreaterThan(300);
    });

    describe.each(FAILURES)('%s', (failure, makeErr) => {
        it('gives the same report, classification, limiter and cooldown for every production slot shape', async () => {
            const mismatches: string[] = [];
            for (const [i, shape] of shapes.entries()) {
                const slot = slotOf(shape, i, failure);
                const wrapper = normalize(await viaWrapper(slot, makeErr));
                const envelope = normalize(await viaEnvelope({ ...slot }, makeErr));
                if (JSON.stringify(wrapper) !== JSON.stringify(envelope)) {
                    mismatches.push(`${shape.provider}/${shape.model}: wrapper ${JSON.stringify(wrapper)} envelope ${JSON.stringify(envelope)}`);
                }
            }
            expect(mismatches).toEqual([]);
        });
    });

    // The parity runs above leave thousands of limiters (hundreds cooling down)
    // in the process cache; past its cap of 500 a fresh limiter can be evicted
    // as soon as it is created, so these start from an empty cache.
    beforeEach(() => __limiterCacheInternals.cache.clear());

    it('arms the cooldown on a rate limit and never on quota, and reports the provider sentence with its status', async () => {
        const slot = slotOf({ provider: 'anthropic', model: 'claude-sonnet-5-5' }, 9001, 'direct');
        const reports: any[] = [];
        // A slot's limiter exists once it has served a request; the cooldown arms on it.
        await runInByokEnvelope({ slot, organizationId: 'org-d' }, {}, async () => 'ok');
        const rate = apiError(429, '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
        const classified = reportByokFailure({ slot, organizationId: 'org-d', provider: 'anthropic', reporter: (r) => reports.push(r) }, rate);

        expect(classified?.category).toBe(LlmErrorCategory.RATE_LIMIT);
        expect(reports[0]).toMatchObject({ organizationId: 'org-d', provider: 'anthropic', errorMessage: 'slow down', category: LlmErrorCategory.RATE_LIMIT, httpStatus: 429 });
        expect(coolingDown(getLimiterForSlot({ slot, organizationId: 'org-d' }))).toBe(true);

        const quotaSlot = slotOf({ provider: 'anthropic', model: 'claude-sonnet-5-5' }, 9002, 'direct');
        await runInByokEnvelope({ slot: quotaSlot, organizationId: 'org-d' }, {}, async () => 'ok');
        reportByokFailure({ slot: quotaSlot, organizationId: 'org-d', provider: 'anthropic' }, apiError(429, '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}'));
        expect(coolingDown(getLimiterForSlot({ slot: quotaSlot, organizationId: 'org-d' }))).toBe(false);
    });

    it('queues a second request behind the first when the slot allows one at a time', async () => {
        const slot = { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'serial-key', maxConcurrentRequests: 1 } as unknown as NormalizedModel;
        const order: string[] = [];
        let release!: () => void;
        const first = runInByokEnvelope({ slot, organizationId: 'org-q' }, {}, async () => {
            order.push('first:start');
            await new Promise<void>((r) => (release = r));
            order.push('first:end');
            return 1;
        });
        const second = runInByokEnvelope({ slot, organizationId: 'org-q' }, {}, async () => {
            order.push('second:start');
            return 2;
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(order).toEqual(['first:start']);
        release();
        await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
        expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    });
});
