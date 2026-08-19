/**
 * agent-harness — AgentRunner over the Vercel AI SDK (the thin core loop).
 *
 * This is the ONLY agent loop in the harness. It maps our domain-agnostic
 * Policy seams onto the AI SDK's documented seams:
 *   policy.shouldStop   -> stopWhen (OR semantics) + hard stepCountIs fail-open
 *   policy.prepareStep  -> prepareStep (messages / activeTools / model / note)
 *   policy.onStepFinish -> onStepFinish (progress marking, trace)
 *
 * It contains NO domain logic and NO cross-cutting concern — every concern
 * is a Policy injected via AgentSpec. That is the whole point: the loop is
 * thin and stable; behavior lives in composable, unit-testable policies.
 */
import {
    generateText,
    jsonSchema,
    stepCountIs,
    tool as aiTool,
    type LanguageModel,
    type ModelMessage,
} from 'ai';

import type {
    AgentRunInput,
    AgentRunner,
    AgentSpec,
} from '../../domain/contracts/agent.contract';
import type { ModelResolver } from '../../domain/contracts/model.contract';
import type {
    AgentPolicy,
    StepDirectives,
    StepView,
} from '../../domain/contracts/policy.contract';
import type {
    AgentMessage,
    Artifact,
    RunState,
    RunStep,
    TokenUsage,
    TraceEvent,
} from '../../domain/contracts/run-state.contract';
import type { ToolContext } from '../../domain/contracts/tool.contract';
import { isAiSdkToolSource } from './ai-sdk-tool-registry';

export class AiSdkAgentRunner implements AgentRunner {
    constructor(private readonly models: ModelResolver<LanguageModel>) {}

    async run(
        spec: AgentSpec,
        input: AgentRunInput,
        ctx: ToolContext,
    ): Promise<RunState> {
        const steps: RunStep[] = [];
        const trace: TraceEvent[] = [];
        const emit = (source: string, e: Omit<TraceEvent, 'at' | 'source'>) =>
            trace.push({ at: Date.now(), source, ...e });

        // --- tools ---
        // Prefer native AI SDK tools when the registry carries them
        // (AiSdkToolRegistry) — avoids a lossy JSON-Schema/Zod round-trip for
        // MCP + native tool packs. Otherwise convert AgentTool -> AI SDK tool.
        const toolMap: Record<string, any> = {};
        if (isAiSdkToolSource(spec.tools)) {
            Object.assign(toolMap, spec.tools.toAiSdkToolMap());
        } else {
            for (const t of spec.tools.list()) {
                toolMap[t.name] = aiTool({
                    description: t.description,
                    inputSchema: jsonSchema(t.inputSchema as any),
                    // Forward the tool's opt-in strict flag (set by the domain
                    // only for strict-capable models). Providers that don't
                    // support strict tool calling ignore it.
                    ...(t.strict != null ? { strict: t.strict } : {}),
                    execute: async (args: unknown) => {
                        const r = await t.execute(args, ctx);
                        return r.isError ? `ERROR: ${r.output}` : r.output;
                    },
                });
            }
        }

        // --- seed messages ---
        const messages: ModelMessage[] = sanitizeNoSystem([
            ...(input.seedMessages ?? []).map(
                (m) => ({ role: m.role, content: m.content }) as ModelMessage,
            ),
            { role: 'user', content: input.prompt },
        ]);

        const buildView = (
            stepNumber: number,
            msgs: ModelMessage[],
            active: string[],
        ): StepView => ({
            runId: ctx.runId,
            agentId: spec.id,
            stepNumber,
            maxSteps: spec.maxSteps,
            steps,
            messages: msgs.map(toAgentMessage),
            activeTools: active,
        });

        const allToolNames = spec.tools.list().map((t) => t.name);

        await this.runPolicyHook(spec.policies, 'onRunStart', () =>
            buildView(0, messages, allToolNames),
        );

        let stopReason: string | undefined;

        let result: Awaited<ReturnType<typeof generateText>>;

        try {
            result = await generateText({
                model: this.models.resolve(spec.modelId),
                // Cap SDK-level retries to 3 on the main loop. Some BYOK
                // providers (Neuralwatt/GLM, Synthetic, Z.AI) intermittently
                // return empty response bodies (output: null, usage.total: 0).
                // These are fast failures — the provider returns quickly —
                // so extra retries don't burn meaningful timeout budget.
                // At 3 retries (4 total attempts) the loop survives transient
                // empty-body responses without changing the per-call timeout.
                maxRetries: 3,
                // When the domain supplies systemProviderOptions (e.g. Anthropic
                // prompt caching), send the system prompt as a system message
                // carrying those options; otherwise a plain string.
                system: spec.systemProviderOptions
                    ? ({
                          role: 'system',
                          content: spec.systemPrompt,
                          providerOptions: spec.systemProviderOptions,
                      } as any)
                    : spec.systemPrompt,
                messages,
                tools: toolMap,
                // Generic model-call config (omit -> provider default).
                ...(spec.temperature != null
                    ? { temperature: spec.temperature }
                    : {}),
                ...(spec.maxOutputTokens != null
                    ? { maxOutputTokens: spec.maxOutputTokens }
                    : {}),
                // Cancellation / timeout: forwarded from the caller (the domain
                // composes parent-job signal + a hard per-agent timeout into it).
                abortSignal: ctx.signal,
                // Opaque provider options (reasoning/thinking config) — domain-built.
                ...(spec.providerOptions
                    ? { providerOptions: spec.providerOptions as any }
                    : {}),
                // Opaque per-run telemetry → AI SDK 7 `telemetry` (+ optional
                // `runtimeContext` when the payload includes `metadata`).
                // Domain builds the shape (e.g. buildLangfuseTelemetry); the
                // harness only forwards / remaps, never interprets.
                ...(input.telemetry
                    ? expandAiSdkTelemetry(input.telemetry)
                    : {}),
                // shouldStop seam: stop if ANY policy says so; hard fail-open at maxSteps.
                stopWhen: [
                    async ({ steps: aiSteps }: any) => {
                        const view = buildView(
                            aiSteps?.length ?? 0,
                            messages,
                            allToolNames,
                        );

                        for (const p of spec.policies) {
                            if (p.shouldStop && (await p.shouldStop(view))) {
                                stopReason = p.name;
                                emit(p.name, { kind: 'stop' });
                                return true;
                            }
                        }
                        return false;
                    },
                    stepCountIs(spec.maxSteps),
                ],
                // prepareStep seam: merge directives from all policies in order.
                prepareStep: async ({ stepNumber, messages: msgs }: any) => {
                    const active = [...allToolNames];
                    const view = buildView(
                        stepNumber,
                        msgs ?? messages,
                        active,
                    );
                    const merged = await this.mergeDirectives(
                        spec.policies,
                        view,
                        emit,
                    );
                    const out: Record<string, unknown> = {};

                    if (merged.activeTools) {
                        out.activeTools = merged.activeTools;
                    }
                    if (merged.modelId) {
                        out.model = this.models.resolve(merged.modelId);
                    }
                    // injectNote -> trailing message (cache-prefix friendly)
                    if (merged.injectNote) {
                        out.messages = [
                            ...(msgs ?? messages),
                            {
                                role: merged.injectNote.role,
                                content: merged.injectNote.content,
                            },
                        ];
                    } else if (merged.messages) {
                        out.messages = merged.messages.map(toModelMessage);
                    }
                    // HARD invariant: the model `system` prompt is passed via
                    // generateText({ system }). The conversation array must NEVER
                    // contain a system-role message — Google Gemini rejects any
                    // system message that is not the first message. Coerce any
                    // stray system turn (from any policy/path) to a user turn.
                    if (Array.isArray(out.messages)) {
                        out.messages = sanitizeNoSystem(
                            out.messages as ModelMessage[],
                        );
                    }
                    return out;
                },
                onStepFinish: async (event: any) => {
                    const step: RunStep = {
                        index: steps.length,
                        message: eventToMessage(event),
                        usage: event?.usage
                            ? readAiSdkUsage(event.usage)
                            : undefined,
                    };
                    steps.push(step);
                    const view = buildView(
                        steps.length,
                        messages,
                        allToolNames,
                    );
                    for (const p of spec.policies) {
                        if (p.onStepFinish) await p.onStepFinish(view);
                    }
                },
            });
        } catch (err) {
            // "Observable by construction" must hold ESPECIALLY on failure:
            // a model/provider throw becomes a RunState{status:'error'} with
            // the steps collected so far + an error TraceEvent — never a bare
            // exception the caller has to reconstruct from a stack trace.
            const message = err instanceof Error ? err.message : String(err);
            const name = err instanceof Error ? err.name : undefined;
            // Carry the HTTP status and response body too. The AI SDK sets
            // `message` to a terse status phrase ("Not Found") and puts the
            // actionable detail in the body, so a {message, name} trace is not
            // enough for the caller to classify the failure — it degrades to
            // "Unexpected error" in the PR comment and the UI (#1568).
            const detail = err as Record<string, unknown> | undefined;
            const status =
                typeof detail?.statusCode === 'number'
                    ? detail.statusCode
                    : typeof detail?.status === 'number'
                      ? detail.status
                      : undefined;
            const responseBody =
                typeof detail?.responseBody === 'string'
                    ? detail.responseBody
                    : undefined;
            emit('runner', {
                kind: 'error',
                detail: {
                    message,
                    name,
                    step: steps.length,
                    ...(status !== undefined && { status }),
                    ...(responseBody && { responseBody }),
                },
            });
            const errView = buildView(steps.length, messages, allToolNames);

            for (const p of spec.policies) {
                if (p.onRunFinish) {
                    try {
                        await p.onRunFinish(errView);
                    } catch {
                        /* a policy's cleanup must not mask the original error */
                    }
                }
            }

            return {
                runId: ctx.runId,
                agentId: spec.id,
                status: 'error',
                steps,
                artifacts: materializeArtifacts(
                    steps,
                    spec.resultToolName,
                    'error',
                ),
                stopReason: 'error',
                usage: aggregateUsage(steps),
                trace,
            };
        }

        const finalView = buildView(steps.length, messages, allToolNames);
        for (const p of spec.policies) {
            if (p.onRunFinish) {
                await p.onRunFinish(finalView);
            }
        }

        return {
            runId: ctx.runId,
            agentId: spec.id,
            status: stopReason
                ? 'stopped'
                : steps.length >= spec.maxSteps
                  ? 'budget-exhausted'
                  : 'completed',
            steps,
            // "Result tool" convention: the structured output is materialized
            // here so the domain reads state.artifacts, never re-scans steps.
            artifacts: materializeArtifacts(
                steps,
                spec.resultToolName,
                stopReason ?? 'result',
            ),
            stopReason,
            usage: readAiSdkUsage(result.usage),
            trace,
        };
    }

    /** Merge StepDirectives from all policies (later policies win on scalars,
     *  notes are concatenated). Kept tiny + pure so it's unit-testable. */
    private async mergeDirectives(
        policies: readonly AgentPolicy[],
        view: StepView,
        emit: (source: string, e: Omit<TraceEvent, 'at' | 'source'>) => void,
    ): Promise<StepDirectives> {
        const merged: {
            messages?: readonly AgentMessage[];
            activeTools?: readonly string[];
            modelId?: string;
            injectNote?: { role: 'user'; content: string };
        } = {};
        const notes: string[] = [];
        // Track which policy last set each scalar, so a later override is
        // reported as a trace event (observable, never silent). Order=priority.
        let modelIdSource: string | undefined;
        let activeToolsSource: string | undefined;

        for (const p of policies) {
            if (!p.prepareStep) {
                continue;
            }
            const d = await p.prepareStep(view);
            if (d.messages) {
                merged.messages = d.messages;
            }

            if (d.activeTools) {
                if (activeToolsSource && activeToolsSource !== p.name) {
                    emit(p.name, {
                        kind: 'policy.conflict',
                        detail: {
                            directive: 'activeTools',
                            overrides: activeToolsSource,
                        },
                    });
                }
                merged.activeTools = d.activeTools;
                activeToolsSource = p.name;
            }

            if (d.modelId) {
                if (
                    modelIdSource &&
                    modelIdSource !== p.name &&
                    merged.modelId !== d.modelId
                ) {
                    emit(p.name, {
                        kind: 'policy.conflict',
                        detail: {
                            directive: 'modelId',
                            from: merged.modelId,
                            to: d.modelId,
                            overrides: modelIdSource,
                        },
                    });
                }
                merged.modelId = d.modelId;
                modelIdSource = p.name;
            }
            if (d.injectNote) {
                notes.push(d.injectNote.content);
            }

            for (const e of d.emit ?? []) {
                emit(p.name, e);
            }
        }
        if (notes.length) {
            // Mid-conversation steering notes MUST be a user turn, not system:
            // providers like Google Gemini reject system messages that aren't
            // the first message. The real system prompt stays at the top via
            // generateText({ system }). This matches the legacy loop's pattern.
            merged.injectNote = { role: 'user', content: notes.join('\n\n') };
        }
        return merged;
    }

    private async runPolicyHook(
        policies: readonly AgentPolicy[],
        hook: 'onRunStart',
        viewFactory: () => StepView,
    ): Promise<void> {
        const view = viewFactory();

        for (const p of policies) {
            const fn = p[hook];

            if (fn) {
                await fn.call(p, view);
            }
        }
    }
}

/** Coerce any system-role message in a conversation array to a user turn.
 *  The real system prompt is carried by generateText({ system }); providers
 *  like Google Gemini reject system messages outside the first position. */
function sanitizeNoSystem(messages: ModelMessage[]): ModelMessage[] {
    return messages.map((m) =>
        m.role === 'system' ? ({ ...m, role: 'user' } as ModelMessage) : m,
    );
}

/** Materialize the "result tool" convention: every call to spec.resultToolName
 *  becomes an Artifact, in step order, so the LAST one is the run's final
 *  structured output. The domain reads RunState.artifacts instead of re-scanning
 *  steps by hand — this is the gap the Artifact type promised but never filled.
 *  No resultToolName (or no matching call) -> [] (honest: nothing to capture). */
function materializeArtifacts(
    steps: readonly RunStep[],
    resultToolName: string | undefined,
    stage: string,
): Artifact[] {
    if (!resultToolName) {
        return [];
    }

    const artifacts: Artifact[] = [];

    for (const s of steps) {
        for (const tc of s.message.toolCalls ?? []) {
            if (tc.name !== resultToolName) {
                continue;
            }
            artifacts.push({
                type: resultToolName,
                payload: parseArtifactInput(tc.input),
                location: `step:${s.index}`,
                stage,
            });
        }
    }
    return artifacts;
}

/** Tool-call input may arrive as an object or a JSON string (provider-dependent).
 *  Normalize to the parsed object; fall back to the raw value if it isn't JSON. */
function parseArtifactInput(input: unknown): unknown {
    if (typeof input === 'string') {
        try {
            return JSON.parse(input);
        } catch {
            return input;
        }
    }
    return input;
}

/**
 * Map AI SDK `LanguageModelUsage` onto our TokenUsage.
 *
 * ai@7 removed top-level `cachedInputTokens` / `reasoningTokens` in favour of
 * `inputTokenDetails.cacheReadTokens` / `outputTokenDetails.reasoningTokens`.
 * Keep the ai@6 field names as fallbacks so mixed-version / vendor shims still
 * report cache hits.
 */
export function readAiSdkUsage(usage: any): TokenUsage {
    return {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        reasoningTokens:
            usage?.outputTokenDetails?.reasoningTokens ??
            usage?.reasoningTokens,
        cacheReadTokens:
            usage?.inputTokenDetails?.cacheReadTokens ??
            usage?.cachedInputTokens,
    };
}

/**
 * Map opaque domain telemetry into AI SDK 7 call options.
 * `metadata` (Langfuse-style) becomes `runtimeContext` + `includeRuntimeContext`
 * so observation attributes still attach after the AI SDK 7 telemetry redesign.
 */
function expandAiSdkTelemetry(
    raw: Readonly<Record<string, unknown>>,
): {
    telemetry: Record<string, unknown>;
    runtimeContext?: Record<string, unknown>;
} {
    const { metadata, ...telemetry } = raw as {
        metadata?: Record<string, unknown>;
        [key: string]: unknown;
    };
    if (!metadata || Object.keys(metadata).length === 0) {
        return { telemetry };
    }
    return {
        telemetry: {
            ...telemetry,
            includeRuntimeContext: Object.fromEntries(
                Object.keys(metadata).map((k) => [k, true]),
            ),
        },
        runtimeContext: metadata,
    };
}

/** Best-effort token usage from the steps collected before a failure —
 *  the error path has no provider-level total to read. */
function aggregateUsage(steps: readonly RunStep[]): TokenUsage {
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let cacheReadTokens = 0;
    for (const s of steps) {
        inputTokens += s.usage?.inputTokens ?? 0;
        outputTokens += s.usage?.outputTokens ?? 0;
        reasoningTokens += s.usage?.reasoningTokens ?? 0;
        cacheReadTokens += s.usage?.cacheReadTokens ?? 0;
    }
    return { inputTokens, outputTokens, reasoningTokens, cacheReadTokens };
}

// --- mappers (AI SDK <-> core contracts) ---
function toAgentMessage(m: ModelMessage): AgentMessage {
    // Preserve structured content (tool-result / tool-call / text parts) as-is.
    // Stringifying a `tool` turn here is what made the compressed window crash
    // the SDK on `content.filter` at the next step; keeping the array intact
    // lets it round-trip back to generateText unchanged.
    return {
        role: m.role as AgentMessage['role'],
        content: m.content,
    };
}
function toModelMessage(m: AgentMessage): ModelMessage {
    return { role: m.role, content: m.content } as ModelMessage;
}
function eventToMessage(event: any): AgentMessage {
    return {
        role: 'assistant',
        content: typeof event?.text === 'string' ? event.text : '',
        toolCalls: (event?.toolCalls ?? []).map((tc: any) => ({
            id: tc.toolCallId ?? tc.id ?? '',
            name: tc.toolName ?? tc.name ?? '',
            input: tc.input ?? tc.args,
        })),
    };
}
