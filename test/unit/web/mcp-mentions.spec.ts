import { mapMCPConnectionsToMentionGroups } from '../../../apps/web/src/core/hooks/mcp-mentions-state';

describe('mapMCPConnectionsToMentionGroups', () => {
    it('maps connections into nested mention groups', () => {
        expect(
            mapMCPConnectionsToMentionGroups([
                {
                    integrationId: 'linear',
                    appName: 'Linear MCP',
                    allowedTools: ['search_issues', 'get_issue'],
                },
            ]),
        ).toEqual([
            {
                groupLabel: 'MCP',
                items: [
                    {
                        type: 'mcp',
                        value: 'linear',
                        label: 'Linear MCP',
                        children: expect.any(Function),
                    },
                ],
            },
        ]);

        const groups = mapMCPConnectionsToMentionGroups([
            {
                integrationId: 'linear',
                appName: 'Linear MCP',
                allowedTools: ['search_issues', 'get_issue'],
            },
        ]);

        expect(groups[0]?.items[0]?.children?.()).toEqual([
            {
                groupLabel: 'Linear MCP',
                items: [
                    {
                        type: 'mcp',
                        value: 'linear:search_issues',
                        label: 'search_issues',
                        meta: { appName: 'Linear MCP' },
                    },
                    {
                        type: 'mcp',
                        value: 'linear:get_issue',
                        label: 'get_issue',
                        meta: { appName: 'Linear MCP' },
                    },
                ],
            },
        ]);
    });
});
