import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    KodyRulesScope,
    type IKodyRule,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    createReviewContextDelivery,
    REVIEW_CONTEXT_CONTENT_TYPE,
    REVIEW_CONTEXT_SOURCE,
} from '@libs/cli-review/domain/types/review-context.types';
import {
    judgeKodyRulesSharded,
    type RunJudge,
} from './kody-rules-sharded.judge';

const CONTEXT_BODY = 'CANARY β\nUse this evidence for every rule shard.';
const reviewContext = {
    source: REVIEW_CONTEXT_SOURCE,
    contentType: REVIEW_CONTEXT_CONTENT_TYPE,
    body: CONTEXT_BODY,
};

const changedFiles = [
    {
        filename: 'src/file.ts',
        patch: '+const value = 1;',
        patchWithLinesStr: '1 +const value = 1;',
    },
] as unknown as FileChange[];

const rules = [
    {
        uuid: 'file-rule',
        title: 'File rule',
        rule: 'Check each TypeScript file.',
        path: '**/*.ts',
        scope: KodyRulesScope.FILE,
    },
    {
        uuid: 'pr-rule',
        title: 'PR rule',
        rule: 'Check the pull request as a whole.',
        scope: KodyRulesScope.PULL_REQUEST,
    },
] satisfies Array<Partial<IKodyRule>>;

describe('Kody Rules review context delivery', () => {
    it('places the identical context before task content in every finding-producing shard', async () => {
        const prompts: string[] = [];
        const runJudge: RunJudge = async ({ user }) => {
            prompts.push(user);
            return [];
        };

        const result = await judgeKodyRulesSharded({
            changedFiles,
            rules,
            runJudge,
            reviewContext,
        });

        expect(prompts).toHaveLength(2);
        for (const prompt of prompts) {
            expect(prompt.split(CONTEXT_BODY)).toHaveLength(2);
            expect(prompt.indexOf('REVIEW_CONTEXT_BOUNDARY')).toBe(0);
            expect(prompt.indexOf('END REVIEW_CONTEXT_')).toBeLessThan(
                prompt.indexOf('<Rules>'),
            );
        }
        expect(result.reviewContextDeliveries).toEqual([
            createReviewContextDelivery(
                reviewContext,
                'kodus-rules-review-agent:src/file.ts',
                'file-shard',
            ),
            createReviewContextDelivery(
                reviewContext,
                'kodus-rules-review-agent:pull-request',
                'pr-shard',
            ),
        ]);
        expect(JSON.stringify(result.reviewContextDeliveries)).not.toContain(
            CONTEXT_BODY,
        );
    });

    it('omits review context from every shard when it is absent', async () => {
        const prompts: string[] = [];
        const runJudge: RunJudge = async ({ user }) => {
            prompts.push(user);
            return [];
        };

        await judgeKodyRulesSharded({ changedFiles, rules, runJudge });

        expect(prompts).toHaveLength(2);
        expect(
            prompts.every(
                (prompt) => !prompt.includes('REVIEW_CONTEXT_BOUNDARY'),
            ),
        ).toBe(true);
    });

    it('retains body-free receipts and safe diagnostics when every shard fails after delivery', async () => {
        const logger = { warn: jest.fn() };
        const error = new Error(`provider rejected ${CONTEXT_BODY}`);
        error.name = 'ProviderRequestError';
        Object.assign(error, { code: 'RATE_LIMITED' });
        const runJudge: RunJudge = async () => {
            throw error;
        };

        const result = await judgeKodyRulesSharded({
            changedFiles,
            rules,
            runJudge,
            reviewContext,
            logger,
        });

        expect(result.shardsErrored).toBe(2);
        expect(result.reviewContextDeliveries).toEqual([
            createReviewContextDelivery(
                reviewContext,
                'kodus-rules-review-agent:src/file.ts',
                'file-shard',
            ),
            createReviewContextDelivery(
                reviewContext,
                'kodus-rules-review-agent:pull-request',
                'pr-shard',
            ),
        ]);
        const serializedLogs = JSON.stringify(logger.warn.mock.calls);
        expect(serializedLogs).toContain('ProviderRequestError');
        expect(serializedLogs).toContain('RATE_LIMITED');
        expect(serializedLogs).toContain('request-scoped context');
        expect(serializedLogs).not.toContain(CONTEXT_BODY);
    });
});
