import { applyRevisionLinks } from './revision-link';
import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import { toRecordFromPrLevel } from '@libs/code-review/infrastructure/adapters/services/pr-decision-store.service';
import { formatPreviousDecisions } from '@libs/code-review/infrastructure/agents/prompts/prompt-builder';

// #2039: the finding against the result of Kody's own earlier suggestion never
// said so; the reader could not tell it was a revision.
const prior: PrDecisionRecord = {
    suggestionId: 'sug-1',
    relevantFile: 'src/billing/status.ts',
    relevantLinesStart: 8,
    relevantLinesEnd: 10,
    suggestionContent: 'Propagate NotReadyError instead of wrapping it.',
    label: 'bug',
    outcome: 'implemented',
    decidedAt: '2026-09-30T14:05:00Z',
};

describe('applyRevisionLinks (#2039/#2020)', () => {
    it('a finding naming an earlier suggestion says which one, before its text', () => {
        const s = [
            {
                revisesSuggestionId: 'sug-1',
                suggestionContent: 'The poller now resubmits.',
            },
        ];
        expect(applyRevisionLinks(s, [prior])).toBe(1);
        expect(s[0].suggestionContent).toBe(
            '**Revises an earlier Kody suggestion** on `src/billing/status.ts:8` (2026-09-30 14:05 UTC).\n\nThe poller now resubmits.',
        );
    });

    it('an id that matches no earlier suggestion is dropped, not rendered', () => {
        const s = [{ revisesSuggestionId: 'made-up', suggestionContent: 'x' }];
        expect(applyRevisionLinks(s, [prior])).toBe(0);
        expect(s[0]).toEqual({ suggestionContent: 'x' });
    });

    it('applied twice, the line appears once', () => {
        const s = [{ revisesSuggestionId: 'sug-1', suggestionContent: 'x' }];
        applyRevisionLinks(s, [prior]);
        applyRevisionLinks(s, [prior]);
        expect(
            s[0].suggestionContent.match(/Revises an earlier/g),
        ).toHaveLength(1);
    });

    it('no id, or no earlier decisions → untouched', () => {
        const s = [{ suggestionContent: 'x' }];
        expect(applyRevisionLinks(s, undefined)).toBe(0);
        expect(s[0].suggestionContent).toBe('x');
    });

    it('carries the reference into the full explanation the agent surfaces read, once', () => {
        const s = [
            {
                revisesSuggestionId: 'sug-1',
                suggestionContent: 'Short body.',
                fullExplanation: 'The whole explanation.',
                llmPrompt: 'Title\n\nThe whole explanation.',
            },
        ];
        applyRevisionLinks(s, [prior]);
        applyRevisionLinks(s, [prior]);
        expect(s[0].fullExplanation).toMatch(
            /^\*\*Revises an earlier Kody suggestion\*\*.*\n\nThe whole explanation\.$/s,
        );
        expect(s[0].fullExplanation.match(/Revises an earlier/g)).toHaveLength(
            1,
        );
        expect(s[0].llmPrompt.match(/Revises an earlier/g)).toHaveLength(1);
    });

    it('keeps the published reference in the correction prompt, without duplicating it', () => {
        const s = [
            {
                revisesSuggestionId: 'sug-1',
                suggestionContent: 'Formatted finding.',
                llmPrompt: 'Formatted finding.',
            },
        ];
        applyRevisionLinks(s, [prior]);
        applyRevisionLinks(s, [prior]);
        expect(s[0].llmPrompt).toBe(s[0].suggestionContent);
        expect(s[0].llmPrompt.match(/Revises an earlier/g)).toHaveLength(1);
    });

    it('resolves two stored PR-level comments for the same rule independently', () => {
        const fromStored = (
            id: number,
            createdAt: string,
            suggestionContent: string,
        ) =>
            toRecordFromPrLevel({
                id: 'rule-1',
                comment: { id, pullRequestReviewId: null },
                createdAt,
                suggestionContent,
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-1'],
            } as any);
        const newer = fromStored(102, '2026-10-03T11:00:00Z', 'Newer problem');
        const older = fromStored(
            101,
            '2026-10-02T10:00:00Z',
            'Different older problem',
        );
        const history = [newer, older];
        expect(newer.suggestionId).not.toBe(older.suggestionId);
        const prompt = formatPreviousDecisions(history);
        expect(prompt).toContain(`Id: ${newer.suggestionId}`);
        expect(prompt).toContain(`Id: ${older.suggestionId}`);
        const s = [
            {
                revisesSuggestionId: newer.suggestionId,
                suggestionContent: 'Revision of newer problem',
            },
        ];
        expect(applyRevisionLinks(s, history)).toBe(1);
        expect(s[0].suggestionContent).toContain('2026-10-03 11:00 UTC');
        expect(s[0].suggestionContent).not.toContain('2026-10-02 10:00 UTC');
    });

    it('does not select an arbitrary record when a reference is ambiguous', () => {
        const s = [
            { revisesSuggestionId: 'sug-1', suggestionContent: 'Revision' },
        ];
        expect(
            applyRevisionLinks(s, [
                prior,
                { ...prior, suggestionContent: 'Another problem' },
            ]),
        ).toBe(0);
        expect(s[0]).toEqual({ suggestionContent: 'Revision' });
    });
});
