import { fetchPullRequestDiff } from '@libs/agents/skills/capabilities/pr-diff-read';
import { ToolCaller } from '@libs/agents/skills/runtime/skill-runtime.types';

function createToolCaller(callToolImpl: ToolCaller['callTool']): ToolCaller {
    return {
        callTool: callToolImpl,
        getRegisteredTools: () => [],
    };
}

describe('fetchPullRequestDiff', () => {
    const executionContext = {
        skillName: 'business-rules-validation',
        organizationId: 'org-1',
        teamId: 'team-1',
        provider: 'external',
    };

    it('returns diff and success trace when tool succeeds', async () => {
        const callTool = jest
            .fn<ToolCaller['callTool']>()
            .mockResolvedValue({ result: { data: 'diff --git a b' } });
        const toolCaller = createToolCaller(callTool);

        const result = await fetchPullRequestDiff(
            toolCaller,
            'KODUS_GET_PULL_REQUEST_DIFF',
            {
                organizationId: 'org-1',
                teamId: 'team-1',
                repositoryId: 'repo-1',
                repositoryName: 'repo-name',
                pullRequestNumber: 7,
            },
            executionContext,
        );

        expect(result.diff).toBe('diff --git a b');
        expect(result.traces).toHaveLength(1);
        expect(result.traces[0]).toMatchObject({
            capability: 'pr.diff.read',
            status: 'success',
            toolName: 'KODUS_GET_PULL_REQUEST_DIFF',
        });
        expect(callTool).toHaveBeenCalledWith('KODUS_GET_PULL_REQUEST_DIFF', {
            organizationId: 'org-1',
            teamId: 'team-1',
            repositoryId: 'repo-1',
            repositoryName: 'repo-name',
            prNumber: 7,
        });
    });

    it('returns skipped trace when precondition fails', async () => {
        const toolCaller = createToolCaller(jest.fn());

        const result = await fetchPullRequestDiff(
            toolCaller,
            'KODUS_GET_PULL_REQUEST_DIFF',
            undefined,
            executionContext,
        );

        expect(result.diff).toBe('');
        expect(result.traces[0]).toMatchObject({
            capability: 'pr.diff.read',
            status: 'skipped',
            reason: 'precondition_failed',
        });
    });

    it('returns skipped trace when tool is unavailable', async () => {
        const toolCaller = createToolCaller(jest.fn());

        const result = await fetchPullRequestDiff(
            toolCaller,
            undefined,
            {
                organizationId: 'org-1',
                teamId: 'team-1',
                repositoryId: 'repo-1',
                pullRequestNumber: 7,
            },
            executionContext,
        );

        expect(result.diff).toBe('');
        expect(result.traces[0]).toMatchObject({
            capability: 'pr.diff.read',
            status: 'skipped',
            reason: 'tool_unavailable',
        });
    });

    it('extracts diff from MCP structuredContent payloads', async () => {
        const callTool = jest.fn<ToolCaller['callTool']>().mockResolvedValue({
            result: {
                result: {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: true,
                                data: 'diff from content text',
                            }),
                        },
                    ],
                    structuredContent: {
                        success: true,
                        data: 'diff from structured content',
                    },
                },
            },
        });
        const toolCaller = createToolCaller(callTool);

        const result = await fetchPullRequestDiff(
            toolCaller,
            'KODUS_GET_PULL_REQUEST_DIFF',
            {
                organizationId: 'org-1',
                teamId: 'team-1',
                repositoryId: 'repo-1',
                repositoryName: 'repo-name',
                pullRequestNumber: 7,
            },
            executionContext,
        );

        expect(result.diff).toBe('diff from structured content');
        expect(result.traces[0]).toMatchObject({
            capability: 'pr.diff.read',
            status: 'success',
        });
    });

    it('extracts diff from a real single-nested MCP content envelope (regression: the off-by-one that returned an empty diff)', async () => {
        // Real tools return { result: { content: [{ type:'text', text:'{...}' }] } }.
        // executeDeterministicTool unwraps ONE level, so extract receives
        // { content: [...] } directly. The old extractor looked at
        // root.result.content (one level too deep) and got nothing — which is
        // exactly why KODUS_GET_PULL_REQUEST_DIFF came back empty in production.
        const callTool = jest.fn<ToolCaller['callTool']>().mockResolvedValue({
            result: {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            data: 'diff --git a/x b/x\n+added line',
                        }),
                    },
                ],
            },
        });
        const toolCaller = createToolCaller(callTool);

        const result = await fetchPullRequestDiff(
            toolCaller,
            'KODUS_GET_PULL_REQUEST_DIFF',
            {
                organizationId: 'org-1',
                teamId: 'team-1',
                repositoryId: 'repo-1',
                repositoryName: 'repo-name',
                pullRequestNumber: 7,
            },
            executionContext,
        );

        expect(result.diff).toBe('diff --git a/x b/x\n+added line');
        expect(result.traces[0]).toMatchObject({
            capability: 'pr.diff.read',
            status: 'success',
        });
    });
});
