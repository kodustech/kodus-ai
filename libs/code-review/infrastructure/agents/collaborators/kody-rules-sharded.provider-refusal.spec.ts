import { APICallError, NoObjectGeneratedError, TypeValidationError } from 'ai';

import { KodyRulesScope } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import {
    judgeKodyRulesSharded,
    RunJudge,
} from './kody-rules-sharded.judge';

const file = (filename: string): any => ({
    filename,
    patchWithLinesStr: '1 +const x = 1;',
    patch: '1 +const x = 1;',
});

const refusal = (status: number, message: string) =>
    new APICallError({
        message,
        url: 'https://provider.example/v1/chat',
        requestBodyValues: {},
        statusCode: status,
        responseBody: JSON.stringify({ error: { message } }),
        isRetryable: status === 429,
    });

/**
 * Every shard of a review calls the same model. When the provider refuses it
 * for a reason no retry fixes (a spent cap, a revoked key), the rest of the
 * shards would fail the same way: 14k such failures in one day (Nov 2026).
 */
describe('judgeKodyRulesSharded — stops calling a provider that refused the review', () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`src/f${i}.ts`));
    const rules = [{ uuid: 'r1', rule: 'Name things well.' }] as any[];

    it('skips the remaining shards after terminal failures and counts them failed', async () => {
        // Google AI Studio answers a spent monthly cap with a 429, as seen in
        // production; retrying cannot clear it.
        const runJudge = jest.fn<ReturnType<RunJudge>, Parameters<RunJudge>>(
            async () => {
                throw refusal(
                    429,
                    'Your project has exceeded its monthly spending cap. Please go to AI Studio.',
                );
            },
        );

        const res = await judgeKodyRulesSharded({
            changedFiles: files,
            rules,
            runJudge,
            concurrency: 1,
        });

        expect(runJudge).toHaveBeenCalledTimes(2);
        expect(res.shardsRun).toBe(files.length);
        expect(res.shardsErrored).toBe(files.length);
        expect(res.providerRefusal).toBe('QUOTA_EXCEEDED');
    });

    it('stops the same way on a revoked key', async () => {
        const runJudge = jest.fn<ReturnType<RunJudge>, Parameters<RunJudge>>(
            async () => {
                throw refusal(401, 'Incorrect API key provided');
            },
        );

        const res = await judgeKodyRulesSharded({
            changedFiles: files,
            rules,
            runJudge,
            concurrency: 1,
        });

        expect(runJudge).toHaveBeenCalledTimes(2);
        expect(res.providerRefusal).toBe('AUTH_INVALID');
    });

    it('keeps calling through a temporary rate limit', async () => {
        const runJudge = jest.fn<ReturnType<RunJudge>, Parameters<RunJudge>>(
            async () => {
                throw refusal(429, 'Rate limit exceeded: requests per minute');
            },
        );

        await judgeKodyRulesSharded({
            changedFiles: files,
            rules,
            runJudge,
            concurrency: 1,
        });

        expect(runJudge).toHaveBeenCalledTimes(files.length);
    });

    it('does not stop for one refused request between successful ones', async () => {
        // A gateway that refuses one request on its content answers 403.
        let call = 0;
        const runJudge = jest.fn<ReturnType<RunJudge>, Parameters<RunJudge>>(
            async () => {
                call++;
                if (call === 1 || call === 3) throw refusal(403, 'Forbidden');
                return [];
            },
        );

        const res = await judgeKodyRulesSharded({
            changedFiles: files,
            rules,
            runJudge,
            concurrency: 1,
        });

        expect(runJudge).toHaveBeenCalledTimes(20);
        expect(res.shardsErrored).toBe(2);
        expect(res.providerRefusal).toBeUndefined();
    });

    it('does not add up two different kinds of terminal failure', async () => {
        let call = 0;
        const runJudge = jest.fn<ReturnType<RunJudge>, Parameters<RunJudge>>(
            async () => {
                call++;
                if (call === 1) throw refusal(401, 'Incorrect API key provided');
                if (call === 2) throw refusal(404, 'model not found');
                return [];
            },
        );

        const res = await judgeKodyRulesSharded({
            changedFiles: files,
            rules,
            runJudge,
            concurrency: 1,
        });

        expect(runJudge).toHaveBeenCalledTimes(20);
        expect(res.providerRefusal).toBeUndefined();
    });

    it('stops when the provider starts refusing in the middle of a review', async () => {
        let call = 0;
        const runJudge = jest.fn<ReturnType<RunJudge>, Parameters<RunJudge>>(
            async () => {
                call++;
                if (call <= 5) return [];
                throw refusal(429, 'Your project has exceeded its monthly spending cap.');
            },
        );

        const res = await judgeKodyRulesSharded({
            changedFiles: files,
            rules,
            runJudge,
            concurrency: 1,
        });

        expect(runJudge).toHaveBeenCalledTimes(7);
        expect(res.shardsRun).toBe(20);
        expect(res.shardsErrored).toBe(15);
        expect(res.providerRefusal).toBe('QUOTA_EXCEEDED');
    });

    // A reply that fails the wire schema twice throws with no HTTP status, and
    // its cause carries the model's own review. Its words are not the
    // provider's: "billing" and "does not exist" here are about the code.
    it('does not read a reply that failed the schema as a refusal', async () => {
        const offSchema = () =>
            new NoObjectGeneratedError({
                message: 'No object generated: response did not match schema.',
                text: '{}',
                cause: new TypeValidationError({
                    value: {
                        violations: [
                            {
                                ruleId: 1,
                                explanation:
                                    'Calls legacyBilling.charge(), which does not exist after this PR',
                            },
                        ],
                    },
                    cause: new Error('Invalid input'),
                }),
                response: {} as any,
                usage: {} as any,
                finishReason: 'stop',
            });
        const runJudge = jest.fn<ReturnType<RunJudge>, Parameters<RunJudge>>(
            async () => {
                throw offSchema();
            },
        );

        const res = await judgeKodyRulesSharded({
            changedFiles: files,
            rules,
            runJudge,
            concurrency: 1,
        });

        expect(runJudge).toHaveBeenCalledTimes(files.length);
        expect(res.providerRefusal).toBeUndefined();
    });

    it('does not stop for requests refused on their content', async () => {
        // OpenRouter answers a moderation flag with a 403.
        const runJudge = jest.fn<ReturnType<RunJudge>, Parameters<RunJudge>>(
            async () => {
                throw refusal(
                    403,
                    'Your chosen model requires moderation and your input was flagged for "violence"',
                );
            },
        );

        const res = await judgeKodyRulesSharded({
            changedFiles: files,
            rules,
            runJudge,
            concurrency: 1,
        });

        expect(runJudge).toHaveBeenCalledTimes(files.length);
        expect(res.providerRefusal).toBeUndefined();
    });

    // Shards run four at a time and land in any order: two refusals can come
    // back while two earlier requests are still on their way to succeeding.
    it('waits for the requests in flight before it calls two refusals a stop', async () => {
        let call = 0;
        const runJudge = jest.fn<ReturnType<RunJudge>, Parameters<RunJudge>>(
            async () => {
                call++;
                if (call === 1 || call === 2) {
                    await new Promise((r) => setTimeout(r, 20));
                    return [];
                }
                if (call === 3 || call === 4) throw refusal(403, 'Forbidden');
                return [];
            },
        );

        const res = await judgeKodyRulesSharded({
            changedFiles: files,
            rules,
            runJudge,
            concurrency: 4,
        });

        expect(runJudge).toHaveBeenCalledTimes(files.length);
        expect(res.shardsErrored).toBe(2);
        expect(res.providerRefusal).toBeUndefined();
    });

    it('stops once the requests in flight were refused too', async () => {
        let call = 0;
        const runJudge = jest.fn<ReturnType<RunJudge>, Parameters<RunJudge>>(
            async () => {
                call++;
                if (call <= 2) await new Promise((r) => setTimeout(r, 20));
                throw refusal(401, 'Incorrect API key provided');
            },
        );

        const res = await judgeKodyRulesSharded({
            changedFiles: files,
            rules,
            runJudge,
            concurrency: 4,
        });

        expect(runJudge).toHaveBeenCalledTimes(4);
        expect(res.shardsRun).toBe(files.length);
        expect(res.shardsErrored).toBe(files.length);
        expect(res.providerRefusal).toBe('AUTH_INVALID');
    });

    it('skips the PR-scope shard when the last file shards were refused', async () => {
        let call = 0;
        const runJudge = jest.fn<ReturnType<RunJudge>, Parameters<RunJudge>>(
            async () => {
                call++;
                if (call === 1) return [];
                throw refusal(401, 'Incorrect API key provided');
            },
        );

        const res = await judgeKodyRulesSharded({
            changedFiles: files.slice(0, 3),
            rules: [
                ...rules,
                { uuid: 'r2', rule: 'Describe the PR.', scope: KodyRulesScope.PULL_REQUEST },
            ] as any[],
            runJudge,
            concurrency: 1,
        });

        expect(runJudge).toHaveBeenCalledTimes(3);
        expect(res.shardsRun).toBe(4);
        expect(res.shardsErrored).toBe(3);
        expect(res.providerRefusal).toBe('AUTH_INVALID');
    });
});
