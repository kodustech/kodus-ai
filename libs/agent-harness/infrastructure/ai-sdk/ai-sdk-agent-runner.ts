/**
 * agent-harness — AgentRunner over `LLM.run` (the thin core loop).
 *
 * This is the ONLY agent loop in the harness. It maps our domain-agnostic
 * Policy seams onto the AI SDK's documented loop seams:
 *   policy.shouldStop   -> stopWhen (OR semantics) + hard stepCountIs fail-open
 *   policy.prepareStep  -> prepareStep (messages / activeTools / note)
 *   policy.onStepFinish -> onStepFinish (progress marking, trace)
 *
 * It contains NO domain logic and NO cross-cutting model concern. The model
 * itself — BYOK resolution, tuning, reasoning, prompt-cache, the observability
 * span that records usage — is owned by `LLM.run`; the runner passes ONLY the
 * loop (tools + the seams above) and the slot, and maps the result onto a
 * RunState. That is the whole point: one door to the model (`LLM.run`), and the
 * loop stays thin, stable, and unit-testable via composable policies.
 */
import { jsonSchema, tool as aiTool, type ModelMessage } from 'ai';
import { LLM, type AgentLoopResult } from '@libs/llm/llm';
import type { NormalizedModel } from '@libs/llm/byok-config';

import type {
    AgentRunInput,
    AgentRunner,
    AgentSpec,
} from '../../domain/contracts/agent.contract';
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
    /**
     * The runner no longer resolves the model — `LLM.run` does, from `slot`.
     * `modelOpts` carries the limiter/reporter knobs LLM.run threads into
     * resolution (the finder passes its own queueTimeoutMs / provider).
     */
    constructor(
        private readonly slot: NormalizedModel | undefined,
        private readonly modelOpts: {
            organizationId?: string;
            reporter?: (input: {
                organizationId?: string;
                provider: string;
                errorMessage: string;
            }) => void;
            queueTimeoutMs?: number;
            provider?: string;
        } = {},
    ) {}

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
        let result: AgentLoopResult;

        // ── loop seams built from the policies; forwarded to LLM.run, which owns
        // the model / tuning / reasoning / prompt-cache / observability span. ──

        // shouldStop: stop if ANY policy says so (LLM.run appends stepCountIs).
        const policyStopWhen = async ({ steps: aiSteps }: any) => {
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
        };

        // prepareStep: merge directives from all policies. Model switching is NOT
        // applied — every consumer runs a single model and LLM.run owns it, so a
        // policy's modelId stays trace-only (mergeDirectives records the conflict).
        const policyPrepareStep = async ({
            stepNumber,
            messages: msgs,
        }: any) => {
            const active = [...allToolNames];
            const view = buildView(stepNumber, msgs ?? messages, active);
            const merged = await this.mergeDirectives(spec.policies, view, emit);
            const out: Record<string, unknown> = {};

            if (merged.activeTools) {
                out.activeTools = merged.activeTools;
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
            // HARD invariant: the conversation array must NEVER contain a
            // system-role message — Google Gemini rejects any system message that
            // is not the first message. Coerce any stray system turn to a user turn.
            if (Array.isArray(out.messages)) {
                out.messages = sanitizeNoSystem(out.messages as ModelMessage[]);
            }
            return out;
        };

        // onStepFinish: collect the step + run policy hooks.
        const stepCollector = async (event: any) => {
            steps.push({
                index: steps.length,
                message: eventToMessage(event),
                usage: event?.usage ? readAiSdkUsage(event.usage) : undefined,
            });
            const view = buildView(steps.length, messages, allToolNames);
            for (const p of spec.policies) {
                if (p.onStepFinish) await p.onStepFinish(view);
            }
        };

        try {
            // ── the model call: ONE door. LLM.run resolves the slot → model +
            // tuning + reasoning + prompt-cache, runs the loop from these seams,
            // and records the run's usage in ONE span. The harness supplies only
            // the loop; it never touches the model nor records usage. ──
            result = await LLM.run({
                byokConfig: this.slot,
                organizationId: this.modelOpts.organizationId,
                reporter: this.modelOpts.reporter,
                queueTimeoutMs: this.modelOpts.queueTimeoutMs,
                provider: this.modelOpts.provider,
                // Observability naming: runName drives the Langfuse observation +
                // cost row; agentName/phase are the cost attrs; spanName the span.
                runName: spec.runName ?? spec.agentName ?? spec.id,
                spanName: spec.spanName,
                attrs: {
                    agentName: spec.agentName ?? spec.id,
                    ...(spec.phase ? { phase: spec.phase } : {}),
                    source: 'harness',
                },
                system: spec.systemPrompt,
                messages,
                // Sampling / max-output overrides (else the slot's own defaults).
                ...(spec.temperature != null
                    ? { temperature: spec.temperature }
                    : {}),
                ...(spec.maxOutputTokens != null
                    ? { maxOutputTokens: spec.maxOutputTokens }
                    : {}),
                // Reasoning override: the finder passes config-derived
                // providerOptions; unset → LLM.run derives from the slot.
                ...(spec.providerOptions
                    ? {
                          providerOptions: spec.providerOptions as Record<
                              string,
                              unknown
                          >,
                      }
                    : {}),
                // Cancellation / timeout composed by the caller (parent + hard timeout).
                signal: ctx.signal,
                telemetryMetadata: input.telemetryMetadata as any,
                loop: {
                    tools: toolMap,
                    maxSteps: spec.maxSteps,
                    stopWhen: [policyStopWhen],
                    prepareStep: policyPrepareStep,
                    onStepFinish: stepCollector,
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
            // LLM.run({ system }). This matches the legacy loop's pattern.
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
 *  The real system prompt is carried by LLM.run({ system }); providers
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
