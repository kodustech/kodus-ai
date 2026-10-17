import {
    applyDedupFollowup,
    buildDedupFollowupPrompt,
    buildTiebreakPrompt,
    unclassifiedDedupIndices,
} from './dedup-prompt';

describe('dedup follow-up for left-out indices', () => {
    const groups = [{ keep: 0, duplicates: [1] }];
    const unique = [2, 3];

    it('lists the indices missing from keep, duplicates and unique', () => {
        expect(unclassifiedDedupIndices(6, groups, unique)).toEqual([4, 5]);
        expect(unclassifiedDedupIndices(4, groups, unique)).toEqual([]);
    });

    it('joins a group as a duplicate', () => {
        const r = applyDedupFollowup(5, groups, unique, [4], [
            { index: 4, joinWith: 1 },
        ]);
        expect(r.groups).toEqual([{ keep: 0, duplicates: [1, 4] }]);
        expect(r.unique).toEqual([2, 3]);
    });

    it('turns a unique suggestion into the kept one of a new group', () => {
        const r = applyDedupFollowup(5, groups, unique, [4], [
            { index: 4, joinWith: 2 },
        ]);
        expect(r.groups).toContainEqual({ keep: 2, duplicates: [4] });
        expect(r.unique).toEqual([3]);
    });

    it('groups left-out suggestions that only join each other, cycles included', () => {
        const r = applyDedupFollowup(7, groups, unique, [4, 5, 6], [
            { index: 4, joinWith: 5 },
            { index: 5, joinWith: 4 },
            { index: 6, joinWith: 4 },
        ]);
        expect(r.groups).toContainEqual({ keep: 4, duplicates: [5, 6] });
    });

    it('makes joinWith -1 or an invalid index unique, and leaves an unanswered index out', () => {
        const r = applyDedupFollowup(7, groups, unique, [4, 5, 6], [
            { index: 4, joinWith: -1 },
            { index: 5, joinWith: 99 },
        ]);
        expect(r.unique).toEqual([2, 3, 4, 5]);
        expect(unclassifiedDedupIndices(7, r.groups, r.unique)).toEqual([6]);
    });

    it('shows what was decided and only asks for the left-out indices', () => {
        const s = (i: number) => ({
            relevantFile: 'a.ts',
            relevantLinesStart: i,
            relevantLinesEnd: i,
            suggestionContent: `problem ${i}`,
        });
        const p = buildDedupFollowupPrompt([0, 1, 2, 3, 4].map(s), groups, [2], [3, 4]);
        expect(p).toContain('left out 2 of them: [3], [4]');
        expect(p).toContain('[0] a.ts:0-0 [unknown]: problem 0');
        expect(p).toContain('duplicates already in this group: [1]');
        expect(p).toContain('[2] a.ts:2-2 [unknown]: problem 2');
        expect(p).toContain('[4] a.ts:4-4 [unknown]: problem 4');
    });
});

describe('dedup tiebreak prompt', () => {
    it('writes only the fields that carry something', () => {
        const p = buildTiebreakPrompt(
            { suggestionContent: 'A details' },
            { suggestionContent: 'B details', improvedCode: 'fix()' },
        );
        expect(p).toContain('Details: A details');
        expect(p).toContain('Suggested fix: fix()');
        expect(p).not.toContain('Summary:');
        expect(p).not.toContain('Existing code:');
    });
});
