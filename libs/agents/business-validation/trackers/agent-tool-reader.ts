import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import { createAgentRunContext } from '@libs/llm/agent-run-context';
import type { NormalizedModel } from '@libs/llm/byok-config';

import type { AgentToolReader } from './custom-mcp.tracker';
import { mentions } from './task-payload';

const MAX_STEPS = 3;
const TIMEOUT_MS = 30_000;

/**
 * An agent that reads one task through the one tool the org picked, for a
 * plugin whose schema doesn't say how to ask for an id (a `project` argument,
 * an id in another shape). It sees no other tool, so it can only read.
 */
export function createAgentToolReader(
    model: NormalizedModel | undefined,
    telemetry: { organizationId?: string; teamId?: string },
): AgentToolReader {
    return async ({ tool, reference, call }) => {
        let payload: unknown;
        const registry = new InMemoryToolRegistry([
            {
                name: tool.name,
                description: tool.description ?? 'Reads one task by its id.',
                inputSchema: (tool.inputSchema ?? {
                    type: 'object',
                }) as JSONSchema,
                execute: async (input: unknown) => {
                    try {
                        const result = await call(
                            (input ?? {}) as Record<string, unknown>,
                        );
                        if (mentions(result, reference.id)) {
                            payload = result;
                        }
                        return {
                            output:
                                typeof result === 'string'
                                    ? result.slice(0, 4000)
                                    : JSON.stringify(result ?? null).slice(
                                          0,
                                          4000,
                                      ),
                        };
                    } catch (error) {
                        return {
                            output:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                            isError: true,
                        };
                    }
                },
            },
        ]);
        const spec: AgentSpec = {
            id: 'business-rules-task-reader',
            agentName: 'BusinessRulesValidation',
            phase: 'taskReader',
            runName: 'taskReader',
            spanName: 'BusinessRulesValidation::taskReader',
            systemPrompt: [
                `Read the task "${reference.id}" with the ${tool.name} tool.`,
                'Call it with the arguments that return exactly that task. If the first call fails, read the error and try once more with corrected arguments.',
                'Do not summarize the task. When the tool has returned it, or after two failed calls, answer DONE.',
            ].join('\n'),
            tools: registry,
            policies: [],
            maxSteps: MAX_STEPS,
            maxOutputTokens: 600,
        };
        const { ctx, cleanup } = createAgentRunContext({
            runId: 'business-rules:task-reader',
            timeoutMs: TIMEOUT_MS,
        });
        try {
            await new AiSdkAgentRunner(model, {
                organizationId: telemetry.organizationId,
                provider: model?.provider,
            }).run(
                spec,
                {
                    prompt: `Task id: ${reference.id}`,
                    telemetryMetadata: {
                        ...telemetry,
                        provider: model?.provider,
                    },
                },
                ctx,
            );
        } finally {
            cleanup();
        }
        return payload;
    };
}
