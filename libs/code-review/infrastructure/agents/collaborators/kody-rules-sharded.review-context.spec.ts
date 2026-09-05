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
            expect(prompt.indexOf('<ReviewContext')).toBe(0);
            expect(prompt.indexOf('</ReviewContext>')).toBeLessThan(
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
            prompts.every((prompt) => !prompt.includes('<ReviewContext')),
        ).toBe(true);
    });
});
