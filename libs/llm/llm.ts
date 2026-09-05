/**
 * The ONE way to call an LLM.
 *
 * Like any SDK (`client.chat.completions.create`, `generateText`), you call one
 * method and get the result. The difference from a raw SDK: you don't pick the
 * `model` — you give the `task`, and the org's BYOK config resolves the model +
 * key + routing. Everything the three BYOK missions own lives INSIDE this call,
 * so no caller re-implements or threads any of it:
 *   1. access  — router → slot → model (BYOK key or managed default)
 *   2. tracing — the observability span (pulled from the app singleton here, so
 *                callers never pass an `observabilityService`)
 *   3. router  — task → slot via the org's stored routing config
 *
 * Shape:
 *   - `schema` present  → structured output, returns the parsed object
 *   - no `schema`       → plain text, returns the string
 *
 * Model source: pass a pre-resolved `byokConfig` slot (the caller already
 * routed), OR a `{ config, task }` pair to route here — routing is pure (the org
 * config is fetched upstream), so this stays in @libs/llm with no DB dependency.
 *
 * The tool-driven ("agent") path is NOT here: an agent is a LOOP around this
 * primitive (tools, MCP, N steps) — orchestration ABOVE the call, driven by the
 * agent runner, not by BYOK. It consumes the same assembled model.
 */
import { z } from 'zod';
import type { generateText, ModelMessage, Schema } from 'ai';
import type {
    NormalizedModel,
    BYOKConfig,
    LlmTask,
} from '@libs/llm/byok-config';
import { resolveTaskSlot } from '@libs/llm/resolve-task-model';
import type { RequestContext } from '@libs/llm/routing-strategy';
import {
    runStructuredReviewCall,
    runTextReviewCall,
    type BaseReviewCallParams,
} from '@libs/llm/structured-review-call';
import {
    runAgentLoopCall,
    type AgentLoopSeams,
} from '@libs/llm/agent-loop-call';
import {
    runWithModelFailover,
    type FailoverAttemptControl,
} from '@libs/llm/model-failover';

/** The raw AI SDK result an agent-loop call returns (steps / usage / text). */
export type AgentLoopResult = Awaited<ReturnType<typeof generateText>>;

export interface LlmRequest extends Omit<BaseReviewCallParams, 'byokConfig' | 'user'> {
    /** A pre-resolved slot — the caller already routed task → slot. */
    byokConfig?: NormalizedModel;
    /** OR route here: the org's stored BYOK config + the task. Pure routing. */
    config?: BYOKConfig | null;
    task?: LlmTask;
    /** Optional routing context (repo/provider hints) forwarded to the strategy. */
    ctx?: RequestContext;

    /** One-shot content: the user turn. Required for one-shot; the loop path
     *  uses `messages` instead. */
    user?: string;

    // ── agent-loop mode (presence of `loop` runs the tool-driven loop) ──
    /** The loop seams (tools / maxSteps / policy stopWhen·prepareStep·onStepFinish),
     *  built by the harness runner. Present → LLM.run runs the multi-step loop. */
    loop?: AgentLoopSeams;
    /** The conversation array for the loop path (the runner assembles it). */
    messages?: ModelMessage[];
    /** Cancellation / hard-timeout signal (loop path; the caller composes it). */
    signal?: AbortSignal;
    /** BYOK failure reporter (byok-error-counter hook). */
    reporter?: (input: {
        organizationId?: string;
        provider: string;
        errorMessage: string;
    }) => void;
    /** Concurrency-limiter queue timeout (loop path; the finder threads its own). */
    queueTimeoutMs?: number;
    /** Provider override for the limiter (loop path; defaults to the slot's). */
    provider?: string;
    /** Pre-built providerOptions override (loop path) — the finder's config-derived
     *  reasoning; unset → LLM.run derives it from the slot. */
    providerOptions?: Record<string, unknown>;
    /** Override the slot's sampling temperature. */
    temperature?: number;
    /** Fallback max-output when the slot omits one (loop path). */
    maxOutputTokens?: number;

    // NOTE: no `observabilityService` — LLM owns the span via the app singleton.
    // A service's injected instance IS that same singleton, so passing it was a
    // no-op; callers never thread observability.
}

/**
 * Resolve the ONE slot for this call: an explicit slot wins; otherwise route
 * from `{ config, task }`; otherwise undefined → the managed default (resolved
 * inside the executor).
 */
function resolveSlot(req: LlmRequest): NormalizedModel | undefined {
    if (req.byokConfig) {
        return req.byokConfig;
    }
    if (req.config && req.task) {
        return resolveTaskSlot(req.config, req.task, { ctx: req.ctx }).slot;
    }
    return undefined;
}

/**
 * Strip the routing-only fields — what reaches the one-shot executor is a clean
 * slot call. The slot is NOT set here: `run` injects the per-attempt slot (primary
 * or fallback) so the failover cascade can re-issue on a different model.
 * Observability is NOT threaded here either: the executor reads it from the LLM
 * observability port, so no caller (nor this) ever passes it.
 */
function toExecutorParams(
    req: LlmRequest,
): Omit<BaseReviewCallParams, 'byokConfig'> {
    const {
        config: _config,
        task: _task,
        ctx: _ctx,
        // loop-only fields never reach the one-shot executor
        loop: _loop,
        messages: _messages,
        signal: _signal,
        reporter: _reporter,
        // a pre-resolved slot is re-injected per attempt by `run`, not here
        byokConfig: _byokConfig,
        // temperature / maxOutputTokens / providerOptions DO pass through — the
        // one-shot executor honors them as fixed-tuning overrides (demo paths).
        ...rest
    } = req;
    return rest as Omit<BaseReviewCallParams, 'byokConfig'>;
}

/**
 * Wrap the runner's loop seams so the FIRST emitted step vetoes failover for the
 * current attempt: a step's tool calls mutate shared runner state (its step array
 * + policy progress), so restarting on the fallback would double-count them. The
 * high-value cascade (a bad/expired key, an unknown model) fails BEFORE the first
 * step, so it still fires — this only holds back a rare mid-loop transient.
 */
function loopWithFailoverGuard(
    loop: AgentLoopSeams,
    control: FailoverAttemptControl,
): AgentLoopSeams {
    const inner = loop.onStepFinish;
    return {
        ...loop,
        onStepFinish: (event: unknown) => {
            control.markUnsafeToRetry();
            return inner?.(event);
        },
    };
}

export class LLM {
    /** Agent-loop call — a `loop` (tools + policies) runs the multi-step loop,
     *  returning the raw AI SDK result (steps / usage / text). */
    static run(
        req: LlmRequest & { loop: AgentLoopSeams; schema?: undefined },
    ): Promise<AgentLoopResult>;
    /** Structured call — a `schema` yields the parsed, typed object. */
    static run<S extends z.ZodType | Schema>(
        req: LlmRequest & { schema: S },
    ): Promise<
        S extends z.ZodType ? z.infer<S> : S extends Schema<infer T> ? T : never
    >;
    /** Text call — no `schema` yields the raw generated string. */
    static run(req: LlmRequest & { schema?: undefined }): Promise<string>;
    static run(
        req: LlmRequest & { schema?: z.ZodType | Schema },
    ): Promise<unknown> {
        // Resolve the routing decision ONCE. The primary slot carries its runtime
        // fallback in `.fallback` (stamped by resolveTaskSlot), so the cascade is
        // primary → fallback; a slot without a fallback (or the managed default,
        // undefined) makes `runWithModelFailover` a single-attempt pass-through.
        const slot = resolveSlot(req);
        const attempts = [slot, slot?.fallback];
        const failoverOpts = {
            runName: req.runName,
            organizationId: req.organizationId,
        };

        // Agent-loop mode: a tool-driven, multi-step call. LLM.run resolves the
        // model + tuning + reasoning + cache + span; the runner passed only the
        // loop seams. Returns the raw result for the runner to map onto RunState.
        if (req.loop) {
            const loop = req.loop;
            return runWithModelFailover(
                attempts,
                (attemptSlot, control) =>
                    runAgentLoopCall({
                        byokConfig: attemptSlot,
                        system: req.system,
                        messages: req.messages ?? [],
                        loop: loopWithFailoverGuard(loop, control),
                        runName: req.runName,
                        spanName: req.spanName,
                        attrs: req.attrs,
                        organizationId: req.organizationId,
                        reporter: req.reporter,
                        queueTimeoutMs: req.queueTimeoutMs,
                        provider: req.provider,
                        providerOptions: req.providerOptions,
                        telemetryMetadata: req.telemetryMetadata,
                        recordTelemetryInputs: req.recordTelemetryInputs,
                        signal: req.signal,
                        maxOutputTokens: req.maxOutputTokens,
                        temperature: req.temperature,
                    }),
                failoverOpts,
            );
        }

        // Pull the schema out first so a text call can never carry a stray
        // `schema` prop into the text executor. One-shot calls are atomic, so they
        // never veto failover — a primary failure re-issues cleanly on the fallback.
        const { schema, ...rest } = req;
        const baseParams = toExecutorParams(rest);
        return runWithModelFailover(
            attempts,
            (attemptSlot) => {
                const params: BaseReviewCallParams = {
                    ...baseParams,
                    byokConfig: attemptSlot,
                };
                return schema
                    ? runStructuredReviewCall({ ...params, schema })
                    : runTextReviewCall(params);
            },
            failoverOpts,
        );
    }
}
