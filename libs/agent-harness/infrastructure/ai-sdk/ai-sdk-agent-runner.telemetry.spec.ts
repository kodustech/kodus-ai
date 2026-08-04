/**
 * Telemetry forwarding — proves the per-run telemetry payload actually reaches
 * the AI SDK 7 telemetry registry, through the REAL SDK, with a mocked model.
 *
 * Asserted at the OUTCOME, not at the internal shape: what a registered
 * `Telemetry` integration observes is exactly what Langfuse's
 * `LangfuseVercelAiSdkIntegration` observes in production — the `functionId`
 * that names the observation, and the runtime-context keys that become the
 * observation's metadata. That makes this spec a behavior contract any
 * refactor of the forwarding path has to keep green.
 */
import { registerTelemetry, type Telemetry } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

import type { AgentSpec } from '../../domain/contracts/agent.contract';
import type { ModelResolver } from '../../domain/contracts/model.contract';
import type { ToolContext } from '../../domain/contracts/tool.contract';
import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';
import { AiSdkAgentRunner } from './ai-sdk-agent-runner';

// Captures every telemetry event the SDK emits for this test file's module
// registry. `registerTelemetry` is process-global, hence the module-level
// registration + per-test reset.
const seen: { starts: any[] } = { starts: [] };
const spy: Telemetry = {
    onStart: (event: any) => {
        seen.starts.push(event);
    },
};
registerTelemetry(spy);

const resolver: ModelResolver<any> = {
    resolve: () =>
        new MockLanguageModelV3({
            doGenerate: (async () => ({
                content: [{ type: 'text', text: 'done' }],
                finishReason: 'stop',
                usage: { inputTokens: 10, outputTokens: 5 },
                warnings: [],
            })) as any,
        }) as any,
};

function probeSpec(): AgentSpec {
    return {
        id: 'telemetry-probe',
        systemPrompt: 'probe',
        modelId: 'mock',
        tools: new InMemoryToolRegistry([]),
        policies: [],
        maxSteps: 1,
    };
}

const ctx: ToolContext = { runId: 'telemetry-1' };

describe('AiSdkAgentRunner telemetry forwarding', () => {
    beforeEach(() => {
        seen.starts = [];
    });

    it('names the observation with functionId and exposes metadata as runtime context', async () => {
        const runner = new AiSdkAgentRunner(resolver);

        const state = await runner.run(
            probeSpec(),
            {
                prompt: 'go',
                // Exactly what `toAiSdkTelemetryArgs(buildLangfuseTelemetry(
                // 'conversationAgent', {organizationId, teamId}))` returns —
                // the domain-side half of this chain is covered by the
                // langfuse spec; here we prove the harness half.
                telemetry: {
                    isEnabled: true,
                    functionId: 'conversationAgent',
                    includeRuntimeContext: {
                        organizationId: true,
                        teamId: true,
                    },
                },
                runtimeContext: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
            },
            ctx,
        );

        expect(state.status).not.toBe('error');
        expect(seen.starts).toHaveLength(1);

        const event = seen.starts[0];
        // functionId reaches the SDK -> Langfuse names the observation with it.
        expect(event.functionId).toBe('conversationAgent');
        // metadata keys are opted into the telemetry payload -> Langfuse turns
        // them into observation metadata. Both the value AND the opt-in matter:
        // runtime-context keys are EXCLUDED unless explicitly included.
        expect(event.runtimeContext).toMatchObject({
            organizationId: 'org-1',
            teamId: 'team-1',
        });
    });

    it('forwards a metadata-less payload without inventing runtime context', async () => {
        const runner = new AiSdkAgentRunner(resolver);

        await runner.run(
            probeSpec(),
            {
                prompt: 'go',
                telemetry: { isEnabled: true, functionId: 'finder' },
            },
            ctx,
        );

        expect(seen.starts).toHaveLength(1);
        expect(seen.starts[0].functionId).toBe('finder');
        expect(seen.starts[0].runtimeContext ?? {}).toEqual({});
    });

    it('emits no telemetry event when the run opts out (isEnabled=false)', async () => {
        const runner = new AiSdkAgentRunner(resolver);

        await runner.run(
            probeSpec(),
            {
                prompt: 'go',
                // What buildLangfuseTelemetry returns when tracing is off.
                telemetry: { isEnabled: false, functionId: 'conversationAgent' },
            },
            ctx,
        );

        expect(seen.starts).toHaveLength(0);
    });
});
