import {
    captureReviewModelCall,
    collectReviewTelemetry,
    runAsReviewLogicalCall,
    type ReviewModelCallMetadata,
} from './review-telemetry';

const CONTEXT_BODY = 'private review packet';
const CONTEXT_RECEIPT = {
    source: 'cli-review-context-file',
    contentType: 'text/plain; charset=utf-8',
    sha256: '0123456789abcdef',
    utf8Bytes: Buffer.byteLength(CONTEXT_BODY, 'utf8'),
    recipient: 'bug-agent',
    phase: 'finder',
} as const;

function metadata(
    overrides: Partial<ReviewModelCallMetadata> = {},
): ReviewModelCallMetadata {
    return {
        provider: 'anthropic',
        model: 'claude-sonnet',
        agent: 'bug-agent',
        phase: 'finder',
        sdkMaxRetries: 0,
        ...overrides,
    };
}

describe('review telemetry', () => {
    it('aggregates parallel multi-agent calls and provider-reported cache tokens in deterministic start order', async () => {
        const firstCall = async () => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            return {
                usage: {
                    inputTokens: 100,
                    outputTokens: 20,
                    totalTokens: 120,
                    inputTokenDetails: {
                        cacheReadTokens: 40,
                        cacheWriteTokens: 10,
                    },
                },
            };
        };

        const captured = await collectReviewTelemetry(async () => {
            const bug = runAsReviewLogicalCall('bug-finder', () =>
                captureReviewModelCall(metadata(), firstCall),
            );
            const security = runAsReviewLogicalCall('security-finder', () =>
                captureReviewModelCall(
                    metadata({
                        provider: 'google',
                        model: 'gemini-2.5-pro',
                        agent: 'security-agent',
                    }),
                    async () => ({
                        usage: { inputTokens: 30, outputTokens: 7 },
                    }),
                ),
            );
            await Promise.all([bug, security]);
        });

        expect(captured.telemetry.modelCalls).toEqual([
            expect.objectContaining({
                callId: 'call-000001',
                logicalCallId: 'logical-call-000001',
                attempt: 1,
                provider: 'anthropic',
                model: 'claude-sonnet',
                agent: 'bug-agent',
                phase: 'finder',
                status: 'completed',
                usage: {
                    inputTokens: 100,
                    outputTokens: 20,
                    totalTokens: 120,
                    cacheReadTokens: 40,
                    cacheWriteTokens: 10,
                },
            }),
            expect.objectContaining({
                callId: 'call-000002',
                logicalCallId: 'logical-call-000002',
                provider: 'google',
                agent: 'security-agent',
            }),
        ]);
        expect(captured.telemetry.usageTotals).toEqual({
            inputTokens: 130,
            outputTokens: 27,
            totalTokens: 120,
            reasoningTokens: 0,
            cacheReadTokens: 40,
            cacheWriteTokens: 10,
            fieldReportingCallCount: {
                inputTokens: 2,
                outputTokens: 2,
                totalTokens: 1,
                reasoningTokens: 0,
                cacheReadTokens: 1,
                cacheWriteTokens: 1,
            },
            callsWithUsage: 2,
            incompleteCallCount: 0,
            incompleteReasons: [],
        });
    });

    it('records explicit attempts for retries without folding or double-counting them', async () => {
        const captured = await collectReviewTelemetry(() =>
            runAsReviewLogicalCall('rules-shard', async () => {
                await expect(
                    captureReviewModelCall(metadata(), async () => {
                        throw Object.assign(new Error('schema mismatch'), {
                            usage: { inputTokens: 11, outputTokens: 2 },
                        });
                    }),
                ).rejects.toThrow('schema mismatch');
                await captureReviewModelCall(metadata(), async () => ({
                    usage: { inputTokens: 13, outputTokens: 3 },
                }));
            }),
        );

        expect(captured.telemetry.modelCalls).toEqual([
            expect.objectContaining({
                logicalCallId: 'logical-call-000001',
                attempt: 1,
                status: 'failed',
                usage: { inputTokens: 11, outputTokens: 2 },
            }),
            expect.objectContaining({
                logicalCallId: 'logical-call-000001',
                attempt: 2,
                status: 'completed',
                usage: { inputTokens: 13, outputTokens: 3 },
            }),
        ]);
        expect(captured.telemetry.usageTotals.inputTokens).toBe(24);
        expect(captured.telemetry.modelCallCount).toBe(2);
    });

    it('marks successful and failed calls without provider usage as incomplete instead of zero-token calls', async () => {
        const captured = await collectReviewTelemetry(async () => {
            await runAsReviewLogicalCall('missing-success', () =>
                captureReviewModelCall(metadata(), async () => ({
                    usage: undefined,
                })),
            );
            await expect(
                runAsReviewLogicalCall('missing-failure', () =>
                    captureReviewModelCall(metadata(), async () => {
                        throw new Error('network unavailable');
                    }),
                ),
            ).rejects.toThrow('network unavailable');
        });

        expect(captured.telemetry.modelCalls).toEqual([
            expect.objectContaining({
                status: 'completed',
                usageUnavailableReason: 'provider-did-not-report-usage',
            }),
            expect.objectContaining({
                status: 'failed',
                usageUnavailableReason:
                    'model-call-failed-without-provider-usage',
            }),
        ]);
        expect(captured.telemetry.modelCalls[0]).not.toHaveProperty('usage');
        expect(captured.telemetry.modelCalls[1]).not.toHaveProperty('usage');
        expect(captured.telemetry.usageTotals).toMatchObject({
            callsWithUsage: 0,
            incompleteCallCount: 2,
            incompleteReasons: [
                {
                    reason: 'model-call-failed-without-provider-usage',
                    count: 1,
                },
                { reason: 'provider-did-not-report-usage', count: 1 },
            ],
        });
    });

    it('keeps completed and failed calls from a partial batch and orders records by attempted call id', async () => {
        const captured = await collectReviewTelemetry(async () => {
            const calls = [
                captureReviewModelCall(
                    metadata({ agent: 'agent-b', phase: 'verifier' }),
                    async () => ({ usage: { inputTokens: 5 } }),
                ),
                captureReviewModelCall(
                    metadata({ agent: 'agent-a', phase: 'finder' }),
                    async () => {
                        throw new Error('failed shard');
                    },
                ),
            ];
            await Promise.allSettled(calls);
        });

        expect(
            captured.telemetry.modelCalls.map((call) => call.callId),
        ).toEqual(['call-000001', 'call-000002']);
        expect(
            captured.telemetry.modelCalls.map((call) => call.status),
        ).toEqual(['completed', 'failed']);
    });

    it('correlates body-free context delivery evidence to the exact model call', async () => {
        const contextWithUnexpectedBody = {
            ...CONTEXT_RECEIPT,
            body: CONTEXT_BODY,
        };
        const captured = await collectReviewTelemetry(() =>
            runAsReviewLogicalCall('bug-finder', () =>
                captureReviewModelCall(
                    metadata({ reviewContext: contextWithUnexpectedBody }),
                    async () => ({
                        usage: { inputTokens: 8, outputTokens: 1 },
                    }),
                ),
            ),
        );

        expect(captured.telemetry.contextReceipts).toEqual([
            {
                callId: 'call-000001',
                logicalCallId: 'logical-call-000001',
                ...CONTEXT_RECEIPT,
                attemptState: 'completed',
                deliveryState: 'confirmed',
            },
        ]);
        expect(JSON.stringify(captured.telemetry)).not.toContain(CONTEXT_BODY);
    });

    it('marks delivery unknown when a context-bearing call fails before provider usage is available', async () => {
        const captured = await collectReviewTelemetry(async () => {
            await expect(
                runAsReviewLogicalCall('bug-finder', () =>
                    captureReviewModelCall(
                        metadata({ reviewContext: CONTEXT_RECEIPT }),
                        async () => {
                            throw new Error(CONTEXT_BODY);
                        },
                    ),
                ),
            ).rejects.toThrow(CONTEXT_BODY);
        });

        expect(captured.telemetry.contextReceipts[0]).toMatchObject({
            attemptState: 'failed',
            deliveryState: 'unknown',
        });
        expect(JSON.stringify(captured.telemetry)).not.toContain(CONTEXT_BODY);
    });

    it('confirms context delivery for a failed call when the provider reports usage', async () => {
        const captured = await collectReviewTelemetry(async () => {
            await expect(
                runAsReviewLogicalCall('bug-finder', () =>
                    captureReviewModelCall(
                        metadata({ reviewContext: CONTEXT_RECEIPT }),
                        async () => {
                            throw Object.assign(new Error('schema failure'), {
                                usage: { inputTokens: 9, outputTokens: 1 },
                            });
                        },
                    ),
                ),
            ).rejects.toThrow('schema failure');
        });

        expect(captured.telemetry.contextReceipts[0]).toMatchObject({
            attemptState: 'failed',
            deliveryState: 'confirmed',
        });
    });

    it('returns an empty baseline contract when no model or context call occurs', async () => {
        const captured = await collectReviewTelemetry(async () => 'done');

        expect(captured.value).toBe('done');
        expect(captured.telemetry).toMatchObject({
            schemaVersion: 1,
            modelCallCount: 0,
            modelCalls: [],
            contextReceipts: [],
            usageTotals: {
                callsWithUsage: 0,
                incompleteCallCount: 0,
                incompleteReasons: [],
            },
        });
    });

    it('isolates two sequential review requests without cross-request accumulation', async () => {
        const first = await collectReviewTelemetry(() =>
            captureReviewModelCall(metadata(), async () => ({
                usage: { inputTokens: 3 },
            })),
        );
        const second = await collectReviewTelemetry(async () => undefined);

        expect(first.telemetry.modelCallCount).toBe(1);
        expect(second.telemetry.modelCallCount).toBe(0);
        expect(second.telemetry.modelCalls).toEqual([]);
    });
});
