import { htmlToText, linksIn } from './task-payload';

describe('htmlToText', () => {
    it('keeps the text and the list layout of a tracker field', () => {
        expect(
            htmlToText(
                '<div>Let buyers pay.</div><ul><li>Total drops</li><li>Balance shown</li></ul>',
            ),
        ).toBe('Let buyers pay.\n- Total drops\n- Balance shown');
    });

    it('leaves no tag behind, whatever the field holds', () => {
        const text = htmlToText(
            '<div>Hi <iframe src="x"></iframe><scr<script>ipt>alert(1)</script> &lt;img onerror=x&gt;</div>',
        );
        expect(text).not.toMatch(/</);
        expect(text).toContain('Hi');
    });

    it('removes a tag it does not list by name too', () => {
        const text = htmlToText(
            '<section>Total drops<svg onload="x"></svg></section><p>Balance shown</p>',
        );
        expect(text).not.toMatch(/</);
        expect(text).toContain('Total drops');
    });

    it('keeps generics in a field that is HTML', () => {
        expect(
            htmlToText(
                '<div>Returns Array<string> sorted, as Map<String, List<Order>></div>',
            ),
        ).toBe(
            'Returns Array&lt;string> sorted, as Map&lt;String, List&lt;Order>>',
        );
    });

    it('costs linear time on markup nested to any depth', () => {
        const nested = `<div>${'<scr'.repeat(20_000)}ipt>${'ipt>'.repeat(20_000)}x</div>`;
        const started = Date.now();
        const text = htmlToText(nested);
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(text).not.toMatch(/</);
    });

    it('returns text without HTML as is, generics included', () => {
        expect(htmlToText('Returns Array<string> sorted')).toBe(
            'Returns Array<string> sorted',
        );
    });
});

describe('linksIn: a task record names its parent, sub-tasks and documents', () => {
    it('reads Jira fields.parent and fields.subtasks', () => {
        expect(
            linksIn({
                key: 'GE-81',
                fields: {
                    parent: {
                        key: 'GE-80',
                        fields: { summary: 'Bulk actions' },
                    },
                    subtasks: [
                        {
                            id: '10045',
                            key: 'GE-82',
                            fields: {
                                summary: 'Row checkboxes',
                                status: { name: 'To Do' },
                            },
                        },
                    ],
                },
            }),
        ).toEqual({
            parentId: 'GE-80',
            parentTitle: 'Bulk actions',
            subtasks: [
                { id: 'GE-82', title: 'Row checkboxes', status: 'To Do' },
            ],
        });
    });

    it('reads a ClickUp parent id and its sub-tasks by custom id', () => {
        expect(
            linksIn({
                id: '86abc',
                parent: '86parent',
                subtasks: [
                    {
                        id: '86sub',
                        custom_id: 'DEV-13',
                        name: 'Row checkboxes',
                        status: { status: 'open' },
                    },
                ],
            }),
        ).toEqual({
            parentId: '86parent',
            subtasks: [
                { id: 'DEV-13', title: 'Row checkboxes', status: 'open' },
            ],
        });
    });

    it('names a GitHub sub-issue by its number, not its internal id', () => {
        expect(
            linksIn({
                number: 12,
                sub_issues: [{ id: 99887766, number: 13, title: 'Checkboxes' }],
            })?.subtasks,
        ).toEqual([{ id: '13', title: 'Checkboxes', status: undefined }]);
    });

    it('reads Linear documents by id and has nothing for a plain task', () => {
        expect(
            linksIn({
                id: 'KOD-22',
                parentId: null,
                documents: [{ id: 'doc-1', title: 'Spec' }],
            }),
        ).toEqual({
            documents: [{ id: 'doc-1', title: 'Spec', content: undefined }],
        });
        expect(linksIn({ id: 'KOD-10', documents: [] })).toBeUndefined();
    });
});
