import { z } from 'zod';

import { CodeManagementTools } from './codeManagement.tools';

/**
 * KODUS_GET_DIFF_FOR_FILE declares `data: string`. Asking for a file the PR
 * does not change (or one with no textual patch) returned `data: undefined`,
 * which the MCP server rejects as an output validation error (prod, -32602),
 * so the agent got a protocol error instead of an answer.
 */
describe('KODUS_GET_DIFF_FOR_FILE', () => {
    const args = {
        organizationId: 'org',
        teamId: 'team',
        repository: { id: 'repo', name: 'repo' },
        prNumber: 7,
        filePath: 'src/not-in-this-pr.ts',
    };

    const toolFor = (files: Array<{ filename: string; patch?: string }>) =>
        new CodeManagementTools({
            getFilesByPullRequestId: jest.fn(async () => files),
        } as any).getDiffForFile();

    it('answers within its own schema for a file the PR does not change', async () => {
        const tool = toolFor([
            { filename: 'src/changed.ts', patch: '@@ -1 +1 @@' },
        ]);

        const response: any = await tool.execute(args as any);

        expect(() =>
            (tool.outputSchema as z.ZodTypeAny).parse(
                response.structuredContent,
            ),
        ).not.toThrow();
        expect(response.structuredContent.success).toBe(false);
    });

    it('answers within its own schema for a changed file that has no textual patch', async () => {
        const tool = toolFor([{ filename: args.filePath }]);

        const response: any = await tool.execute(args as any);

        expect(() =>
            (tool.outputSchema as z.ZodTypeAny).parse(
                response.structuredContent,
            ),
        ).not.toThrow();
    });

    it('returns the patch of a changed file', async () => {
        const tool = toolFor([
            { filename: args.filePath, patch: '@@ -1 +1 @@\n-a\n+b' },
        ]);

        const response: any = await tool.execute(args as any);

        expect(response.structuredContent).toEqual({
            success: true,
            data: '@@ -1 +1 @@\n-a\n+b',
        });
    });
});
