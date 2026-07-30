import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';

// Mock the harness fetcher adapter at module boundary so callAgent's billing +
// run-context wiring can be asserted without a real model or MCP transport.
const runMcpFetcherAgentMock = jest.fn();
jest.mock('./runtime/ai-sdk-fetcher.adapter', () => ({
    runMcpFetcherAgent: (...args: unknown[]) => runMcpFetcherAgentMock(...args),
    buildMcpAgentToolRegistry: jest.fn(async () => ({
        get: () => undefined,
        list: () => [],
    })),
}));

import { GenericSkillRunnerService } from './generic-skill-runner.service';

/**
 * Regression net for the skills runner — restored as the guard for Etapa 2
 * (Policies land on this runner) and for the Etapa-0 change that swapped the
 * hand-rolled AbortController+setTimeout in callAgent for the shared
 * `createAgentRunContext`. Drives the public `createFetcherOrchestration` through
 * the no-MCP fallback path (no servers + policy allows it) so we exercise the
 * real wiring without mocking MCP internals: callAgent must route through
 * `runMcpFetcherAgent`, wrapped in a billing span, with a managed signal + runId.
 */
function fetcherState(): RunState {
    return {
        runId: 'r',
        agentId: 'a',
        steps: [],
        artifacts: [],
        messages: [],
        usage: { inputTokens: 10, outputTokens: 5 },
    } as unknown as RunState;
}

describe('GenericSkillRunnerService.createFetcherOrchestration', () => {
    const skillName = 'demo-skill';
    // fetcherPolicy.allowWithoutTools → onMissingMcp defaults to 'fallback', so
    // an empty MCP server list yields a tool-less runtime instead of throwing.
    const meta = {
        name: skillName,
        description: 'demo skill',
        fetcherPolicy: { allowWithoutTools: true },
    };
    const org = { organizationId: 'o', teamId: 't' } as any;

    let skillLoader: any;
    let obs: any;
    let mcpManager: any;
    let service: GenericSkillRunnerService;

    beforeEach(() => {
        runMcpFetcherAgentMock.mockReset();
        runMcpFetcherAgentMock.mockResolvedValue({
            text: '{"ok":true}',
            state: fetcherState(),
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        });
        skillLoader = {
            loadSkillMetaFromFilesystem: jest.fn(() => meta),
            loadInstructions: jest.fn(() => 'instructions'),
            listReferences: jest.fn(() => []),
        };
        // runAiSdkLLMInSpan must actually run exec so the fetcher is invoked.
        obs = { runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()) };
        mcpManager = { getConnections: jest.fn(async () => []) };
        service = new GenericSkillRunnerService(skillLoader, obs, mcpManager);
    });

    it('falls back to a tool-less runtime when no MCP servers are available', async () => {
        const runtime = await service.createFetcherOrchestration(
            skillName,
            undefined,
            org,
        );
        expect(runtime.toolCaller).toBeDefined();
        expect(runtime.toolCaller.getRegisteredTools()).toEqual([]);
        expect(mcpManager.getConnections).toHaveBeenCalledWith(org);
    });

    it('routes callAgent through runMcpFetcherAgent, wrapped in a billing span, with a managed signal + runId', async () => {
        const runtime = await service.createFetcherOrchestration(
            skillName,
            undefined,
            org,
        );
        const res = await runtime.toolCaller.callAgent!('analyzer', 'gather');

        // Billing wrap (token usage → observability_telemetry).
        expect(obs.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
        // Fetcher invoked exactly once.
        expect(runMcpFetcherAgentMock).toHaveBeenCalledTimes(1);
        const arg = runMcpFetcherAgentMock.mock.calls[0][0];
        // Standardized run context (the Etapa-0 change): runId + AbortSignal.
        expect(arg.runId).toBe(`${skillName}:analyzer`);
        expect(arg.signal).toBeInstanceOf(AbortSignal);
        // Compression is OFF by default — no window declared, so no guessed value.
        expect(arg.contextWindowTokens).toBeUndefined();
        // Normalized response carries the fetcher's text.
        expect(res).toEqual({ result: '{"ok":true}' });
    });

    it('threads SKILL.md contextWindowTokens to the fetcher (opt-in compression)', async () => {
        skillLoader.loadSkillMetaFromFilesystem.mockReturnValue({
            ...meta,
            executionPolicy: { contextWindowTokens: 128_000 },
        });
        const runtime = await service.createFetcherOrchestration(
            skillName,
            undefined,
            org,
        );
        await runtime.toolCaller.callAgent!('analyzer', 'gather');
        expect(runMcpFetcherAgentMock.mock.calls[0][0].contextWindowTokens).toBe(
            128_000,
        );
    });

    it('does not leave the signal aborted on success (cleanup cleared the timeout)', async () => {
        const runtime = await service.createFetcherOrchestration(
            skillName,
            undefined,
            org,
        );
        await runtime.toolCaller.callAgent!('analyzer', 'gather');
        const arg = runMcpFetcherAgentMock.mock.calls[0][0];
        expect(arg.signal.aborted).toBe(false);
    });
});
