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

    it('times out while consuming a successful response body', async () => {
        const fetchTrace = jest.fn(async (_url, options) => ({
            ok: true,
            json: () =>
                new Promise((_, reject) => {
                    options.signal.addEventListener('abort', () => {
                        reject(new Error('body stalled'));
                    });
                }),
        }));
        const onTimeout = jest.fn();

        await expect(
            fetchTraceWithRetry(
                fetchTrace,
                'https://langfuse.example/trace-a',
                {
                    attemptTimeoutMs: 1,
                    traceLabel: 'private-case-a',
                    onTimeout,
                },
            ),
        ).rejects.toThrow('Langfuse trace request timed out');

        expect(onTimeout).toHaveBeenCalledWith({
            attempt: 1,
            scope: 'attempt',
            timeoutMs: 1,
            traceLabel: 'private-case-a',
        });
    });

    it('falls back to the bounded retry default for invalid maxAttempts', async () => {
        const fetchTrace = jest.fn(() => {
            if (fetchTrace.mock.calls.length > 5) {
                throw new Error('retry limit was not applied');
            }

            return Promise.resolve({
                ok: false,
                status: 429,
                headers: { get: () => '0' },
            });
        });
        const sleep = jest.fn().mockResolvedValue(undefined);
        const warn = jest.fn();

        await expect(
            fetchTraceWithRetry(
                fetchTrace,
                'https://langfuse.example/trace-a',
                { maxAttempts: Infinity, sleep, warn },
            ),
        ).rejects.toThrow('Langfuse 429 while capturing a trace');

        expect(fetchTrace).toHaveBeenCalledTimes(5);
        expect(warn).toHaveBeenCalledWith(
            '[capture] invalid maxAttempts=Infinity; using default 5 (maximum 5)',
        );
    });

    it('caps Retry-After before waiting for another attempt', async () => {
        const fetchTrace = jest.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: { get: () => '3600' },
        });
        const sleep = jest.fn().mockResolvedValue(undefined);

        await expect(
            fetchTraceWithRetry(
                fetchTrace,
                'https://langfuse.example/trace-a',
                { maxAttempts: 2, sleep },
            ),
        ).rejects.toThrow('Langfuse 429 while capturing a trace');

        expect(sleep).toHaveBeenCalledWith(5_000);
    });

    it('bounds a never-settling retry delay with the capture deadline', async () => {
        const fetchTrace = jest.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: { get: () => '0' },
        });
        const sleep = jest.fn(() => new Promise(() => {}));
        const warn = jest.fn();

        await expect(
            Promise.race([
                fetchTraceWithRetry(
                    fetchTrace,
                    'https://langfuse.example/trace-a',
                    {
                        maxAttempts: 2,
                        overallTimeoutMs: 1,
                        sleep,
                        warn,
                    },
                ),
                new Promise((_, reject) => {
                    setTimeout(
                        () => reject(new Error('test deadline elapsed')),
                        25,
                    );
                }),
            ]),
        ).rejects.toThrow('Langfuse trace capture timed out');
    });

    it('warns and falls back when an attempt timeout exceeds its maximum', async () => {
        const fetchTrace = jest.fn().mockResolvedValue({
            ok: false,
            status: 500,
            headers: { get: () => null },
        });
        const warn = jest.fn();

        await expect(
            fetchTraceWithRetry(
                fetchTrace,
                'https://langfuse.example/trace-a',
                { attemptTimeoutMs: 60_000, warn },
            ),
        ).rejects.toThrow('Langfuse 500 while capturing a trace');

        expect(warn).toHaveBeenCalledWith(
            '[capture] invalid attemptTimeoutMs=60000; using default 15000 (maximum 30000)',
        );
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
