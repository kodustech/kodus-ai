const {
    capturedCallGraph,
    fetchTraceWithRetry,
    pendingTraceRequests,
    traceRequests,
} = require('./private-callgraph-capture');

describe('private call graph capture', () => {
    it('accepts only explicit case-to-trace mappings from a private manifest', () => {
        expect(
            traceRequests({
                version: 1,
                cases: {
                    'private-case-a': {
                        traceId: 'trace-a',
                        required: [],
                    },
                },
            }),
        ).toEqual([{ caseId: 'private-case-a', traceId: 'trace-a' }]);
    });

    it('rejects a case without an explicit trace id instead of guessing a customer trace', () => {
        expect(() =>
            traceRequests({
                version: 1,
                cases: { 'private-case-a': { required: [] } },
            }),
        ).toThrow('private-case-a must include a non-empty traceId');
    });

    it('preserves only the captured call graph from a trace input', () => {
        const callGraph =
            '<CallGraph><ChangedFunction name="save" file="src/service.ts" /></CallGraph>';

        expect(
            capturedCallGraph(
                { caseId: 'private-case-a', traceId: 'trace-a' },
                {
                    input: {
                        review: { callGraph },
                        diff: 'customer source must not be copied',
                    },
                },
            ),
        ).toEqual({
            caseId: 'private-case-a',
            traceId: 'trace-a',
            captured: true,
            callGraph,
        });
    });

    it('records unavailable context without writing a fabricated graph', () => {
        expect(
            capturedCallGraph(
                { caseId: 'private-case-a', traceId: 'trace-a' },
                { input: { diff: 'only diff' } },
            ),
        ).toEqual({
            caseId: 'private-case-a',
            traceId: 'trace-a',
            captured: false,
        });
    });

    it('retries a rate-limited trace request before returning its payload', async () => {
        const trace = { input: { callGraph: '<CallGraph />' } };
        const fetchTrace = jest
            .fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 429,
                headers: { get: () => '0' },
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => trace,
            });
        const sleep = jest.fn().mockResolvedValue(undefined);

        await expect(
            fetchTraceWithRetry(
                fetchTrace,
                'https://langfuse.example/trace-a',
                {
                    headers: { Authorization: 'Basic test' },
                    sleep,
                    maxAttempts: 2,
                },
            ),
        ).resolves.toBe(trace);

        expect(fetchTrace).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(0);
    });

    it('skips cases already captured in a private checkpoint', () => {
        const requests = [
            { caseId: 'private-case-a', traceId: 'trace-a' },
            { caseId: 'private-case-b', traceId: 'trace-b' },
        ];

        expect(
            pendingTraceRequests(requests, {
                'private-case-a': { captured: true },
            }),
        ).toEqual([{ caseId: 'private-case-b', traceId: 'trace-b' }]);
    });
});
