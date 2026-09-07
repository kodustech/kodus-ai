import {
    captureReviewModelCall,
    collectReviewTelemetry,
    runAsReviewLogicalCall,
    type ReviewModelCallFailureCategory,
    type ReviewModelCallMetadata,
    type ReviewTelemetryModelCall,
} from './review-telemetry';

const SECRET = 'sk-live-private-packet-and-provider-body';
const METADATA: ReviewModelCallMetadata = {
    provider: 'synthetic-provider',
    model: 'synthetic-model',
    agent: 'synthetic-agent',
    phase: 'finder',
    sdkMaxRetries: 3,
};

async function captureFailure(
    error: unknown,
): Promise<ReviewTelemetryModelCall> {
    const captured = await collectReviewTelemetry(async () => {
        try {
            await captureReviewModelCall(METADATA, async () => {
                throw error;
            });
        } catch {
            return;
        }
    });
    const call = captured.telemetry.modelCalls[0];
    if (!call) {
        throw new Error('expected one captured model call');
    }
    return call;
}

function namedError(
    name: string,
    properties: Readonly<Record<string, unknown>> = {},
): Error {
    return Object.assign(new Error(SECRET), { name }, properties);
}

describe('review telemetry failure categories', () => {
    it.each([
        [
            'provider transport',
            namedError('AI_APICallError', {
                statusCode: 503,
                responseBody: SECRET,
            }),
            'provider_transport',
        ],
        [
            'provider rate limit',
            namedError('AI_APICallError', {
                statusCode: 429,
                responseBody: SECRET,
            }),
            'provider_rate_limit',
        ],
        [
            'provider timeout',
            namedError('TimeoutError', { code: 'ETIMEDOUT' }),
            'provider_timeout',
        ],
        [
            'provider authentication',
            namedError('AI_APICallError', {
                statusCode: 401,
                responseBody: SECRET,
            }),
            'provider_authentication',
        ],
        [
            'structured-output parse',
            namedError('AI_NoObjectGeneratedError', {
                cause: namedError('AI_JSONParseError'),
                text: SECRET,
            }),
            'structured_output_parse',
        ],
        [
            'structured-output schema',
            namedError('AI_NoObjectGeneratedError', {
                cause: namedError('AI_TypeValidationError'),
                value: { secret: SECRET },
            }),
            'structured_output_schema',
        ],
        [
            'structured-output conformance',
            namedError('AI_NoObjectGeneratedError', {
                cause: namedError('UnexpectedStructuredOutputError'),
                text: SECRET,
            }),
            'structured_output_conformance',
        ],
        [
            'cancellation',
            namedError('AbortError', { reason: SECRET }),
            'cancellation',
        ],
        ['internal', new Error(SECRET), 'internal'],
        ['unknown', { payload: SECRET, responseBody: SECRET }, 'unknown'],
    ] satisfies readonly (readonly [
        string,
        unknown,
        ReviewModelCallFailureCategory,
    ])[])(
        'records the bounded %s category',
        async (_label, error, expected) => {
            const call = await captureFailure(error);

            expect(call).toMatchObject({
                status: 'failed',
                failureCategory: expected,
            });
            expect(Object.keys(call).sort()).toEqual(
                [
                    'agent',
                    'attempt',
                    'callId',
                    'elapsedMs',
                    'failureCategory',
                    'logicalCallId',
                    'model',
                    'phase',
                    'provider',
                    'sdkMaxRetries',
                    'status',
                    'usageUnavailableReason',
                ].sort(),
            );
            expect(JSON.stringify(call)).not.toContain(SECRET);
        },
    );

    it('preserves failed-call usage and logical retry identity without persisting error data', async () => {
        const structuredError = namedError('AI_NoObjectGeneratedError', {
            cause: namedError('AI_JSONParseError'),
            text: SECRET,
            responseBody: SECRET,
            usage: { inputTokens: 17, outputTokens: 3 },
        });
        const captured = await collectReviewTelemetry(() =>
            runAsReviewLogicalCall('synthetic-logical-call', async () => {
                try {
                    await captureReviewModelCall(METADATA, async () => {
                        throw structuredError;
                    });
                } catch {
                    await captureReviewModelCall(METADATA, async () => ({
                        usage: { inputTokens: 19, outputTokens: 5 },
                    }));
                }
            }),
        );

        expect(captured.telemetry.modelCalls).toEqual([
            expect.objectContaining({
                logicalCallId: 'logical-call-000001',
                attempt: 1,
                status: 'failed',
                failureCategory: 'structured_output_parse',
                usage: { inputTokens: 17, outputTokens: 3 },
            }),
            expect.objectContaining({
                logicalCallId: 'logical-call-000001',
                attempt: 2,
                status: 'completed',
                usage: { inputTokens: 19, outputTokens: 5 },
            }),
        ]);
        expect(captured.telemetry.modelCalls[1]).not.toHaveProperty(
            'failureCategory',
        );
        expect(captured.telemetry.usageTotals.inputTokens).toBe(36);
        expect(JSON.stringify(captured.telemetry)).not.toContain(SECRET);
    });

    it('does not add a failure category to successful calls', async () => {
        const captured = await collectReviewTelemetry(() =>
            captureReviewModelCall(METADATA, async () => ({
                usage: { inputTokens: 2, outputTokens: 1 },
            })),
        );

        expect(captured.telemetry.modelCalls[0]).toMatchObject({
            status: 'completed',
            usage: { inputTokens: 2, outputTokens: 1 },
        });
        expect(captured.telemetry.modelCalls[0]).not.toHaveProperty(
            'failureCategory',
        );
    });
});
