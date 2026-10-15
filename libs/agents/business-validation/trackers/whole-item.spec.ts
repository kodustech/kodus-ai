import { wholeItem } from './whole-item';

describe('wholeItem', () => {
    it("asks a summary read (ClickUp's include) for the sections requirements live in", () => {
        const tool = {
            name: 'clickup_get_task',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    include: {
                        type: 'array',
                        items: {
                            enum: [
                                'attachments',
                                'checklists',
                                'custom_fields',
                                'description',
                                'subtasks',
                                'watchers',
                            ],
                        },
                    },
                },
            },
        } as any;
        expect(wholeItem(tool, { task_id: '86b' })).toEqual({
            task_id: '86b',
            include: ['checklists', 'custom_fields', 'description', 'subtasks'],
        });
    });

    it('leaves alone a read that picks no sections, and a tool that returns many', () => {
        const plain = {
            name: 'get_issue',
            inputSchema: {
                type: 'object',
                properties: { id: { type: 'string' } },
            },
        } as any;
        expect(wholeItem(plain, { id: '7' })).toEqual({ id: '7' });

        const include = {
            type: 'array',
            items: { enum: ['description', 'subtasks'] },
        };
        for (const name of ['get_tasks', 'search_issues']) {
            const many = {
                name,
                inputSchema: { type: 'object', properties: { include } },
            } as any;
            expect(wholeItem(many, { q: 'x' })).toEqual({ q: 'x' });
        }
    });
});
