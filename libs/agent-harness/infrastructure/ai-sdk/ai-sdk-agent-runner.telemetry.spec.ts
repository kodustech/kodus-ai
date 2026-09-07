/**
 * Telemetry forwarding contract.
 *
 * The runner no longer hand-forwards a raw AI SDK telemetry payload — LLM.run
 * builds the Langfuse telemetry from the RAW `telemetryMetadata` the runner
 * threads (functionId = runName, metadata → runtime context). So the runner's
 * job here is narrow and testable at its seam: it must forward `telemetryMetadata`
 * and the cost/observability naming (runName / agentName / phase) into LLM.run.
 * The metadata→SDK mapping itself is covered by the langfuse spec.
 */
jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

import { LLM } from '@libs/llm/llm';

import type { AgentSpec } from '../../domain/contracts/agent.contract';
import type { ToolContext } from '../../domain/contracts/tool.contract';
import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';
import { AiSdkAgentRunner } from './ai-sdk-agent-runner';

const mockRun = LLM.run as jest.Mock;

beforeEach(() => {
    mockRun.mockReset();
    mockRun.mockResolvedValue({
        usage: { inputTokens: 10, outputTokens: 5 },
        steps: [],
    });
});

function probeSpec(over: Partial<AgentSpec> = {}): AgentSpec {
    return {
        id: 'telemetry-probe',
        systemPrompt: 'probe',
        tools: new InMemoryToolRegistry([]),
        policies: [],
        maxSteps: 1,
        ...over,
    };
}

const ctx: ToolContext = { runId: 'telemetry-1' };

describe('AiSdkAgentRunner telemetry forwarding', () => {
    it('forwards telemetryMetadata + observability naming into LLM.run', async () => {
        const runner = new AiSdkAgentRunner(undefined);

        await runner.run(
            probeSpec({
                runName: 'conversationAgent',
                agentName: 'ConversationalAgent',
                phase: 'conversation',
                spanName: 'ConversationalAgent::conversationAgent',
            }),
            {
                prompt: 'go',
                telemetryMetadata: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
            },
            ctx,
        );

        expect(mockRun).toHaveBeenCalledTimes(1);
        const req = mockRun.mock.calls[0][0];
        // functionId of the Langfuse observation is driven by runName.
        expect(req.runName).toBe('conversationAgent');
        expect(req.spanName).toBe('ConversationalAgent::conversationAgent');
        // Raw metadata is forwarded verbatim — LLM.run builds the SDK shape.
        expect(req.telemetryMetadata).toEqual({
            organizationId: 'org-1',
            teamId: 'team-1',
        });
        // Cost attrs the span records.
        expect(req.attrs).toMatchObject({
            agentName: 'ConversationalAgent',
            phase: 'conversation',
            source: 'harness',
        });
        // It's the agent-loop path (tools + policies seams present).
        expect(req.loop).toBeDefined();
        expect(req.loop.maxSteps).toBe(1);
    });

    it('omits telemetryMetadata when the run supplies none, and defaults runName to the id', async () => {
        const runner = new AiSdkAgentRunner(undefined);

        await runner.run(probeSpec({ id: 'finder' }), { prompt: 'go' }, ctx);

        const req = mockRun.mock.calls[0][0];
        expect(req.telemetryMetadata).toBeUndefined();
        expect(req.runName).toBe('finder');
    });

    it('forwards explicit input suppression without requiring telemetry metadata', async () => {
        const runner = new AiSdkAgentRunner(undefined);

        await runner.run(
            probeSpec(),
            { prompt: 'private', telemetry: { recordInputs: false } },
            ctx,
        );

        expect(mockRun.mock.calls[0][0]).toMatchObject({
            recordTelemetryInputs: false,
        });
        expect(mockRun.mock.calls[0][0].telemetryMetadata).toBeUndefined();
    });

    it('forwards body-free review-context delivery correlation to LLM.run', async () => {
        const runner = new AiSdkAgentRunner(undefined);
        const delivery = {
            source: 'cli-review-context-file',
            contentType: 'text/plain; charset=utf-8',
            sha256: '0123456789abcdef',
            utf8Bytes: 22,
            recipient: 'bug-agent',
            phase: 'finder',
        } as const;

        await runner.run(
            probeSpec(),
            { prompt: 'private prompt body', reviewContextDelivery: delivery },
            ctx,
        );

        expect(mockRun.mock.calls[0][0].reviewContextDelivery).toEqual(
            delivery,
        );
        expect(
            mockRun.mock.calls[0][0].reviewContextDelivery,
        ).not.toHaveProperty('body');
    });

    it('uses a per-invocation phase when a shared agent spec is resampled', async () => {
        const runner = new AiSdkAgentRunner(undefined);

        await runner.run(
            probeSpec({ phase: 'review' }),
            { prompt: 'resample', telemetryPhase: 'heavy-resample-1' },
            ctx,
        );

        expect(mockRun.mock.calls[0][0].attrs.phase).toBe('heavy-resample-1');
    });

    it('leaves input recording unspecified when the harness option is absent', async () => {
        const runner = new AiSdkAgentRunner(undefined);

        await runner.run(probeSpec(), { prompt: 'ordinary' }, ctx);

        expect(mockRun.mock.calls[0][0].recordTelemetryInputs).toBeUndefined();
    });
});
