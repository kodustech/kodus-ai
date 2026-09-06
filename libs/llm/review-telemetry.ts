import { AsyncLocalStorage } from 'node:async_hooks';
import {
    readAiSdkUsage,
    readAiSdkUsageFromError,
    type AiSdkUsage,
    type AiSdkUsageInput,
} from './ai-sdk-usage';

export const REVIEW_TELEMETRY_SCHEMA_VERSION = 1 as const;

export type ReviewModelCallStatus = 'completed' | 'failed';
export type ReviewContextDeliveryState = 'confirmed' | 'unknown';
export type ReviewUsageUnavailableReason =
    | 'provider-did-not-report-usage'
    | 'model-call-failed-without-provider-usage';

export interface ReviewContextCallMetadata {
    readonly source: string;
    readonly contentType: string;
    readonly sha256: string;
    readonly utf8Bytes: number;
    readonly recipient: string;
    readonly phase: string;
}

export interface ReviewModelCallMetadata {
    readonly provider: string;
    readonly model: string;
    readonly agent: string;
    readonly phase: string;
    readonly sdkMaxRetries: number;
    readonly reviewContext?: ReviewContextCallMetadata;
}

export interface ReviewTelemetryModelCall {
    readonly callId: string;
    readonly logicalCallId: string;
    readonly attempt: number;
    readonly provider: string;
    readonly model: string;
    readonly agent: string;
    readonly phase: string;
    readonly sdkMaxRetries: number;
    readonly status: ReviewModelCallStatus;
    readonly elapsedMs: number;
    readonly usage?: AiSdkUsage;
    readonly usageUnavailableReason?: ReviewUsageUnavailableReason;
}

export interface ReviewTelemetryContextReceipt extends ReviewContextCallMetadata {
    readonly callId: string;
    readonly logicalCallId: string;
    readonly attemptState: ReviewModelCallStatus;
    readonly deliveryState: ReviewContextDeliveryState;
}

export interface ReviewTelemetryUsageTotals {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly reasoningTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly fieldReportingCallCount: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalTokens: number;
        readonly reasoningTokens: number;
        readonly cacheReadTokens: number;
        readonly cacheWriteTokens: number;
    };
    readonly callsWithUsage: number;
    readonly incompleteCallCount: number;
    readonly incompleteReasons: readonly {
        readonly reason: ReviewUsageUnavailableReason;
        readonly count: number;
    }[];
}

export interface ReviewTelemetry {
    readonly schemaVersion: typeof REVIEW_TELEMETRY_SCHEMA_VERSION;
    readonly elapsedMs: number;
    readonly modelCallCount: number;
    readonly modelCalls: readonly ReviewTelemetryModelCall[];
    readonly usageTotals: ReviewTelemetryUsageTotals;
    readonly contextReceipts: readonly ReviewTelemetryContextReceipt[];
}

interface MutableModelCall {
    readonly sequence: number;
    readonly callId: string;
    readonly logicalCallId: string;
    readonly attempt: number;
    readonly metadata: ReviewModelCallMetadata;
    readonly startedAt: number;
    status?: ReviewModelCallStatus;
    elapsedMs?: number;
    usage?: AiSdkUsage;
    usageUnavailableReason?: ReviewUsageUnavailableReason;
}

interface LogicalCallContext {
    readonly id: string;
    attemptCount: number;
}

interface ReviewTelemetryContext {
    readonly recorder: ReviewTelemetryRecorder;
    readonly logicalCall?: LogicalCallContext;
}

interface UsageBearingResult {
    readonly usage?: AiSdkUsageInput;
}

const telemetryStorage = new AsyncLocalStorage<ReviewTelemetryContext>();

function paddedId(prefix: string, sequence: number): string {
    return `${prefix}-${sequence.toString().padStart(6, '0')}`;
}

function hasReportedUsage(usage: AiSdkUsage): boolean {
    return Object.values(usage).some((value) => value !== undefined);
}

function usageFromResult(result: UsageBearingResult): AiSdkUsage | undefined {
    const usage = readAiSdkUsage(result.usage);
    return hasReportedUsage(usage) ? usage : undefined;
}

class ReviewTelemetryRecorder {
    private readonly startedAt = Date.now();
    private nextLogicalCallSequence = 0;
    private nextCallSequence = 0;
    private readonly calls: MutableModelCall[] = [];

    createLogicalCall(): LogicalCallContext {
        this.nextLogicalCallSequence += 1;
        return {
            id: paddedId('logical-call', this.nextLogicalCallSequence),
            attemptCount: 0,
        };
    }

    startCall(
        metadata: ReviewModelCallMetadata,
        logicalCall: LogicalCallContext,
    ): MutableModelCall {
        this.nextCallSequence += 1;
        logicalCall.attemptCount += 1;
        const reviewContext = metadata.reviewContext;
        const call: MutableModelCall = {
            sequence: this.nextCallSequence,
            callId: paddedId('call', this.nextCallSequence),
            logicalCallId: logicalCall.id,
            attempt: logicalCall.attemptCount,
            metadata: {
                provider: metadata.provider,
                model: metadata.model,
                agent: metadata.agent,
                phase: metadata.phase,
                sdkMaxRetries: metadata.sdkMaxRetries,
                ...(reviewContext
                    ? {
                          reviewContext: {
                              source: reviewContext.source,
                              contentType: reviewContext.contentType,
                              sha256: reviewContext.sha256,
                              utf8Bytes: reviewContext.utf8Bytes,
                              recipient: reviewContext.recipient,
                              phase: reviewContext.phase,
                          },
                      }
                    : {}),
            },
            startedAt: Date.now(),
        };
        this.calls.push(call);
        return call;
    }

    completeCall(call: MutableModelCall, result: UsageBearingResult): void {
        call.status = 'completed';
        call.elapsedMs = Date.now() - call.startedAt;
        const usage = usageFromResult(result);
        if (usage) {
            call.usage = usage;
        } else {
            call.usageUnavailableReason = 'provider-did-not-report-usage';
        }
    }

    failCall(call: MutableModelCall, error: unknown): void {
        call.status = 'failed';
        call.elapsedMs = Date.now() - call.startedAt;
        const usage = readAiSdkUsageFromError(error)?.usage;
        if (usage) {
            call.usage = usage;
        } else {
            call.usageUnavailableReason =
                'model-call-failed-without-provider-usage';
        }
    }

    snapshot(): ReviewTelemetry {
        const calls = this.calls
            .filter(
                (
                    call,
                ): call is MutableModelCall & {
                    status: ReviewModelCallStatus;
                    elapsedMs: number;
                } => call.status !== undefined && call.elapsedMs !== undefined,
            )
            .sort((left, right) => left.sequence - right.sequence);
        const modelCalls = calls.map((call) => this.toPublicCall(call));

        return {
            schemaVersion: REVIEW_TELEMETRY_SCHEMA_VERSION,
            elapsedMs: Date.now() - this.startedAt,
            modelCallCount: modelCalls.length,
            modelCalls,
            usageTotals: this.buildUsageTotals(modelCalls),
            contextReceipts: calls.flatMap((call) =>
                this.toContextReceipt(call),
            ),
        };
    }

    private toPublicCall(
        call: MutableModelCall & {
            status: ReviewModelCallStatus;
            elapsedMs: number;
        },
    ): ReviewTelemetryModelCall {
        return {
            callId: call.callId,
            logicalCallId: call.logicalCallId,
            attempt: call.attempt,
            provider: call.metadata.provider,
            model: call.metadata.model,
            agent: call.metadata.agent,
            phase: call.metadata.phase,
            sdkMaxRetries: call.metadata.sdkMaxRetries,
            status: call.status,
            elapsedMs: call.elapsedMs,
            ...(call.usage ? { usage: call.usage } : {}),
            ...(call.usageUnavailableReason
                ? { usageUnavailableReason: call.usageUnavailableReason }
                : {}),
        };
    }

    private toContextReceipt(
        call: MutableModelCall & {
            status: ReviewModelCallStatus;
            elapsedMs: number;
        },
    ): readonly ReviewTelemetryContextReceipt[] {
        const reviewContext = call.metadata.reviewContext;
        if (!reviewContext) {
            return [];
        }

        return [
            {
                callId: call.callId,
                logicalCallId: call.logicalCallId,
                source: reviewContext.source,
                contentType: reviewContext.contentType,
                sha256: reviewContext.sha256,
                utf8Bytes: reviewContext.utf8Bytes,
                recipient: reviewContext.recipient,
                phase: reviewContext.phase,
                attemptState: call.status,
                deliveryState:
                    call.status === 'completed' || call.usage
                        ? 'confirmed'
                        : 'unknown',
            },
        ];
    }

    private buildUsageTotals(
        calls: readonly ReviewTelemetryModelCall[],
    ): ReviewTelemetryUsageTotals {
        const fields = [
            'inputTokens',
            'outputTokens',
            'totalTokens',
            'reasoningTokens',
            'cacheReadTokens',
            'cacheWriteTokens',
        ] as const satisfies readonly (keyof AiSdkUsage)[];
        const totals = {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        };
        const fieldReportingCallCount = { ...totals };
        const incompleteCounts = new Map<
            ReviewUsageUnavailableReason,
            number
        >();
        let callsWithUsage = 0;

        for (const call of calls) {
            if (call.usage) {
                callsWithUsage += 1;
                for (const field of fields) {
                    const value = call.usage[field];
                    if (value !== undefined) {
                        totals[field] += value;
                        fieldReportingCallCount[field] += 1;
                    }
                }
            } else if (call.usageUnavailableReason) {
                incompleteCounts.set(
                    call.usageUnavailableReason,
                    (incompleteCounts.get(call.usageUnavailableReason) ?? 0) +
                        1,
                );
            }
        }

        const incompleteReasons = Array.from(incompleteCounts.entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([reason, count]) => ({ reason, count }));

        return {
            ...totals,
            fieldReportingCallCount,
            callsWithUsage,
            incompleteCallCount: calls.length - callsWithUsage,
            incompleteReasons,
        };
    }
}

export async function collectReviewTelemetry<T>(
    execute: () => Promise<T>,
): Promise<{ readonly value: T; readonly telemetry: ReviewTelemetry }> {
    const recorder = new ReviewTelemetryRecorder();
    const value = await telemetryStorage.run({ recorder }, execute);
    return { value, telemetry: recorder.snapshot() };
}

export async function runAsReviewLogicalCall<T>(
    _runName: string,
    execute: () => Promise<T>,
): Promise<T> {
    const context = telemetryStorage.getStore();
    if (!context) {
        return execute();
    }

    return telemetryStorage.run(
        {
            recorder: context.recorder,
            logicalCall: context.recorder.createLogicalCall(),
        },
        execute,
    );
}

export async function captureReviewModelCall<T extends UsageBearingResult>(
    metadata: ReviewModelCallMetadata,
    execute: () => Promise<T>,
): Promise<T> {
    const context = telemetryStorage.getStore();
    if (!context) {
        return execute();
    }

    const logicalCall =
        context.logicalCall ?? context.recorder.createLogicalCall();
    const call = context.recorder.startCall(metadata, logicalCall);

    try {
        const result = await execute();
        context.recorder.completeCall(call, result);
        return result;
    } catch (error) {
        context.recorder.failCall(call, error);
        throw error;
    }
}
