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
    ToolClosedError,
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

        // ClickUp's answer for an id that is not one of its tasks.
        executeTool.mockResolvedValueOnce(
            errorResult('{"error":"Team not authorized"}'),
        );
        await expect(
            session().call('get_issue', { id: 'QA-17' }),
        ).rejects.toBeInstanceOf(TaskNotFoundError);
        // The same answer, thrown by the MCP adapter.
        executeTool.mockRejectedValueOnce(
            new Error(
                'Tool clickup_get_task failed: {"error":"Team not authorized"}',
            ),
        );
        await expect(
            session().call('get_issue', { id: 'QA-17' }),
        ).rejects.toBeInstanceOf(TaskNotFoundError);
        executeTool.mockResolvedValueOnce(
            errorResult('Team not authorized: token expired'),
        );
        await expect(
            session().call('get_issue', { id: 'QA-17' }),
        ).rejects.toBeInstanceOf(TrackerUnavailableError);

        executeTool.mockResolvedValueOnce(errorResult('rate limited'));
        await expect(
            session().call('get_issue', { id: 'SAA-9' }),
        ).rejects.toBeInstanceOf(TrackerUnavailableError);
    });

    it.each([
        ['es', '{"message":"La incidencia no existe","statusCode":404}'],
        ['de', '{"message":"Der Vorgang existiert nicht","statusCode":404}'],
        ['a GitLab MCP', '{"message":"404 Not found"}'],
        ['a malformed id', 'Invalid id format'],
    ])(
        'reads a missing task as not found whatever the language: %s',
        async (_, text) => {
            executeTool.mockResolvedValueOnce(errorResult(text));
            await expect(
                session().call('get_issue', { id: 'SAA-9' }),
            ).rejects.toBeInstanceOf(TaskNotFoundError);
        },
    );

    it('reads a 404 about something other than the task as unavailable', async () => {
        executeTool.mockResolvedValueOnce(
            errorResult('{"message":"Site not found","statusCode":404}'),
        );
        await expect(
            session().call('get_issue', { id: 'SAA-9' }),
        ).rejects.not.toBeInstanceOf(TaskNotFoundError);
    });

    it('refuses a tool the org turned off as a setup problem', async () => {
        await expect(session().call('list_teams', {})).rejects.toBeInstanceOf(
            ToolClosedError,
        );
    });

    it('reads "failed to retrieve … with id" as missing only when no cause follows', async () => {
        executeTool.mockResolvedValueOnce(
            errorResult(
                'Failed to retrieve Shortcut story with public ID: 123.',
            ),
        );
        await expect(
            session().call('get_issue', { id: 'SAA-9' }),
        ).rejects.toBeInstanceOf(TaskNotFoundError);

        executeTool.mockResolvedValueOnce(
            errorResult(
                'Failed to retrieve Shortcut story with public ID: 123: Request failed with status code 503',
            ),
        );
        await expect(
            session().call('get_issue', { id: 'SAA-9' }),
        ).rejects.toBeInstanceOf(TrackerUnavailableError);
    });

    it('reports a server it cannot reach as unavailable, with the arguments it was given', async () => {
        executeTool.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
        await expect(
            session().call('get_issue', { id: 'SAA-9' }),
        ).rejects.toBeInstanceOf(TrackerUnavailableError);
        expect(executeTool).toHaveBeenLastCalledWith(
            'get_issue',
            { id: 'SAA-9' },
            'tracker',
        );
    });

    it('reads "not found" as a missing task only when it is about the task asked for', async () => {
        for (const text of [
            'cloudId not found',
            'Could not find page with ID: 1f2e. Make sure the relevant pages and databases are shared with your integration.',
            'Request failed with status code 404',
            'Workspace not found',
        ]) {
            executeTool.mockResolvedValueOnce(errorResult(text));
            await expect(
                session().call('get_issue', { id: 'SAA-9' }),
            ).rejects.toBeInstanceOf(TrackerUnavailableError);
        }
        executeTool.mockResolvedValueOnce(errorResult('404: SAA-9'));
        await expect(
            session().call('get_issue', { id: 'SAA-9' }),
        ).rejects.toBeInstanceOf(TaskNotFoundError);
    });

    it('never calls a tool the org turned off on the connection', async () => {
        executeTool.mockClear();
        const narrowed = new McpToolSession(
            { name: 'tracker', allowedTools: ['list_teams'] } as any,
            ['get_issue', 'list_teams'],
        );
        await expect(
            narrowed.call('get_issue', { id: 'SAA-9' }),
        ).rejects.toBeInstanceOf(TrackerUnavailableError);
        expect(executeTool).not.toHaveBeenCalled();
    });

    it('never calls a tool the session was not opened for', async () => {
        executeTool.mockClear();
        await expect(
            session().call('update_issue', { id: 'SAA-9' }),
        ).rejects.toBeInstanceOf(TrackerUnavailableError);
        expect(executeTool).not.toHaveBeenCalled();
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
