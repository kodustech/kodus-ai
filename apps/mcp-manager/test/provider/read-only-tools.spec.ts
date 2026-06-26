import { defaultReadOnlyToolSlugs } from '../../src/modules/providers/read-only-tools';

describe('defaultReadOnlyToolSlugs', () => {
    it('scopes to read-only tools when the server annotates them', () => {
        expect(
            defaultReadOnlyToolSlugs([
                { slug: 'get_issue', readOnly: true },
                { slug: 'search_issues', readOnly: true },
                { slug: 'create_issue', readOnly: false },
                { slug: 'delete_issue' },
            ]),
        ).toEqual(['get_issue', 'search_issues']);
    });

    it('falls back to all tools when none are annotated read-only', () => {
        expect(
            defaultReadOnlyToolSlugs([
                { slug: 'do_a' },
                { slug: 'do_b' },
            ]),
        ).toEqual(['do_a', 'do_b']);
    });

    it('returns all when every tool is read-only', () => {
        expect(
            defaultReadOnlyToolSlugs([
                { slug: 'a', readOnly: true },
                { slug: 'b', readOnly: true },
            ]),
        ).toEqual(['a', 'b']);
    });

    it('handles an empty list', () => {
        expect(defaultReadOnlyToolSlugs([])).toEqual([]);
    });
});
