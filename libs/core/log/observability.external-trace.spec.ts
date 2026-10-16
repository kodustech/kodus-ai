const mockObservationUpdate = jest.fn();
const mockStartActiveObservation = jest.fn(
    async (_name: string, fn: (observation: unknown) => unknown) =>
        fn({ update: mockObservationUpdate }),
);
const mockGetActiveTraceId = jest.fn<string | undefined, []>(
    () => 'lf-trace-123',
);
jest.mock('@langfuse/tracing', () => ({
    ...jest.requireActual('@langfuse/tracing'),
    startActiveObservation: (name: string, fn: any) =>
        mockStartActiveObservation(name, fn),
    getActiveTraceId: () => mockGetActiveTraceId(),
}));

import { ObservabilityService } from './observability.service';

/**
 * A usage row in `observability_telemetry` had nothing that pointed at its
 * Langfuse trace — finding the trace for a costly run meant guessing by org,
 * PR and time. Each LLM call now runs inside one Langfuse observation, and the
 * row records that trace's id as `externalTraceId`.
 */
describe('ObservabilityService.runAiSdkLLMInSpan — externalTraceId', () => {
    const ENV = [
        'LANGFUSE_TRACING',
        'LANGFUSE_PUBLIC_KEY',
        'LANGFUSE_SECRET_KEY',
    ];
    let saved: Record<string, string | undefined>;

    function build() {
        const captured: Array<Record<string, any>> = [];
        const span = {
            setAttributes: (a: Record<string, any>) => captured.push(a),
            isRecording: () => true,
            end: () => undefined,
        };
        const service = new ObservabilityService({ get: jest.fn() } as any);
        (service as any).currentInstance = {
            startSpan: () => span,
            getCurrentSpan: () => span,
            getContext: () => ({ correlationId: 'corr' }),
            withSpan: async (_s: unknown, fn: () => any) => fn(),
        };
        const attr = (key: string) =>
            captured.find((a) => key in a)?.[key] as unknown;
        return { service, attr };
    }

    const call = (service: ObservabilityService, exec: () => Promise<any>) =>
        service.runAiSdkLLMInSpan({
            spanName: 'CodeReviewAgent::review',
            runName: 'code-review-generalist',
            traced: true,
            exec,
        });

    const ok = async () => ({ usage: { inputTokens: 1, outputTokens: 1 } });

    beforeEach(() => {
        saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
        process.env.LANGFUSE_TRACING = 'true';
        process.env.LANGFUSE_PUBLIC_KEY = 'pk';
        process.env.LANGFUSE_SECRET_KEY = 'sk';
        mockStartActiveObservation.mockClear();
        mockObservationUpdate.mockClear();
        mockGetActiveTraceId.mockReturnValue('lf-trace-123');
    });

    afterEach(() => {
        for (const k of ENV) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('records the Langfuse trace id on the usage row', async () => {
        const { service, attr } = build();

        await call(service, ok);

        expect(attr('externalTraceId')).toBe('lf-trace-123');
    });

    it('opens the observation under the run name', async () => {
        const { service } = build();

        await call(service, ok);

        expect(mockStartActiveObservation).toHaveBeenCalledWith(
            'code-review-generalist',
            expect.any(Function),
        );
    });

    it('runs the call inside the observation', async () => {
        const { service } = build();
        const exec = jest.fn(ok);

        await call(service, exec);

        expect(exec).toHaveBeenCalledTimes(1);
        expect(mockStartActiveObservation).toHaveBeenCalledTimes(1);
    });

    it('records the id even when the call fails, and rethrows', async () => {
        const { service, attr } = build();

        await expect(
            call(service, async () => {
                throw new Error('provider down');
            }),
        ).rejects.toThrow('provider down');

        expect(attr('externalTraceId')).toBe('lf-trace-123');
    });

    it('adds nothing when there is no active trace', async () => {
        mockGetActiveTraceId.mockReturnValue(undefined);
        const { service, attr } = build();

        await call(service, ok);

        expect(attr('externalTraceId')).toBeUndefined();
    });

    it('opens no observation and adds nothing with Langfuse off', async () => {
        delete process.env.LANGFUSE_TRACING;
        const { service, attr } = build();
        const exec = jest.fn(ok);

        await call(service, exec);

        expect(exec).toHaveBeenCalledTimes(1);
        expect(mockStartActiveObservation).not.toHaveBeenCalled();
        expect(attr('externalTraceId')).toBeUndefined();
    });

    // A call whose model telemetry is off sends Langfuse nothing; an
    // observation around it would be an empty trace, and its id a dead link.
    it('opens no observation for a call that is not traced', async () => {
        const { service, attr } = build();
        const exec = jest.fn(ok);

        await service.runAiSdkLLMInSpan({
            spanName: 'CodeReviewAgent::review',
            runName: 'code-review-generalist',
            exec,
        });

        expect(exec).toHaveBeenCalledTimes(1);
        expect(mockStartActiveObservation).not.toHaveBeenCalled();
        expect(attr('externalTraceId')).toBeUndefined();
    });

    // The other direction: from a log line or a usage row, find the call in
    // Langfuse by the ids they carry.
    it("tags the observation with the correlationId and the call's ids", async () => {
        const { service } = build();

        await service.runAiSdkLLMInSpan({
            spanName: 'CodeReviewAgent::review',
            runName: 'code-review-generalist',
            attrs: {
                organizationId: 'org-1',
                teamId: 'team-1',
                prNumber: 2013,
            },
            traced: true,
            exec: ok,
        });

        expect(mockObservationUpdate).toHaveBeenCalledWith({
            metadata: {
                correlationId: 'corr',
                organizationId: 'org-1',
                teamId: 'team-1',
                prNumber: '2013',
            },
        });
    });

    it('leaves out ids the call does not have', async () => {
        const { service } = build();

        await call(service, ok);

        expect(mockObservationUpdate).toHaveBeenCalledWith({
            metadata: { correlationId: 'corr' },
        });
    });

    it('falls back to the span name when the call has no run name', async () => {
        const { service } = build();

        await service.runAiSdkLLMInSpan({
            spanName: 'X::y',
            traced: true,
            exec: ok,
        });

        expect(mockStartActiveObservation).toHaveBeenCalledWith(
            'X::y',
            expect.any(Function),
        );
    });
});
