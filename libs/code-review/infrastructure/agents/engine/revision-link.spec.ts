import { applyRevisionLinks } from './revision-link';
import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';

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
});
