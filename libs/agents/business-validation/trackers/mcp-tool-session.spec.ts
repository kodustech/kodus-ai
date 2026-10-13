const executeTool = jest.fn();
jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    createMCPAdapter: () => ({
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        executeTool,
    }),
}));

import {
    McpToolSession,
    TaskNotFoundError,
    TrackerUnavailableError,
} from './mcp-tool-session';

const errorResult = (text: string) => ({
    isError: true,
    content: [{ type: 'text', text }],
});

describe('McpToolSession', () => {
    const session = () =>
        new McpToolSession({ name: 'tracker', allowedTools: [] } as any, [
            'get_issue',
        ]);

    it('never reads a tool error as the task', async () => {
        executeTool.mockResolvedValueOnce(errorResult('Issue SAA-9 not found'));
        await expect(
            session().call('get_issue', { id: 'SAA-9' }),
        ).rejects.toBeInstanceOf(TaskNotFoundError);

        // Notion's answer for a page that is missing or not shared.
        executeTool.mockResolvedValueOnce(
            errorResult(
                '{"code":"object_not_found","message":"Could not load page"}',
            ),
        );
        await expect(
            session().call('get_issue', { id: 'SAA-9' }),
        ).rejects.toBeInstanceOf(TaskNotFoundError);

        // Rovo's answer for a missing key, in the user's language, as Jira
        // returns it: only the status code says what happened.
        executeTool.mockResolvedValueOnce(
            errorResult(
                JSON.stringify({
                    error: true,
                    message: JSON.stringify({
                        errorMessages: [
                            'O item não existe ou você não tem permissão para vê-lo',
                        ],
                        errors: {},
                    }),
                    statusCode: 404,
                }),
            ),
        );
        await expect(
            session().call('get_issue', { id: 'SAA-9' }),
        ).rejects.toBeInstanceOf(TaskNotFoundError);

        executeTool.mockResolvedValueOnce(errorResult('rate limited'));
        await expect(
            session().call('get_issue', { id: 'SAA-9' }),
        ).rejects.toBeInstanceOf(TrackerUnavailableError);
    });

    it('returns what a tool answered, without the envelope', async () => {
        executeTool.mockResolvedValueOnce({
            content: [{ type: 'text', text: '{"title":"Sticky notes"}' }],
        });
        await expect(
            session().call('get_issue', { id: 'SAA-9' }),
        ).resolves.toEqual({ title: 'Sticky notes' });
    });
});
