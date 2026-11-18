import { generateText, stepCountIs } from 'ai';
import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
} from '@ai-sdk/provider';
import type { AgentLoopInvoker } from '@libs/agent-harness/infrastructure/ai-sdk/agent-loop-invoker';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import {
    planTests,
    planWithoutModel,
    type RepoReader,
} from '@libs/runtime/planner';
import {
    PLANNER_SOURCE_PATH,
    PLANNER_SOURCE_LIMITS,
    parsePlannerSourceResponse,
} from '@libs/runtime/contracts/planner-source';
import {
    containsCanary,
    type CanaryVault,
    CanaryLeakError,
} from '../canary/canary';
import { stableStepId } from '../run/step-id';
import type { SecretOpener } from '../secrets/sealed-tokens';
import type { RunPlanCall, RunPlanClient } from './http-run-plan';
import { LlmBudgetExceededError, LlmUnavailableError } from './llm-gateway';
import { toModelTurnRequest, toSdkModelTurnResult } from './model-turn-frames';
import {
    HttpModelTurnClient,
    readRuntimeRpc,
    rpcData,
    type RuntimeRpcFetch,
    type WorkerModelTurnClient,
} from './http-model-turn';

function frame(options: LanguageModelV4CallOptions) {
    // Reject tuning/media/provider extensions not in the agreed wire contract.
    if (
        options.stopSequences?.length ||
        options.topK !== undefined ||
        options.topP !== undefined ||
        options.frequencyPenalty !== undefined ||
        options.presencePenalty !== undefined ||
        options.seed !== undefined ||
        (options.providerOptions &&
            Object.keys(options.providerOptions).length) ||
        (options.headers &&
            Object.entries(options.headers).some(
                ([key, value]) =>
                    value !== undefined &&
                    (key.toLowerCase() !== 'user-agent' ||
                        !/^ai\/[A-Za-z0-9.+-]+$/.test(value)),
            )) ||
        (options.reasoning && options.reasoning !== 'provider-default') ||
        options.includeRawChunks ||
        (options.responseFormat && options.responseFormat.type !== 'text')
    )
        throw new LlmUnavailableError('Unsupported model turn options');
    return {
        prompt: options.prompt,
        tools: options.tools ?? [],
        ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
        ...(options.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: options.maxOutputTokens }),
        ...(options.temperature === undefined
            ? {}
            : { temperature: options.temperature }),
    };
}
/** Existing SDK loop, with only the single model turn delegated to the product. */
export function workerPlannerInvoker(
    call: RunPlanCall,
    client: WorkerModelTurnClient,
): AgentLoopInvoker {
    return async (invocation) => {
        if (
            invocation.byokConfig ||
            invocation.provider ||
            invocation.providerOptions
        )
            throw new LlmUnavailableError('Worker model routing is forbidden');
        let turn = 0;
        const model: LanguageModelV4 = {
            specificationVersion: 'v4',
            provider: 'kodus-runtime-gateway',
            modelId: 'runtime.plan',
            supportedUrls: {},
            doGenerate: async (options) => {
                const request = toModelTurnRequest(
                    {
                        runId: call.runId,
                        attempt: call.attempt!,
                        turnId: stableStepId(
                            call.runId,
                            call.attempt!,
                            `planner:${call.body.round}:model:${turn++}`,
                        ),
                    },
                    frame(options),
                );
                return toSdkModelTurnResult(
                    request,
                    await client.complete({
                        runId: call.runId,
                        runToken: call.runToken,
                        request,
                        signal: options.abortSignal,
                    }),
                ).generation;
            },
            doStream: async () => {
                throw new LlmUnavailableError(
                    'Streaming model turns are unsupported',
                );
            },
        };
        return generateText({
            model,
            system: invocation.system,
            messages: invocation.messages,
            tools: invocation.loop.tools as any,
            maxRetries: 0,
            stopWhen: [
                ...((invocation.loop.stopWhen as any[]) ?? []),
                stepCountIs(invocation.loop.maxSteps),
            ],
            prepareStep: invocation.loop.prepareStep as any,
            onStepFinish: invocation.loop.onStepFinish as any,
            abortSignal: invocation.signal,
            ...(invocation.temperature === undefined
                ? {}
                : { temperature: invocation.temperature }),
            ...(invocation.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: invocation.maxOutputTokens }),
        });
    };
}
/** Worker-hosted planner. The product exposes scoped data reads, never Git credentials. */
export class WorkerRunPlanClient implements RunPlanClient {
    private readonly model: WorkerModelTurnClient;
    constructor(
        private readonly baseUrl: string,
        private readonly opts: {
            secrets: SecretOpener;
            canaries: CanaryVault;
            fetch?: RuntimeRpcFetch;
            model?: WorkerModelTurnClient;
        },
    ) {
        this.model = opts.model ?? new HttpModelTurnClient(baseUrl, opts);
    }
    async plan(call: RunPlanCall) {
        if (!call.attempt || call.runId !== call.body.runId)
            throw new LlmUnavailableError('Planner scope mismatch');
        if (
            containsCanary(
                JSON.stringify(call.body),
                this.opts.canaries.forRun(call),
            )
        )
            throw new CanaryLeakError('llm_prompt');
        const noModel = planWithoutModel(call.body);
        if (noModel || !call.body.entryPoints.length)
            return {
                status: 'planned' as const,
                plan: noModel ?? {
                    probes: [],
                    tests: [],
                    claims: [],
                    cannotProve: [],
                },
                rejected: [],
                usage: { inputTokens: 0, outputTokens: 0 },
                steps: 0,
            };
        let token: string;
        try {
            token = this.opts.secrets.open(call.runToken, call.runId);
        } catch {
            throw new LlmUnavailableError('Invalid Run context');
        }
        const timeout = AbortSignal.timeout(4 * 60_000);
        const signal = call.signal
            ? AbortSignal.any([call.signal, timeout])
            : timeout;
        const source = async (op: Record<string, unknown>) => {
            let response: Response;
            try {
                response = await (this.opts.fetch ?? fetch)(
                    `${this.baseUrl.replace(/\/+$/, '')}/${PLANNER_SOURCE_PATH}`,
                    {
                        method: 'POST',
                        redirect: 'error',
                        headers: {
                            'content-type': 'application/json',
                            'authorization': `Bearer ${token}`,
                        },
                        body: JSON.stringify({
                            v: 1,
                            scope: { runId: call.runId, attempt: call.attempt },
                            ...op,
                        }),
                        signal,
                    },
                );
            } catch {
                if (call.signal?.aborted) throw call.signal.reason;
                throw new LlmUnavailableError('Planner source unavailable');
            }
            if (!response.ok)
                throw new LlmUnavailableError(
                    `Planner source answered ${response.status}`,
                );
            return parsePlannerSourceResponse(
                rpcData(
                    await readRuntimeRpc(
                        response,
                        PLANNER_SOURCE_LIMITS.bytes + 4096,
                    ),
                ),
            );
        };
        const context = await source({ op: 'context' });
        if (!('repositoryName' in context))
            throw new LlmUnavailableError('Planner source context invalid');
        if (
            call.body.changedPaths.some(
                (path) => !context.changedPaths.includes(path),
            )
        )
            throw new LlmUnavailableError(
                'Planner changed-file scope mismatch',
            );
        const reader = (side: 'base' | 'head'): RepoReader => ({
            list: async (path) => {
                const out = await source({ op: 'list', side, path });
                if (!('entries' in out))
                    throw new LlmUnavailableError('Planner listing invalid');
                return out.entries;
            },
            read: async (path, maxBytes) => {
                const out = await source({ op: 'read', side, path, maxBytes });
                if (!('text' in out))
                    throw new LlmUnavailableError('Planner read invalid');
                return out.text;
            },
            exists: async (path) => {
                const out = await source({ op: 'exists', side, path });
                if (!('exists' in out))
                    throw new LlmUnavailableError(
                        'Planner existence check invalid',
                    );
                return out.exists;
            },
        });
        // The shared harness deliberately returns an error RunState. Preserve
        // control/security failures at this host boundary without changing that
        // contract for the product's other agents.
        let fatal: unknown;
        let incompleteUsage = false;
        const observedModel: WorkerModelTurnClient = {
            complete: async (turn) => {
                try {
                    const reply = await this.model.complete(turn);
                    if (
                        reply.budget.usageBasis === 'reservation' ||
                        reply.budget.additionalUsageUnknown ||
                        !reply.generation.usage.reported ||
                        reply.generation.usage.inputTokens.total ===
                            undefined ||
                        reply.generation.usage.outputTokens.total === undefined
                    )
                        incompleteUsage = true;
                    return reply;
                } catch (error) {
                    if (
                        error instanceof CanaryLeakError ||
                        error instanceof LlmBudgetExceededError ||
                        signal.aborted
                    )
                        fatal = signal.aborted ? signal.reason : error;
                    throw error;
                }
            },
        };
        const runner = new AiSdkAgentRunner(
            undefined,
            { organizationId: call.organizationId },
            workerPlannerInvoker(call, observedModel),
        );
        const { runStatus, ...answer } = await planTests(
            { runner, base: reader('base'), head: reader('head') },
            {
                runId: call.runId,
                repositoryName: context.repositoryName,
                baseSha: context.baseSha,
                request: call.body,
                signal,
            },
        );
        if (signal.aborted) throw signal.reason;
        if (fatal) throw fatal;
        if (incompleteUsage)
            answer.usage = {
                ...answer.usage,
                measurement:
                    answer.usage.inputTokens + answer.usage.outputTokens > 0
                        ? 'partial'
                        : 'unknown',
            };
        if (answer.status === 'no_plan' && runStatus === 'error')
            throw new LlmUnavailableError('Runtime worker planning failed');
        return answer;
    }
}
