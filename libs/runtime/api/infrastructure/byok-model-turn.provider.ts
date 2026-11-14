import { jsonSchema, tool, type ModelMessage } from 'ai';
import { LLM } from '@libs/llm/llm';
import { LLM_TASK } from '@libs/llm/llm-tasks';
import { applyCacheBreakpoints } from '@libs/llm/prompt-cache';
import { hasManagedModelKey } from '@libs/llm/managed-slot';
import type { RuntimeModelTurnProvider } from '../domain/model-turn';
import type { RuntimeSlotResolver } from './byok-runtime-llm.provider';
import { LlmProviderUnavailableError } from '../domain/ports';
import type { ModelTurnResponse } from '@libs/runtime/contracts/model-turn';

/** One bounded LLM.run step; declarations have no execute callbacks on the product. */
export class ByokRuntimeModelTurnProvider implements RuntimeModelTurnProvider {
    constructor(
        private readonly slots: RuntimeSlotResolver,
        private readonly managed: () => boolean = hasManagedModelKey,
    ) {}
    async complete(input: Parameters<RuntimeModelTurnProvider['complete']>[0]) {
        const slot =
            (await this.slots.resolveTaskSlot(
                { organizationId: input.organizationId, teamId: input.teamId },
                LLM_TASK.runtime,
            )) ?? undefined;
        if (!slot && !this.managed())
            throw new LlmProviderUnavailableError('Runtime model unavailable');
        const cap = input.maxOutputTokens;
        const capped = slot
            ? {
                  ...slot,
                  maxOutputTokens: Math.min(slot.maxOutputTokens ?? cap, cap),
                  ...(slot.fallback
                      ? {
                            fallback: {
                                ...slot.fallback,
                                maxOutputTokens: Math.min(
                                    slot.fallback.maxOutputTokens ?? cap,
                                    cap,
                                ),
                            },
                        }
                      : {}),
              }
            : undefined;
        const call = input.request.call;
        const tools = Object.fromEntries(
            call.tools.map((t) => [
                t.name,
                tool({
                    description: t.description,
                    inputSchema: jsonSchema(t.inputSchema),
                    ...(t.strict === undefined ? {} : { strict: t.strict }),
                }),
            ]),
        );
        const choice = call.toolChoice;
        const toolChoice = !choice
            ? undefined
            : choice.type === 'tool'
              ? choice
              : choice.type;
        const systemFrame =
            call.prompt[0]?.role === 'system' ? call.prompt[0] : undefined;
        const cached = applyCacheBreakpoints({
            system: systemFrame?.content,
            messages: (systemFrame
                ? call.prompt.slice(1)
                : call.prompt) as ModelMessage[],
            tools,
            maxSteps: 12,
            provider: slot?.provider,
            model: slot?.model,
        });
        const instructions =
            systemFrame?.providerOptions && typeof cached.systemArg === 'string'
                ? { ...systemFrame, content: cached.systemArg }
                : cached.systemArg;
        const result = await LLM.run({
            byokConfig: capped,
            organizationId: input.organizationId,
            runName: 'runtime.plan.model-turn',
            attrs: {
                route: LLM_TASK.runtime,
                runId: input.runId,
                repositoryId: input.repositoryId,
                teamId: input.teamId,
                prNumber: input.prNumber,
                task: 'runtime.plan',
            },
            ...(systemFrame ? { system: systemFrame.content } : {}),
            messages: cached.callMessages,
            maxOutputTokens: cap,
            ...(call.temperature === undefined
                ? {}
                : { temperature: call.temperature }),
            signal: input.signal,
            loop: {
                tools: cached.callTools,
                maxSteps: 1,
                modelCallBudget: input.modelCallBudget,
                prepareStep: () => ({
                    ...(instructions ? { instructions } : {}),
                    ...(toolChoice ? { toolChoice } : {}),
                }),
            },
        });
        // The SDK result may contain extra unsupported content. Keep it for the
        // closed gateway parser to refuse; never silently drop a tool or signature.
        const content = result.content.map((part) => {
            if (part.type === 'tool-call') {
                const {
                    type,
                    toolCallId,
                    toolName,
                    input: args,
                    providerMetadata,
                    providerExecuted,
                } = part;
                return {
                    type,
                    toolCallId,
                    toolName,
                    input: JSON.stringify(args),
                    ...(providerMetadata ? { providerMetadata } : {}),
                    ...(providerExecuted === undefined
                        ? {}
                        : { providerExecuted }),
                };
            }
            if (part.type === 'text' || part.type === 'reasoning') {
                return {
                    type: part.type,
                    text: part.text,
                    ...(part.providerMetadata
                        ? { providerMetadata: part.providerMetadata }
                        : {}),
                };
            }
            return part;
        });
        const raw = result.usage;
        const inputUsage =
            typeof raw.inputTokens === 'number'
                ? { total: raw.inputTokens }
                : {};
        const outputUsage =
            typeof raw.outputTokens === 'number'
                ? { total: raw.outputTokens }
                : {};
        const reported =
            Object.keys(inputUsage).length + Object.keys(outputUsage).length >
            0;
        const generation = {
            content,
            finishReason: {
                unified: result.finishReason,
                ...(result.rawFinishReason
                    ? { raw: result.rawFinishReason }
                    : {}),
            },
            usage: reported
                ? {
                      reported: true,
                      inputTokens: inputUsage,
                      outputTokens: outputUsage,
                  }
                : { reported: false },
            warnings: result.warnings ?? [],
            // SDK generation-level metadata is diagnostics (usage, stop,
            // prediction counters, containers), not continuation state. Raw
            // usage is accounted by the product lease. Content metadata above
            // remains intact and must pass the closed round-trip schema.
        } as ModelTurnResponse['generation'];
        return {
            generation,
            ...(result.response?.modelId || slot?.model
                ? { model: result.response?.modelId || slot?.model }
                : {}),
        };
    }
}
