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
                        items: { enum: ['attachments', 'checklists', 'custom_fields', 'description', 'subtasks', 'watchers'] },
                    },
                },
            },
        } as any;
        expect(wholeItem(tool, { task_id: '86b' })).toEqual({
            task_id: '86b',
            include: ['checklists', 'custom_fields', 'description', 'subtasks'],
        });
    });
});
