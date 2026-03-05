import { executeDeterministicTool } from '@libs/agents/skills/runtime/deterministic-tool-executor';

describe('deterministic-tool-executor', () => {
    it('calls tool and maps result when all preconditions are met', async () => {
        const callTool = jest.fn().mockResolvedValue({
            result: { result: { success: true, data: 'diff-content' } },
        });

        const output = await executeDeterministicTool({
            toolName: 'KODUS_GET_PULL_REQUEST_DIFF',
            args: {
                organizationId: 'org-1',
                teamId: 'team-1',
                repositoryId: 'repo-1',
                prNumber: 10,
            },
            callTool,
            extract: (payload) => {
                const data = (payload as any)?.result?.data;
                return typeof data === 'string' ? data : '';
            },
            fallback: '',
        });

        expect(callTool).toHaveBeenCalledWith(
            'KODUS_GET_PULL_REQUEST_DIFF',
            expect.objectContaining({
                organizationId: 'org-1',
                teamId: 'team-1',
            }),
        );
        expect(output).toBe('diff-content');
    });

    it('returns fallback when tool is unavailable', async () => {
        const callTool = jest.fn();
        const onFallback = jest.fn();

        const output = await executeDeterministicTool({
            toolName: undefined,
            args: { organizationId: 'org-1' },
            callTool,
            extract: () => 'should-not-happen',
            fallback: '',
            onFallback,
        });

        expect(callTool).not.toHaveBeenCalled();
        expect(onFallback).toHaveBeenCalledWith('tool_unavailable');
        expect(output).toBe('');
    });

    it('returns fallback when validation blocks execution', async () => {
        const callTool = jest.fn();
        const onFallback = jest.fn();

        const output = await executeDeterministicTool({
            toolName: 'KODUS_GET_PULL_REQUEST',
            args: { organizationId: 'org-1' },
            callTool,
            validate: () => 'precondition_failed',
            extract: () => 'should-not-happen',
            fallback: '',
            onFallback,
        });

        expect(callTool).not.toHaveBeenCalled();
        expect(onFallback).toHaveBeenCalledWith('precondition_failed');
        expect(output).toBe('');
    });

    it('executes tool when validation passes', async () => {
        const callTool = jest.fn().mockResolvedValue({
            result: { data: 'ok' },
        });

        const output = await executeDeterministicTool({
            toolName: 'KODUS_GET_PULL_REQUEST',
            args: { organizationId: 'org-1' },
            callTool,
            validate: () => undefined,
            extract: (payload) => (payload as { data?: string }).data ?? '',
            fallback: '',
        });

        expect(callTool).toHaveBeenCalledTimes(1);
        expect(output).toBe('ok');
    });

    it('returns fallback and reports missing result payload', async () => {
        const callTool = jest.fn().mockResolvedValue({});
        const onFallback = jest.fn();

        const output = await executeDeterministicTool({
            toolName: 'KODUS_GET_PULL_REQUEST',
            args: { organizationId: 'org-1' },
            callTool,
            extract: () => 'should-not-happen',
            fallback: '',
            onFallback,
        });

        expect(onFallback).toHaveBeenCalledWith('missing_result');
        expect(output).toBe('');
    });
});
