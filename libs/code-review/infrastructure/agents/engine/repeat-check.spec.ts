import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { LLM } from '@libs/llm/llm';
import { hasManagedModelKey } from '@libs/llm/managed-slot';

import {
    buildRepeatCheckPrompt,
    checkRepeats,
    repeatCandidates,
    occurrenceKeys,
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
            suggestionContent:
                'The CSV export drops the header row when the report is empty.',
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

    it('compares a finding with the earlier comment the finder linked it to, first, wherever that comment is', () => {
        const other = earlier({ suggestionId: 'other-bug' });
        const finding: RepeatCheckFinding = {
            label: 'bug',
            relevantFile: 'src/orders.ts',
            revisesSuggestionId: 'linked-bug',
        };
        expect(
            repeatCandidates(finding, [
                other,
                earlier({
                    suggestionId: 'linked-bug',
                    relevantFile: 'src/elsewhere.ts',
                }),
            ]).map((c) => c.suggestionId),
        ).toEqual(['linked-bug', 'other-bug']);
    });

    it('offers an applied comment on another file when the finding names what that change added', () => {
        const applied = earlier({
            suggestionId: 'drop-archived',
            relevantFile: 'src/items/list.ts',
            outcome: 'implemented',
            existingCode: 'return [...items];',
            improvedCode: 'return items.filter((i) => !i.archived);',
            suggestionContent: 'listActive returns archived items too.',
        });
        const finding: RepeatCheckFinding = {
            label: 'bug',
            relevantFile: 'src/items/report.ts',
            suggestionContent:
                'The report sums listActive, so items with archived set never count.',
        };
        expect(
            repeatCandidates(finding, [applied]).map((c) => c.suggestionId),
        ).toEqual(['drop-archived']);
    });

    it('does not offer that comment while it is not applied, or for common names alone', () => {
        const proposal = {
            suggestionId: 'drop-archived',
            relevantFile: 'src/items/list.ts',
            existingCode: 'return [...items];',
            improvedCode: 'return items.filter((i) => !i.archived);',
            suggestionContent: 'Drop them.',
        };
        const finding: RepeatCheckFinding = {
            label: 'bug',
            relevantFile: 'src/items/report.ts',
            suggestionContent: 'archived items never count in the report.',
        };
        expect(
            repeatCandidates(finding, [
                earlier({ ...proposal, outcome: 'not_implemented' }),
            ]),
        ).toEqual([]);
        expect(
            repeatCandidates(
                {
                    ...finding,
                    suggestionContent: 'The filter returns no items.',
                },
                [earlier({ ...proposal, outcome: 'implemented' })],
            ),
        ).toEqual([]);
    });

    it('reads only code names as what an applied change added, not its comments or strings', () => {
        const applied = earlier({
            suggestionId: 'drop-archived',
            relevantFile: 'src/items/list.ts',
            outcome: 'implemented',
            existingCode: 'return [...items];',
            improvedCode:
                "// Hidden from the dashboard\nlog('dashboard filter');\nreturn items;",
            suggestionContent: 'Do not list everything.',
        });
        const finding: RepeatCheckFinding = {
            label: 'bug',
            relevantFile: 'src/items/report.ts',
            suggestionContent: 'The dashboard shows a stale total.',
        };
        expect(repeatCandidates(finding, [applied])).toEqual([]);
    });

    it('reads a Rust change past its lifetimes', () => {
        const applied = earlier({
            suggestionId: 'first-or-none',
            relevantFile: 'src/items.rs',
            outcome: 'implemented',
            existingCode: 'fn first(xs: &[Item]) -> &Item { &xs[0] }',
            improvedCode:
                "fn first<'a>(xs: NonEmpty<'a, Item>) -> &'a Item { xs.head() }",
            suggestionContent: 'Require a non-empty input.',
        });
        const finding: RepeatCheckFinding = {
            label: 'bug',
            relevantFile: 'src/report.rs',
            suggestionContent:
                'The report builds a NonEmpty from user input, which fails the request.',
        };
        expect(
            repeatCandidates(finding, [applied]).map((c) => c.suggestionId),
        ).toEqual(['first-or-none']);
    });

    it("a rule finding's link is not trusted: rule reposts carry it too", () => {
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

describe('occurrenceKeys', () => {
    // Two entries meet under a key: the same occurrence by code.
    const sameOccurrenceByCode = (
        a: Parameters<typeof occurrenceKeys>[0],
        b: Parameters<typeof occurrenceKeys>[0],
    ) => occurrenceKeys(a).some((key) => occurrenceKeys(b).includes(key));

    const finding: RepeatCheckFinding = {
        label: 'kody_rules',
        brokenKodyRulesIds: ['rule-no-console'],
        relevantFile: 'src/orders.ts',
        existingCode: "console.log('order',\n    order)",
    };

    it('the same rule on the same code in the same file is the same occurrence', () => {
        expect(sameOccurrenceByCode(finding, ruleComment)).toBe(true);
    });

    it('reads an earlier entry by its rule ids, whatever its label', () => {
        expect(
            sameOccurrenceByCode(finding, { ...ruleComment, label: 'bug' }),
        ).toBe(true);
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
    it('gives the comparison the concrete downstream failure when a short title omits it', () => {
        const prompt = buildRepeatCheckPrompt([
            {
                finding: {
                    oneSentenceSummary: 'Handle offline inventory',
                    suggestionContent:
                        'Returning empty names during an outage removes the entire catalog.',
                },
                candidates: [ruleComment],
            },
        ]);
        expect(prompt).toContain(
            'Finding: Returning empty names during an outage removes the entire catalog.',
        );
    });

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
        expect(prompt).toContain(
            'another file where the earlier code is still in place',
        );
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
        const result = await checkRepeats(findings, [], {
            organizationId: 'org-1',
            byokConfig: slot,
        });
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
            organizationId: 'org-1',
            byokConfig: slot,
        });
        expect(result.kept).toEqual([]);
        expect(result.repeats).toEqual([
            { finding, earlier: ruleComment, by: 'code' },
        ]);
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('matches by code against the whole history, not only the candidates shown to the model', async () => {
        const newer = Array.from({ length: 15 }, (_, i) =>
            earlier({
                suggestionId: `newer-${i}`,
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-no-console'],
                existingCode: `console.log('step', ${i})`,
            }),
        );
        const finding = {
            label: 'kody_rules',
            brokenKodyRulesIds: ['rule-no-console'],
            relevantFile: 'src/orders.ts',
            existingCode: "console.log('order', order)",
        };

        const result = await checkRepeats([finding], [...newer, ruleComment], {
            organizationId: 'org-1',
            byokConfig: slot,
        });

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
            verdicts: [
                {
                    finding: 0,
                    verdict: 'same_occurrence',
                    earlierId: 'bug-old',
                },
                { finding: 1, verdict: 'new_place', earlierId: 'bug-old' },
            ],
        });

        const result = await checkRepeats([repeat, newPlace], [declined], {
            organizationId: 'org-1',
            byokConfig: slot,
            prNumber: 7,
        });

        expect(result.kept).toEqual([newPlace]);
        expect(result.repeats).toEqual([
            { finding: repeat, earlier: declined, by: 'model' },
        ]);
        expect(runSpy).toHaveBeenCalledTimes(1);
        expect(runSpy.mock.calls[0][0]).toMatchObject({
            organizationId: 'org-1',
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
            verdicts: [
                {
                    finding: 0,
                    verdict: 'same_occurrence',
                    earlierId: 'bug-old',
                },
            ],
        });

        const result = await checkRepeats([back], [applied], {
            organizationId: 'org-1',
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
            verdicts: [
                {
                    finding: 0,
                    verdict: 'same_occurrence',
                    earlierId: 'rule-old',
                },
            ],
        });

        const result = await checkRepeats([still], [applied], {
            organizationId: 'org-1',
            byokConfig: slot,
        });

        expect(result.kept).toEqual([]);
        expect(result.repeats[0].earlier).toBe(applied);
    });

    it('keeps a new place and identifies a finding caused by the earlier comment', async () => {
        const newPlace = { label: 'bug', relevantFile: 'src/retry.ts' };
        const consequence = { label: 'bug', relevantFile: 'src/retry.ts' };
        runSpy.mockResolvedValue({
            verdicts: [
                { finding: 0, verdict: 'new_place', earlierId: 'bug-old' },
                {
                    finding: 1,
                    verdict: 'caused_by_earlier',
                    earlierId: 'bug-old',
                },
            ],
        });

        const result = await checkRepeats(
            [newPlace, consequence],
            [bugComment],
            {
                organizationId: 'org-1',
                byokConfig: slot,
            },
        );

        expect(result.kept).toEqual([newPlace, consequence]);
        expect(result.repeats).toEqual([]);
        expect(result.revisions).toEqual([
            { finding: consequence, earlier: bugComment },
        ]);
    });

    it('does not post a finding that asks to undo what an earlier comment asked for', async () => {
        const reversal = {
            label: 'bug',
            relevantFile: 'src/retry.ts',
            revisesSuggestionId: 'bug-old',
        };
        const consequence = { label: 'bug', relevantFile: 'src/retry.ts' };
        runSpy.mockResolvedValue({
            verdicts: [
                {
                    finding: 0,
                    verdict: 'reverses_earlier',
                    earlierId: 'bug-old',
                },
                {
                    finding: 1,
                    verdict: 'caused_by_earlier',
                    earlierId: 'bug-old',
                },
            ],
        });

        const result = await checkRepeats(
            [reversal, consequence],
            [bugComment],
            { organizationId: 'org-1', byokConfig: slot },
        );

        expect(result.kept).toEqual([consequence]);
        expect(result.reversals).toEqual([
            { finding: reversal, earlier: bugComment, by: 'model' },
        ]);
        expect(result.revisions).toEqual([
            { finding: consequence, earlier: bugComment },
        ]);
    });

    it("does not link a caused-by verdict to an id absent from that finding's candidates", async () => {
        const unrelated = earlier({
            suggestionId: 'elsewhere',
            relevantFile: 'src/unrelated.ts',
        });
        const finding = { label: 'bug', relevantFile: 'src/retry.ts' };
        runSpy.mockResolvedValue({
            verdicts: [
                {
                    finding: 0,
                    verdict: 'caused_by_earlier',
                    earlierId: 'elsewhere',
                },
            ],
        });

        const result = await checkRepeats([finding], [bugComment, unrelated], {
            organizationId: 'org-1',
            byokConfig: slot,
        });

        expect(result.kept).toEqual([finding]);
        expect(result.revisions).toEqual([]);
    });

    it('does not treat a missing finding index as finding zero', async () => {
        const finding = { label: 'bug', relevantFile: 'src/retry.ts' };
        runSpy.mockResolvedValue({
            verdicts: [
                {
                    finding: null,
                    verdict: 'caused_by_earlier',
                    earlierId: 'bug-old',
                },
            ],
        });

        const result = await checkRepeats([finding], [bugComment], {
            organizationId: 'org-1',
            byokConfig: slot,
        });

        expect(result.kept).toEqual([finding]);
        expect(result.revisions).toEqual([]);
    });

    it('ignores an id the model was not offered for that finding', async () => {
        const other = earlier({
            suggestionId: 'elsewhere',
            relevantFile: 'src/unrelated.ts',
        });
        const finding = { label: 'bug', relevantFile: 'src/retry.ts' };
        runSpy.mockResolvedValue({
            verdicts: [
                {
                    finding: 0,
                    verdict: 'same_occurrence',
                    earlierId: 'elsewhere',
                },
            ],
        });

        const result = await checkRepeats([finding], [bugComment, other], {
            organizationId: 'org-1',
            byokConfig: slot,
        });

        expect(result.kept).toEqual([finding]);
    });

    it('reads an answer the model wrapped or sent as text', async () => {
        const finding = { label: 'bug', relevantFile: 'src/retry.ts' };
        runSpy.mockResolvedValue(
            JSON.stringify({
                result: {
                    verdicts: [
                        {
                            finding: 0,
                            verdict: 'same_occurrence',
                            earlierId: 'bug-old',
                        },
                    ],
                },
            }),
        );

        const result = await checkRepeats([finding], [bugComment], {
            organizationId: 'org-1',
            byokConfig: slot,
        });

        expect(result.repeats).toHaveLength(1);
    });

    it('a model failure preserves code matches and posts findings without a plausible repeat', async () => {
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
            { organizationId: 'org-1', byokConfig: slot },
        );

        expect(result.model).toBe('failed');
        expect(result.kept).toEqual([toJudge]);
        expect(result.repeats.map((r) => r.finding)).toEqual([byCode]);
    });

    it("without a verdict, holds a finder-linked finding on its comment's file and an answered point raised again in its file, and posts the rest", async () => {
        const answered = earlier({
            suggestionId: 'answered',
            relevantFile: 'src/label.ts',
            relevantLinesStart: 4,
            relevantLinesEnd: 5,
            answered: true,
            suggestionContent:
                'authorLabel renders undefined for a missing user.',
        });
        const linked = {
            label: 'bug',
            relevantFile: 'src/retry.ts',
            relevantLinesStart: 40,
            revisesSuggestionId: 'bug-old',
        };
        const linkedElsewhere = {
            label: 'bug',
            relevantFile: 'src/consumer.ts',
            revisesSuggestionId: 'bug-old',
        };
        // Lines moved since the earlier round: matched by what it says.
        const reraise = {
            label: 'bug',
            relevantFile: 'src/label.ts',
            relevantLinesStart: 9,
            relevantLinesEnd: 9,
            suggestionContent:
                'authorLabel renders undefined when the user is missing.',
        };
        // On the answered lines, but another problem.
        const elsewhere = {
            label: 'bug',
            relevantFile: 'src/label.ts',
            relevantLinesStart: 4,
            relevantLinesEnd: 5,
            suggestionContent:
                'The SQL built here interpolates userId; use a parameter.',
        };
        runSpy.mockRejectedValue(
            Object.assign(new Error('aborted'), { name: 'AbortError' }),
        );

        const result = await checkRepeats(
            [linked, linkedElsewhere, reraise, elsewhere],
            [bugComment, answered],
            { organizationId: 'org-1', byokConfig: slot },
        );

        expect(result.model).toBe('failed');
        expect(result.withheld).toEqual([linked, reraise]);
        expect(result.kept).toEqual([linkedElsewhere, elsewhere]);
    });

    it('shows the comparison which comments were applied or answered, and the link the finder set', () => {
        const prompt = buildRepeatCheckPrompt([
            {
                finding: {
                    label: 'bug',
                    relevantFile: 'src/a.ts',
                    revisesSuggestionId: 'applied',
                    suggestionContent: 'Re-admit configs on another host.',
                },
                candidates: [
                    earlier({
                        suggestionId: 'applied',
                        outcome: 'implemented',
                        improvedCode: 'c.hosts.includes(host)',
                    }),
                    earlier({ suggestionId: 'answered', answered: true }),
                ],
            },
        ]);
        expect(prompt).toContain(
            'The reviewer linked it to earlier comment applied.',
        );
        expect(prompt).toContain('Status: the developer applied it');
        expect(prompt).toContain('Code it proposed:\nc.hosts.includes(host)');
        expect(prompt).toContain(
            'Thread: the developer answered it in its thread',
        );
        expect(prompt).toContain('- reverses_earlier:');
    });

    it('after two timeouts withholds the repeated CSV claim and delivers the PDF claim under the same PR rule', async () => {
        const old = earlier({
            suggestionId: 'pr-comment-old',
            relevantFile: undefined,
            label: 'kody_rules',
            brokenKodyRulesIds: ['export-tests'],
            suggestionContent: 'The CSV export has no regression test.',
        });
        const repeat = {
            label: 'kody_rules',
            brokenKodyRulesIds: ['export-tests'],
            suggestionContent: old.suggestionContent,
        };
        const different = {
            ...repeat,
            suggestionContent: 'The PDF export has no regression test.',
        };
        runSpy.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
        const result = await checkRepeats([repeat, different], [old], {
            organizationId: 'org-1',
            byokConfig: slot,
        });
        expect(runSpy.mock.calls.map(([call]) => call.timeoutMs)).toEqual([
            120_000, 60_000,
        ]);
        expect(result.withheld).toEqual([repeat]);
        expect(result.kept).toEqual([different]);
        expect(result.repeats).toEqual([]);
    });

    it.each([
        {
            name: 'outer whitespace on the same claim',
            previous: 'Missing test for PDF.',
            current: '  Missing test for PDF.  ',
            hold: true,
        },
        {
            name: 'case-sensitive identifiers',
            previous: 'Missing test for `encodeID`.',
            current: 'Missing test for `encodeId`.',
            hold: false,
        },
        {
            name: 'different thresholds',
            previous: 'The retry limit must be 10.',
            current: 'The retry limit must be 100.',
            hold: false,
        },
        {
            name: 'a paraphrase without a verdict',
            previous: 'Missing test for PDF.',
            current: 'PDF export is untested.',
            hold: false,
        },
        {
            name: 'empty claim with only a summary',
            previous: '',
            current: '',
            hold: false,
        },
    ])('on timeout: $name', async ({ previous, current, hold }) => {
        const old = earlier({
            suggestionId: 'pr-comment-timeout',
            relevantFile: undefined,
            label: 'kody_rules',
            brokenKodyRulesIds: ['rule-a'],
            suggestionContent: previous,
        });
        const candidate = {
            label: 'kody_rules',
            brokenKodyRulesIds: ['rule-a'],
            oneSentenceSummary: 'Review the implementation',
            suggestionContent: current,
        };
        runSpy.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
        const result = await checkRepeats([candidate], [old], {
            organizationId: 'org-1',
            byokConfig: slot,
        });
        expect(runSpy).toHaveBeenCalledTimes(2);
        expect(result.kept).toEqual(hold ? [] : [candidate]);
        expect(result.withheld).toEqual(hold ? [candidate] : []);
    });

    it('on timeout, posts a PR-level finding linked to a PR-level comment', async () => {
        const old = earlier({
            suggestionId: 'pr-level-old',
            relevantFile: undefined,
            label: 'bug',
            suggestionContent: 'The migration has no rollback.',
        });
        const candidate = {
            label: 'bug',
            revisesSuggestionId: 'pr-level-old',
            suggestionContent: 'The release notes omit the new env flag.',
        };
        runSpy.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
        const result = await checkRepeats([candidate], [old], {
            organizationId: 'org-1',
            byokConfig: slot,
        });
        expect(result.kept).toEqual([candidate]);
        expect(result.withheld).toEqual([]);
    });

    it('retries only missing verdicts and lets an explicit new-place verdict through', async () => {
        const first = {
            label: 'bug',
            relevantFile: 'src/retry.ts',
            suggestionContent: 'first',
        };
        const second = { ...bugComment };
        runSpy
            .mockResolvedValueOnce({
                verdicts: [
                    {
                        finding: 0,
                        verdict: 'same_occurrence',
                        earlierId: 'bug-old',
                    },
                ],
            })
            .mockResolvedValueOnce({
                verdicts: [
                    { finding: 0, verdict: 'new_place', earlierId: null },
                ],
            });
        const result = await checkRepeats([first, second], [bugComment], {
            organizationId: 'org-1',
            byokConfig: slot,
        });
        expect(runSpy.mock.calls[1][0].user).toContain(
            `Finding: ${second.suggestionContent}`,
        );
        expect(runSpy.mock.calls[1][0].user).not.toContain('Finding: first');
        expect(result.kept).toEqual([second]);
        expect(result.repeats.map(({ finding }) => finding)).toEqual([first]);
        expect(result.model).toBe('ok');
    });

    it('without a model, posts what it could not match by code', async () => {
        hasManagedModelKeyMock.mockReturnValue(false);
        const finding = { ...bugComment };

        const result = await checkRepeats([finding], [bugComment], {
            organizationId: 'org-1',
        });

        expect(result.model).toBe('no-model');
        expect(result.kept).toEqual([finding]);
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('matches only a rule finding by code', async () => {
        hasManagedModelKeyMock.mockReturnValue(false);
        const bug = {
            label: 'bug',
            brokenKodyRulesIds: ['rule-no-console'],
            relevantFile: 'src/orders.ts',
            existingCode: "console.log('order', order)",
        };

        const result = await checkRepeats([bug], [ruleComment], {
            organizationId: 'org-1',
        });

        expect(result.kept).toEqual([bug]);
        expect(result.repeats).toEqual([]);
    });

    it('does not retry an invalid API key', async () => {
        runSpy.mockRejectedValue(
            Object.assign(new Error('invalid API key'), { status: 401 }),
        );
        await checkRepeats(
            [{ label: 'bug', relevantFile: 'src/retry.ts' }],
            [bugComment],
            { organizationId: 'org-1', byokConfig: slot },
        );
        expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it('limits both the initial batches and retries on a large review', async () => {
        const peak = new Map<number, number>();
        let active = 0;
        runSpy.mockImplementation(async ({ timeoutMs, user }) => {
            peak.set(timeoutMs, Math.max(peak.get(timeoutMs) ?? 0, ++active));
            await new Promise((resolve) => setImmediate(resolve));
            active--;
            if (timeoutMs === 120_000)
                throw new DOMException('timed out', 'TimeoutError');
            return {
                verdicts: [...user.matchAll(/<Finding n="(\d+)">/g)].map(
                    ([, n]) => ({
                        finding: Number(n),
                        verdict: 'different_problem',
                        earlierId: null,
                    }),
                ),
            };
        });
        const findings = Array.from({ length: 60 }, () => ({
            label: 'bug',
            relevantFile: 'src/retry.ts',
        }));
        const result = await checkRepeats(findings, [bugComment], {
            organizationId: 'org',
            byokConfig: slot,
        });
        expect([...peak.values()]).toEqual([4, 4]);
        expect(result.kept).toHaveLength(60);
    });

    it("runs at low reasoning effort on the team's model, whatever effort the review uses", async () => {
        runSpy.mockResolvedValue({ verdicts: [] });
        await checkRepeats(
            [{ label: 'bug', relevantFile: 'src/retry.ts' }],
            [bugComment],
            {
                organizationId: 'org-1',
                byokConfig: {
                    ...slot,
                    reasoningEffort: 'high',
                } as NormalizedModel,
            },
        );
        expect(runSpy.mock.calls[0][0].byokConfig).toMatchObject({
            provider: 'openai',
            model: 'm',
            reasoningEffort: 'low',
        });
    });

    it("keeps the org's reasoning override, which can carry its provider routing", async () => {
        runSpy.mockResolvedValue({ verdicts: [] });
        const override =
            '{"openrouter":{"provider":{"order":["deepinfra"],"allow_fallbacks":false,"data_collection":"deny","zdr":true},"reasoning":{"effort":"high"}}}';
        const team = {
            ...slot,
            reasoningEffort: 'high',
            reasoningConfigOverride: override,
        } as NormalizedModel;
        await checkRepeats(
            [{ label: 'bug', relevantFile: 'src/retry.ts' }],
            [bugComment],
            { organizationId: 'org-1', byokConfig: team },
        );
        expect(runSpy.mock.calls[0][0].byokConfig).toEqual(team);
    });

    it('judges ten findings per call', async () => {
        const findings = Array.from({ length: 23 }, (_, i) => ({
            label: 'bug',
            relevantFile: 'src/retry.ts',
            suggestionContent: `finding ${i}`,
        }));
        runSpy.mockImplementation(async ({ user }) => ({
            verdicts: [...user.matchAll(/<Finding n="(\d+)">/g)].map(
                ([, n]) => ({
                    finding: Number(n),
                    verdict: 'different_problem',
                    earlierId: null,
                }),
            ),
        }));

        const result = await checkRepeats(findings, [bugComment], {
            organizationId: 'org-1',
            byokConfig: slot,
        });

        expect(runSpy).toHaveBeenCalledTimes(3);
        expect(result.kept).toHaveLength(23);
    });
});
