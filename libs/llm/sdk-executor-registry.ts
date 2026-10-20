/**
 * The seam where a runtime other than the AI SDK can take a model call (#2113).
 *
 * `runAgentLoopCall` and `runReviewCall` ask it, at the point they would call
 * `generateText`, whether the attempt's slot runs elsewhere. Today the only
 * registrant is the Claude Agent SDK executor in `libs/ee/claude-agent-sdk`,
 * which the EE module registers on init when the license allows it. Unset —
 * community self-hosted, a bare test — every call runs `generateText` as before.
 *
 * Same pattern as `setLlmObservability`: the core declares what it needs and
 * never imports the implementation. This file, like the rest of `libs/llm`,
 * must not import `@anthropic-ai/claude-agent-sdk` or `@libs/ee/**` (lint rule).
 */
import type { ModelMessage } from 'ai';

import type { NormalizedModel } from '@libs/llm/byok-config';
import type { ByokFailureReporter } from '@libs/llm/byok-call-envelope';
import type { AgentLoopSeams } from '@libs/llm/agent-loop-call';
import type { LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';
import { createLogger } from '@libs/core/log/logger';

export interface SdkCallBase {
    slot: NormalizedModel | undefined;
    system?: string;
    runName: string;
    organizationId?: string;
    reporter?: ByokFailureReporter;
    queueTimeoutMs?: number;
    /** Provider named in classification and reports (defaults to the slot's). */
    provider?: string;
    /** The reasoning the AI SDK call would send (slot-derived or the caller's override). */
    providerOptions?: Record<string, unknown>;
    maxOutputTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    telemetryMetadata?: LangfuseTelemetryMetadata;
}

export interface SdkLoopCall extends SdkCallBase {
    messages: ModelMessage[];
    loop: AgentLoopSeams;
}

export interface SdkOneShotCall extends SdkCallBase {
    prompt: string;
    /** JSON schema of the structured output; absent for a text call. */
    jsonSchema?: Record<string, unknown>;
}

/** The fields of a `generateText` result the callers and the usage span read. */
export interface SdkCallUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputTokenDetails: { noCacheTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    outputTokenDetails: { textTokens: number; reasoningTokens: number };
}

export interface SdkOneShotResult {
    text: string;
    /** The structured object, when a schema was asked for and the model gave one. */
    output?: unknown;
    usage: SdkCallUsage;
    finishReason: string;
}

export interface ClaudeSdkExecutors {
    /** True when this attempt's slot runs on the SDK. */
    eligible(slot: NormalizedModel | undefined): boolean;
    /** A generateText-shaped loop result (`text`, `steps`, `usage`). */
    runLoop(call: SdkLoopCall): Promise<any>;
    runOneShot(call: SdkOneShotCall): Promise<SdkOneShotResult>;
    /** The runtime failed (not the provider): safe to rerun on `generateText`. */
    isInfraFailure(err: unknown): boolean;
    /** One test request on the SDK path with no fallback, for the doctor:
     *  where it stopped, if it did. Null when this organization's calls do
     *  not run on the SDK (no license). */
    probe?(params: { slot: NormalizedModel | undefined; organizationId?: string; timeoutMs: number }): Promise<SdkProbeResult | null>;
}

/** Each hop of an SDK call, as the doctor reports it. */
export interface SdkProbeResult {
    spawn: { ok: boolean; error?: string };
    gateway: { ok: boolean; error?: string };
    upstream: { ok: boolean; status?: number; error?: string };
}

let current: ClaudeSdkExecutors | undefined;

export function setClaudeSdkExecutors(impl: ClaudeSdkExecutors | undefined): void {
    current = impl;
}

export function getClaudeSdkExecutors(): ClaudeSdkExecutors | undefined {
    return current;
}

/** The registered executors when they take this slot, else undefined. */
export function sdkExecutorsFor(slot: NormalizedModel | undefined): ClaudeSdkExecutors | undefined {
    if (!current) return undefined;
    try {
        return current.eligible(slot) ? current : undefined;
    } catch {
        return undefined;
    }
}

const logger = createLogger('ClaudeSdkExecutor');

/**
 * Run on the SDK; if the runtime itself fails before anything was emitted, run
 * the same call on `generateText` instead (A6), and log it. A provider error,
 * or any failure after the first step, propagates as the attempt's error.
 */
export async function withSdkInfraFallback<T>(params: {
    executors: ClaudeSdkExecutors;
    runSdk: () => Promise<T>;
    runAiSdk: () => Promise<T>;
    /** True once the SDK path emitted a step (its state is shared with the caller). */
    started: () => boolean;
    runName: string;
    organizationId?: string;
    slot: NormalizedModel | undefined;
}): Promise<T> {
    try {
        return await params.runSdk();
    } catch (err) {
        if (params.started() || !params.executors.isInfraFailure(err)) throw err;
        // An expected stand-down (the org has no license for the SDK path) is
        // today's path by design, not an incident.
        if ((err as { expected?: boolean })?.expected === true) return params.runAiSdk();
        logger.warn({
            message: 'claude-sdk-infra-fallback',
            context: 'ClaudeSdkExecutor',
            error: err,
            metadata: {
                runName: params.runName,
                organizationId: params.organizationId,
                provider: params.slot?.provider,
                model: params.slot?.model,
                reason: (err as { reason?: string })?.reason,
            },
        });
        return params.runAiSdk();
    }
}
