import {
    classifyWebhookSetupError,
    failWebhookSetupForAll,
    runWebhookSetup,
} from './webhook-setup';

const repo = (id: string) => ({ id, name: `repo-${id}` }) as any;

const httpError = (status: number, headers: Record<string, string> = {}) =>
    Object.assign(new Error(`HTTP ${status}`), {
        response: { status, headers },
    });

describe('classifyWebhookSetupError', () => {
    it.each([401, 403])('reads HTTP %s as a permission error', (status) => {
        const failure = classifyWebhookSetupError(httpError(status), {
            provider: 'GitLab',
            permissionHint: 'Needs the Maintainer role.',
        });

        expect(failure.kind).toBe('permission');
        expect(failure.reason).toContain(`HTTP ${status}`);
        expect(failure.reason).toContain('Needs the Maintainer role.');
    });

    it('reads a 429 as rate limited and keeps the Retry-After wait', () => {
        const failure = classifyWebhookSetupError(
            httpError(429, { 'retry-after': '30' }),
            { provider: 'GitHub' },
        );

        expect(failure).toMatchObject({
            kind: 'rate_limited',
            retryAfterMs: 30_000,
        });
    });

    it('reads anything else as a plain error', () => {
        const failure = classifyWebhookSetupError(new Error('boom'), {
            provider: 'Forgejo',
        });

        expect(failure.kind).toBe('error');
        expect(failure.reason).toContain('boom');
    });
});

describe('runWebhookSetup', () => {
    it('configures each repository independently, one failure does not stop the rest', async () => {
        const perRepo = jest.fn(async (r: { id: string }) => {
            if (r.id === '2') throw httpError(403);
        });

        const result = await runWebhookSetup(
            [repo('1'), repo('2'), repo('3')],
            perRepo,
            { provider: 'GitLab' },
        );

        expect(perRepo).toHaveBeenCalledTimes(3);
        expect(result.configured).toEqual(['1', '3']);
        expect(result.failed['2'].kind).toBe('permission');
        expect(result.notAttempted).toEqual([]);
    });

    it('stops at the first rate limit and reports the rest as not attempted', async () => {
        const perRepo = jest.fn(async (r: { id: string }) => {
            if (r.id === '2') throw httpError(429, { 'retry-after': '5' });
        });

        const result = await runWebhookSetup(
            [repo('1'), repo('2'), repo('3'), repo('4')],
            perRepo,
            { provider: 'Bitbucket' },
        );

        expect(perRepo).toHaveBeenCalledTimes(2);
        expect(result.configured).toEqual(['1']);
        expect(result.failed['2']).toMatchObject({
            kind: 'rate_limited',
            retryAfterMs: 5_000,
        });
        expect(result.notAttempted).toEqual(['3', '4']);
        expect(result.rateLimited).toEqual({ retryAfterMs: 5_000 });
    });

    it('returns an empty result for no repositories', async () => {
        const perRepo = jest.fn();

        const result = await runWebhookSetup([], perRepo, {
            provider: 'GitHub',
        });

        expect(perRepo).not.toHaveBeenCalled();
        expect(result).toEqual({
            configured: [],
            failed: {},
            notAttempted: [],
        });
    });
});

describe('failWebhookSetupForAll', () => {
    it('records the same failure for every repository, for a failure before any of them ran', () => {
        const result = failWebhookSetupForAll([repo('1'), repo('2')], httpError(401), {
            provider: 'Azure DevOps',
        });

        expect(result.configured).toEqual([]);
        expect(Object.keys(result.failed)).toEqual(['1', '2']);
        expect(result.failed['1'].kind).toBe('permission');
    });
});
