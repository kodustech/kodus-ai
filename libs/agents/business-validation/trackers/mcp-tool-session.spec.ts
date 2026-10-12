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
