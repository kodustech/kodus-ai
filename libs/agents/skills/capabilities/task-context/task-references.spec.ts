import {
    extractAris,
    extractIssueKeys,
    extractIssueNumbers,
    extractLinks,
    isLikelyIssueKey,
    isLikelyTaskReferenceUrl,
    isLikelyUrl,
} from './task-references';

describe('task-references (characterization)', () => {
    it('extractIssueKeys finds JIRA-style keys, uppercased and deduped', () => {
        expect(extractIssueKeys('see PROJ-12 and proj-12 plus ABC-7')).toEqual([
            'PROJ-12',
            'ABC-7',
        ]);
    });

    it('extractIssueNumbers finds #-style issue numbers', () => {
        expect(
            extractIssueNumbers('fixes #42 and issue 7').sort((a, b) => a - b),
        ).toEqual([7, 42]);
    });

    it('extractLinks pulls + normalizes urls, dropping trailing punctuation', () => {
        expect(
            extractLinks('docs at (https://x.com/a). also https://x.com/a'),
        ).toEqual(['https://x.com/a']);
    });

    it('extractAris finds atlassian ARIs', () => {
        expect(extractAris('ref ari:cloud:jira::issue/123 here')).toEqual([
            'ari:cloud:jira::issue/123',
        ]);
    });

    it('isLikelyIssueKey / isLikelyUrl predicates', () => {
        expect(isLikelyIssueKey('PROJ-12')).toBe(true);
        expect(isLikelyIssueKey('not-a-key')).toBe(false);
        expect(isLikelyUrl('https://x.com')).toBe(true);
        expect(isLikelyUrl('x.com')).toBe(false);
    });

    it('isLikelyTaskReferenceUrl recognizes known trackers and task-shaped paths', () => {
        expect(
            isLikelyTaskReferenceUrl('https://acme.atlassian.net/browse/AB-1'),
        ).toBe(true);
        expect(isLikelyTaskReferenceUrl('https://linear.app/x/issue/AB-1')).toBe(
            true,
        );
        expect(isLikelyTaskReferenceUrl('https://example.com/blog/post')).toBe(
            false,
        );
        expect(isLikelyTaskReferenceUrl('not a url')).toBe(false);
    });
});
