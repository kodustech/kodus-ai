/**
 * Trace-level Langfuse attribution: the session key and the propagation
 * wrapper. Separate plane from `buildLangfuseTelemetry` (per-observation
 * metadata, covered in libs/llm/reasoning-options.spec.ts) — these are the
 * dimensions the Langfuse UI filters and groups BY.
 */
const propagated: { params: any[] } = { params: [] };
jest.mock('@langfuse/tracing', () => ({
    propagateAttributes: (params: any, fn: () => unknown) => {
        propagated.params.push(params);
        return fn();
    },
}));

import {
    pullRequestSessionId,
    withLangfuseTrace,
} from '@libs/core/log/langfuse';

describe('pullRequestSessionId', () => {
    it('is byte-identical for every agent working the same PR', () => {
        // The code-review agents and the business-rules agent reach this from
        // different call paths with differently-shaped context. If the strings
        // diverge, Langfuse silently files one PR under two sessions.
        const fromReview = pullRequestSessionId({
            organizationId: 'org-1',
            repositoryId: 'repo-9',
            pullRequestId: 42,
        });
        const fromBusinessRules = pullRequestSessionId({
            organizationId: 'org-1',
            repositoryId: 'repo-9',
            pullRequestId: 42,
        });

        expect(fromReview).toBe('org-1:repo-9:42');
        expect(fromBusinessRules).toBe(fromReview);
    });

    it('keeps the placeholders the code-review path already emits', () => {
        // Parity with the pre-existing review key: an unknown org and an
        // unknown repo have fixed spellings, so historical sessions still match.
        expect(pullRequestSessionId({ pullRequestId: 7 })).toBe(
            'unknown_org:repo:7',
        );
    });

    it('invents no session when there is no PR to group under', () => {
        expect(
            pullRequestSessionId({ organizationId: 'org-1' }),
        ).toBeUndefined();
        // A falsy PR number is "no PR", not PR zero — matches the review path.
        expect(
            pullRequestSessionId({ organizationId: 'org-1', pullRequestId: 0 }),
        ).toBeUndefined();
    });
});

describe('withLangfuseTrace', () => {
    const originalEnv = { ...process.env };
    beforeEach(() => {
        propagated.params = [];
    });
    afterEach(() => {
        process.env = { ...originalEnv };
    });

    function enableTracing() {
        process.env.LANGFUSE_TRACING = 'true';
        process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
        process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    }

    it('passes through without propagating when tracing is disabled', async () => {
        delete process.env.LANGFUSE_TRACING;

        const result = await withLangfuseTrace(
            { traceName: 't', sessionId: 's' },
            async () => 'value',
        );

        expect(result).toBe('value');
        expect(propagated.params).toHaveLength(0);
    });

    it('drops absent identifiers instead of sending them as "undefined"', async () => {
        enableTracing();

        await withLangfuseTrace(
            {
                traceName: 'businessRulesValidation',
                metadata: {
                    organizationId: 'org-1',
                    // no repository in this context
                    repositoryId: undefined,
                },
            },
            async () => 'ok',
        );

        expect(propagated.params).toHaveLength(1);
        // Langfuse keeps string values only; an undefined would be dropped with
        // a warning, so it never leaves here.
        expect(propagated.params[0].metadata).toEqual({
            organizationId: 'org-1',
        });
    });

    it('propagates the trace identity and returns the wrapped result', async () => {
        enableTracing();

        const result = await withLangfuseTrace(
            {
                traceName: 'conversationAgent',
                sessionId: 'thread-1',
                userId: 'org-1',
            },
            async () => 'answer',
        );

        expect(result).toBe('answer');
        expect(propagated.params[0]).toMatchObject({
            traceName: 'conversationAgent',
            sessionId: 'thread-1',
            userId: 'org-1',
        });
    });
});
