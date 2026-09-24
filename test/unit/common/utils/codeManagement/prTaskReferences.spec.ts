import { extractTaskReferenceLines } from '@libs/common/utils/codeManagement/prTaskReferences';

describe('extractTaskReferenceLines', () => {
    it('keeps a closing keyword line so the provider link survives a replaced description', () => {
        expect(
            extractTaskReferenceLines(
                'Closes #993\n\nAdds a per-second rate limiter.',
            ),
        ).toEqual(['Closes #993']);
    });

    it('keeps every closing keyword variant', () => {
        expect(
            extractTaskReferenceLines(
                'Fixes #12\nResolved #13\nresolves #14\nfixed #15',
            ),
        ).toEqual(['Fixes #12', 'Resolved #13', 'resolves #14', 'fixed #15']);
    });

    it('keeps a bare issue reference', () => {
        expect(extractTaskReferenceLines('Related to #42')).toEqual([
            'Related to #42',
        ]);
    });

    it('keeps a jira-style key', () => {
        expect(extractTaskReferenceLines('Implements PROJ-42')).toEqual([
            'Implements PROJ-42',
        ]);
    });

    it('keeps an issue url', () => {
        expect(
            extractTaskReferenceLines(
                'See https://github.com/acme/repo/issues/993 for context',
            ),
        ).toEqual(['See https://github.com/acme/repo/issues/993 for context']);
    });

    it('drops prose that carries no reference', () => {
        expect(
            extractTaskReferenceLines(
                'This refactors the sender.\nIt also adds tests.',
            ),
        ).toEqual([]);
    });

    it('does not preserve references from a previous kody summary block', () => {
        const body = [
            'Closes #993',
            '',
            '<!-- kody-pr-summary:start -->',
            'This PR changes #77 and PROJ-9 behaviour.',
            '<!-- kody-pr-summary:end -->',
        ].join('\n');

        expect(extractTaskReferenceLines(body)).toEqual(['Closes #993']);
    });

    it('ignores a long prose paragraph that happens to mention an issue', () => {
        const long = `Some very long paragraph about #993 ${'x'.repeat(300)}`;
        expect(extractTaskReferenceLines(long)).toEqual([]);
    });

    it('deduplicates repeated reference lines', () => {
        expect(
            extractTaskReferenceLines('Closes #993\nCloses #993'),
        ).toEqual(['Closes #993']);
    });

    it('caps how much of the old description can come back', () => {
        const body = Array.from({ length: 30 }, (_, i) => `Closes #${i + 1}`).join(
            '\n',
        );
        expect(extractTaskReferenceLines(body)).toHaveLength(10);
    });

    it('returns nothing for an empty body', () => {
        expect(extractTaskReferenceLines('')).toEqual([]);
        expect(extractTaskReferenceLines(undefined as unknown as string)).toEqual(
            [],
        );
    });

    it('ignores a markdown heading that only looks like a reference', () => {
        expect(extractTaskReferenceLines('### Changes')).toEqual([]);
    });
});
