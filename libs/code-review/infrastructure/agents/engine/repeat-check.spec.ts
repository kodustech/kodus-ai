import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { LLM } from '@libs/llm/llm';
import { hasManagedModelKey } from '@libs/llm/managed-slot';

import {
    buildRepeatCheckPrompt,
    checkRepeats,
    repeatCandidates,
    sameOccurrenceByCode,
    type RepeatCheckFinding,
} from './repeat-check';

// #2097: one problem keeps one thread for the life of the PR.
const earlier = (
    over: Partial<PrDecisionRecord> & { suggestionId: string },
): PrDecisionRecord => ({
    relevantFile: 'src/orders.ts',
    relevantLinesStart: 10,
    relevantLinesEnd: 10,
    suggestionContent: 'Earlier comment.',
    label: 'bug',
    outcome: 'pending',
    decidedAt: '2026-10-01T10:00:00Z',
    ...over,
});

const ruleComment = earlier({
    suggestionId: 'rule-old',
    label: 'kody_rules',
    brokenKodyRulesIds: ['rule-no-console'],
    existingCode: "console.log('order', order)",
    suggestionContent: 'Use the logger instead of console.log.',
});

const bugComment = earlier({
    suggestionId: 'bug-old',
    relevantFile: 'src/retry.ts',
    existingCode: 'if (attempt > max) return;',
    suggestionContent: 'The retry branch is unreachable.',
});

jest.mock('@libs/llm/managed-slot', () => ({
    ...jest.requireActual('@libs/llm/managed-slot'),
    hasManagedModelKey: jest.fn(() => true),
}));
const hasManagedModelKeyMock = hasManagedModelKey as jest.Mock;

const slot = { provider: 'openai', model: 'm' } as unknown as NormalizedModel;

describe('repeatCandidates', () => {
    it('offers earlier comments on the same file, of the same rule anywhere, and with the same code anywhere', () => {
        const sameFile = earlier({ suggestionId: 'same-file' });
        const sameRuleElsewhere = earlier({
            suggestionId: 'same-rule',
            relevantFile: 'src/other.ts',
            label: 'kody_rules',
            brokenKodyRulesIds: ['rule-no-console'],
        });
        const sameCodeElsewhere = earlier({
            suggestionId: 'same-code',
            relevantFile: 'src/moved-from.ts',
            existingCode: "console.log('order',   order)",
        });
        const unrelated = earlier({
            suggestionId: 'unrelated',
            relevantFile: 'src/unrelated.ts',
        });
        const finding: RepeatCheckFinding = {
            label: 'kody_rules',
            brokenKodyRulesIds: ['rule-no-console'],
            relevantFile: './src/orders.ts',
            existingCode: "console.log('order', order)",
        };

        expect(
            repeatCandidates(finding, [
                sameFile,
                sameRuleElsewhere,
                sameCodeElsewhere,
                unrelated,
            ]).map((c) => c.suggestionId),
        ).toEqual(['same-file', 'same-rule', 'same-code']);
    });

    it('offers an earlier comment on another file when its text is close: code that moved and changed', () => {
        const moved = earlier({
            suggestionId: 'moved',
            relevantFile: 'src/billing/poller.ts',
            suggestionContent:
                'pollCharge resubmits the charge on NotReadyError, but gw.submit is not idempotent, so every tick creates a duplicate charge.',
        });
        const unrelated = earlier({
            suggestionId: 'unrelated',
            relevantFile: 'src/reports/export.ts',
            suggestionContent: 'The CSV export drops the header row when the report is empty.',
        });
        const finding: RepeatCheckFinding = {
            label: 'bug',
            relevantFile: 'src/billing/tick.ts',
            suggestionContent:
                'tick resubmits the charge when NotReadyError is thrown; gw.submit is not idempotent, so the charge is duplicated on every tick.',
        };

        expect(
            repeatCandidates(finding, [moved, unrelated]).map(
                (c) => c.suggestionId,
            ),
        ).toEqual(['moved']);
    });

    it('a rule finding is never compared with a comment about another rule, even on the same lines', () => {
        const otherRuleComment = earlier({
            suggestionId: 'other-rule',
            label: 'kody_rules',
            brokenKodyRulesIds: ['rule-structured-logs'],
        });
        const bugOnSameLines = earlier({ suggestionId: 'bug-same-lines' });
        expect(
            repeatCandidates(
                {
                    label: 'kody_rules',
                    brokenKodyRulesIds: ['rule-no-pii-in-logs'],
                    relevantFile: 'src/orders.ts',
                },
                [otherRuleComment, bugOnSameLines],
            ).map((c) => c.suggestionId),
        ).toEqual(['bug-same-lines']);
    });

    it('a bug finding the finder linked to an earlier comment is not compared with that comment', () => {
        const other = earlier({ suggestionId: 'other-bug' });
        const finding: RepeatCheckFinding = {
            label: 'bug',
            relevantFile: 'src/orders.ts',
            revisesSuggestionId: 'linked-bug',
        };
        expect(
            repeatCandidates(finding, [
                earlier({ suggestionId: 'linked-bug' }),
                other,
            ]).map((c) => c.suggestionId),
        ).toEqual(['other-bug']);
    });

    it('a rule finding\'s link is not trusted: rule reposts carry it too', () => {
        expect(
            repeatCandidates(
                {
                    label: 'kody_rules',
                    brokenKodyRulesIds: ['rule-no-console'],
                    relevantFile: 'src/orders.ts',
                    revisesSuggestionId: 'rule-old',
                },
                [ruleComment],
            ).map((c) => c.suggestionId),
        ).toEqual(['rule-old']);
    });

    it('a PR-level rule finding is compared with the earlier comments of its rule', () => {
        const prLevel = earlier({
            suggestionId: 'pr-comment-1',
            relevantFile: undefined,
            label: 'kody_rules',
            brokenKodyRulesIds: ['rule-pr-description'],
        });
        expect(
            repeatCandidates(
                {
                    label: 'kody_rules',
                    brokenKodyRulesIds: ['rule-pr-description'],
                },
                [prLevel, ruleComment],
            ).map((c) => c.suggestionId),
        ).toEqual(['pr-comment-1']);
    });
});

describe('sameOccurrenceByCode', () => {
    const finding: RepeatCheckFinding = {
        label: 'kody_rules',
        brokenKodyRulesIds: ['rule-no-console'],
        relevantFile: 'src/orders.ts',
        existingCode: "console.log('order',\n    order)",
    };

    it('the same rule on the same code in the same file is the same occurrence', () => {
        expect(sameOccurrenceByCode(finding, ruleComment)).toBe(true);
    });

    it('a different rule on the same code is not', () => {
        expect(
            sameOccurrenceByCode(
                { ...finding, brokenKodyRulesIds: ['rule-no-pii-in-logs'] },
                ruleComment,
            ),
        ).toBe(false);
    });

    it('the same code in another file is left to the model: moved and copied look alike', () => {
        expect(
            sameOccurrenceByCode(
                { ...finding, relevantFile: 'src/invoices.ts' },
                ruleComment,
            ),
        ).toBe(false);
    });

    it('a bug finding is never matched by code alone', () => {
        expect(
            sameOccurrenceByCode(
                {
                    label: 'bug',
                    relevantFile: 'src/retry.ts',
                    existingCode: 'if (attempt > max) return;',
                },
                bugComment,
            ),
        ).toBe(false);
    });
});

describe('buildRepeatCheckPrompt', () => {
    it('names rules by title and shows each finding with its own earlier comments', () => {
        const prompt = buildRepeatCheckPrompt(
            [
                {
                    finding: {
                        label: 'kody_rules',
                        brokenKodyRulesIds: ['rule-no-console'],
                        relevantFile: 'src/orders.ts',
                        relevantLinesStart: 12,
                        relevantLinesEnd: 12,
                        oneSentenceSummary: 'console.log in the order flow',
                        existingCode: "console.log('order')",
                    },
                    candidates: [ruleComment],
                },
            ],
            new Map([['rule-no-console', 'Use the logger']]),
        );

        expect(prompt).toContain('<Finding n="0">');
        expect(prompt).toContain('Where: src/orders.ts:12-12');
        expect(prompt).toContain('Kind: Kody Rule "Use the logger"');
        expect(prompt).toContain('<Earlier id="rule-old">');
        expect(prompt).toContain('Use the logger instead of console.log.');
        expect(prompt).toContain('another file where the earlier code is still in place');
        expect(prompt).toContain('caused_by_earlier');
    });
});

describe('checkRepeats', () => {
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        runSpy = jest.spyOn(LLM, 'run');
        hasManagedModelKeyMock.mockReturnValue(true);
    });

    afterEach(() => jest.restoreAllMocks());

    it('without history, posts everything and calls no model', async () => {
        const findings = [{ label: 'bug', relevantFile: 'src/a.ts' }];
        const result = await checkRepeats(findings, [], { byokConfig: slot });
        expect(result.kept).toEqual(findings);
        expect(result.model).toBe('not-needed');
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('drops a rule finding on unchanged code without a model call', async () => {
        const finding = {
            label: 'kody_rules',
            brokenKodyRulesIds: ['rule-no-console'],
            relevantFile: 'src/orders.ts',
            existingCode: "console.log('order', order)",
        };
        const result = await checkRepeats([finding], [ruleComment], {
            byokConfig: slot,
        });
        expect(result.kept).toEqual([]);
        expect(result.repeats).toEqual([
            { finding, earlier: ruleComment, by: 'code' },
        ]);
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('drops what the model calls the same occurrence of a pending or declined comment, and keeps the rest', async () => {
        const declined = { ...bugComment, outcome: 'not_implemented' as const };
        const repeat = {
            label: 'bug',
            relevantFile: 'src/retry.ts',
            existingCode: 'if (attempt >= max) return;',
            suggestionContent: 'Retry never runs.',
        };
        const newPlace = {
            label: 'bug',
            relevantFile: 'src/retry.ts',
            existingCode: 'if (tries > limit) return;',
            suggestionContent: 'Same pattern in the webhook retry.',
        };
        runSpy.mockResolvedValue({
            verdicts: [{ finding: 0, verdict: 'same_occurrence', earlierId: 'bug-old' }],
        });

        const result = await checkRepeats([repeat, newPlace], [declined], {
            byokConfig: slot,
            prNumber: 7,
        });

        expect(result.kept).toEqual([newPlace]);
        expect(result.repeats).toEqual([
            { finding: repeat, earlier: declined, by: 'model' },
        ]);
        expect(runSpy).toHaveBeenCalledTimes(1);
        expect(runSpy.mock.calls[0][0]).toMatchObject({
            byokConfig: slot,
            spanName: 'code-review::repeat-check',
        });
    });

    // A stored "implemented" cannot tell a fix that came back from one that
    // was never complete: the earlier thread stays the one for that problem.
    it('a bug still there after its comment was applied is not posted', async () => {
        const applied = { ...bugComment, outcome: 'implemented' as const };
        const back: RepeatCheckFinding = {
            label: 'bug',
            relevantFile: 'src/retry.ts',
            suggestionContent: 'The retry branch is unreachable again.',
        };
        runSpy.mockResolvedValue({
            verdicts: [{ finding: 0, verdict: 'same_occurrence', earlierId: 'bug-old' }],
        });

        const result = await checkRepeats([back], [applied], {
            byokConfig: slot,
        });

        expect(result.kept).toEqual([]);
        expect(result.repeats).toEqual([
            { finding: back, earlier: applied, by: 'model' },
        ]);
        expect(back.revisesSuggestionId).toBeUndefined();
    });

    it('a rule still there after its comment was applied is not posted', async () => {
        const applied = {
            ...ruleComment,
            outcome: 'partially_implemented' as const,
        };
        const still = {
            label: 'kody_rules',
            brokenKodyRulesIds: ['rule-no-console'],
            relevantFile: 'src/orders.ts',
            existingCode: "console.info('order', order.id)",
        };
        runSpy.mockResolvedValue({
            verdicts: [{ finding: 0, verdict: 'same_occurrence', earlierId: 'rule-old' }],
        });

        const result = await checkRepeats([still], [applied], {
            byokConfig: slot,
        });

        expect(result.kept).toEqual([]);
        expect(result.repeats[0].earlier).toBe(applied);
    });

    it('posts a finding the model calls a new place or caused by the earlier comment', async () => {
        const newPlace = { label: 'bug', relevantFile: 'src/retry.ts' };
        const consequence = { label: 'bug', relevantFile: 'src/retry.ts' };
        runSpy.mockResolvedValue({
            verdicts: [
                { finding: 0, verdict: 'new_place', earlierId: 'bug-old' },
                { finding: 1, verdict: 'caused_by_earlier', earlierId: 'bug-old' },
            ],
        });

        const result = await checkRepeats([newPlace, consequence], [bugComment], {
            byokConfig: slot,
        });

        expect(result.kept).toEqual([newPlace, consequence]);
        expect(result.repeats).toEqual([]);
    });

    it('ignores an id the model was not offered for that finding', async () => {
        const other = earlier({
            suggestionId: 'elsewhere',
            relevantFile: 'src/unrelated.ts',
        });
        const finding = { label: 'bug', relevantFile: 'src/retry.ts' };
        runSpy.mockResolvedValue({
            verdicts: [{ finding: 0, verdict: 'same_occurrence', earlierId: 'elsewhere' }],
        });

        const result = await checkRepeats([finding], [bugComment, other], {
            byokConfig: slot,
        });

        expect(result.kept).toEqual([finding]);
    });

    it('reads an answer the model wrapped or sent as text', async () => {
        const finding = { label: 'bug', relevantFile: 'src/retry.ts' };
        runSpy.mockResolvedValue(
            JSON.stringify({
                result: { verdicts: [{ finding: 0, verdict: 'same_occurrence', earlierId: 'bug-old' }] },
            }),
        );

        const result = await checkRepeats([finding], [bugComment], {
            byokConfig: slot,
        });

        expect(result.repeats).toHaveLength(1);
    });

    it('fails open: a model error posts the findings it had to judge, code matches still hold', async () => {
        const byCode = {
            label: 'kody_rules',
            brokenKodyRulesIds: ['rule-no-console'],
            relevantFile: 'src/orders.ts',
            existingCode: "console.log('order', order)",
        };
        const toJudge = { label: 'bug', relevantFile: 'src/retry.ts' };
        runSpy.mockRejectedValue(new Error('provider 500'));

        const result = await checkRepeats(
            [byCode, toJudge],
            [ruleComment, bugComment],
            { byokConfig: slot },
        );

        expect(result.model).toBe('failed');
        expect(result.kept).toEqual([toJudge]);
        expect(result.repeats.map((r) => r.finding)).toEqual([byCode]);
    });

    it('without a model, posts what it could not match by code', async () => {
        hasManagedModelKeyMock.mockReturnValue(false);
        const finding = { label: 'bug', relevantFile: 'src/retry.ts' };

        const result = await checkRepeats([finding], [bugComment]);

        expect(result.model).toBe('no-model');
        expect(result.kept).toEqual([finding]);
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('judges ten findings per call', async () => {
        const findings = Array.from({ length: 23 }, (_, i) => ({
            label: 'bug',
            relevantFile: 'src/retry.ts',
            suggestionContent: `finding ${i}`,
        }));
        runSpy.mockResolvedValue({ verdicts: [] });

        const result = await checkRepeats(findings, [bugComment], {
            byokConfig: slot,
        });

        expect(runSpy).toHaveBeenCalledTimes(3);
        expect(result.kept).toHaveLength(23);
    });
});
