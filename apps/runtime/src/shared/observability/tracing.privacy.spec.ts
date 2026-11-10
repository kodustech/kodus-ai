import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { withRunSpan } from '@libs/runtime/telemetry/runtime-telemetry';
import { inSpan } from './tracing';

describe('Runtime exception telemetry (#2487)', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    beforeAll(() => provider.register());
    afterEach(() => exporter.reset());
    afterAll(async () => {
        await provider.shutdown();
        trace.disable();
    });

    for (const [name, run] of [
        [
            'hub',
            (fn: () => Promise<unknown>) =>
                inSpan('fixture.hub', { 'runtime.run.id': 'run-a' }, fn),
        ],
        [
            'worker',
            (fn: () => Promise<unknown>) =>
                withRunSpan(
                    'fixture.worker',
                    'fixture-correlation',
                    { 'runtime.run.id': 'run-a' },
                    fn,
                ),
        ],
    ] as const) {
        it(`${name} exports classification without exception content and preserves rejection identity`, async () => {
            const marker = 'synthetic-credential-marker';
            const error = Object.assign(new Error(marker), {
                code: 'ECONNRESET',
                request: { token: marker },
            });
            await expect(
                run(async () => {
                    throw error;
                }),
            ).rejects.toBe(error);
            const spans = exporter.getFinishedSpans();
            expect(spans).toHaveLength(1);
            expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
            expect(spans[0].attributes).toMatchObject({
                'error.type': 'network',
                'runtime.error.code': 'ECONNRESET',
                'runtime.run.id': 'run-a',
            });
            expect(
                JSON.stringify({
                    status: spans[0].status,
                    events: spans[0].events,
                    attributes: spans[0].attributes,
                }),
            ).not.toContain(marker);
        });
        it(`${name} does not evaluate an untrusted error getter`, async () => {
            const getter = jest.fn(() => {
                throw new Error('private getter');
            });
            const error = Object.create(null);
            Object.defineProperty(error, 'message', { get: getter });
            Object.defineProperty(error, 'code', { get: getter });
            await expect(
                run(async () => {
                    throw error;
                }),
            ).rejects.toBe(error);
            expect(getter).not.toHaveBeenCalled();
        });
    }
});
