import { fetchPullRequestMetadata } from '@libs/agents/skills/capabilities/pr-metadata-read';
import { ToolCaller } from '@libs/agents/skills/runtime/skill-runtime.types';

function createToolCaller(callToolImpl: ToolCaller['callTool']): ToolCaller {
    return {
        callTool: callToolImpl,
        getRegisteredTools: () => [],
    };
}

describe('fetchPullRequestMetadata', () => {
    const executionContext = {
        skillName: 'business-rules-validation',
        organizationId: 'org-1',
        teamId: 'team-1',
        provider: 'external',
    };

    it('returns body and success trace when tool succeeds', async () => {
        const callTool = jest.fn<ToolCaller['callTool']>().mockResolvedValue({
            result: { data: { body: 'PR body content' } },
        });
        const toolCaller = createToolCaller(callTool);

        const result = await fetchPullRequestMetadata(
            toolCaller,
            'KODUS_GET_PULL_REQUEST',
            {
                organizationId: 'org-1',
                teamId: 'team-1',
                repositoryId: 'repo-1',
                repositoryName: 'repo-name',
                pullRequestNumber: 42,
            },
            executionContext,
        );

        expect(result.body).toBe('PR body content');
        expect(result.traces).toHaveLength(1);
        expect(result.traces[0]).toMatchObject({
            capability: 'pr.metadata.read',
            status: 'success',
            toolName: 'KODUS_GET_PULL_REQUEST',
        });
        expect(callTool).toHaveBeenCalledWith('KODUS_GET_PULL_REQUEST', {
            organizationId: 'org-1',
            teamId: 'team-1',
            repository: {
                id: 'repo-1',
                name: 'repo-name',
            },
            prNumber: 42,
        });
    });

    it('returns skipped trace when precondition fails', async () => {
        const toolCaller = createToolCaller(jest.fn());

        const result = await fetchPullRequestMetadata(
            toolCaller,
            'KODUS_GET_PULL_REQUEST',
            undefined,
            executionContext,
        );

        expect(result.body).toBeUndefined();
        expect(result.traces[0]).toMatchObject({
            capability: 'pr.metadata.read',
            status: 'skipped',
            reason: 'precondition_failed',
        });
    });

    it('returns skipped trace when tool is unavailable', async () => {
        const toolCaller = createToolCaller(jest.fn());

        const result = await fetchPullRequestMetadata(
            toolCaller,
            undefined,
            {
                organizationId: 'org-1',
                teamId: 'team-1',
                repositoryId: 'repo-1',
                repositoryName: 'repo-name',
                pullRequestNumber: 42,
            },
            executionContext,
        );

        expect(result.body).toBeUndefined();
        expect(result.traces[0]).toMatchObject({
            capability: 'pr.metadata.read',
            status: 'skipped',
            reason: 'tool_unavailable',
        });
    });
});
