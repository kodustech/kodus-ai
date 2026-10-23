/**
 * `withLangfuseTrace` against the real `@langfuse/tracing` SDK, exported to
 * memory: the span shape Langfuse v4 ingests. v4 reads trace input/output
 * from the root observation only, and filters sessions/users on each
 * observation, so both have to be on the spans themselves — not inferred.
 */
import { trace } from '@opentelemetry/api';
import {
    InMemorySpanExporter,
    NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider } from '@langfuse/tracing';

import { withLangfuseTrace } from '@libs/core/log/langfuse';

describe('withLangfuseTrace (real SDK spans)', () => {
    const exporter = new InMemorySpanExporter();
    // The production processor: it is what stamps propagated attributes onto
    // each span at start. Only the network exporter is swapped out.
    const provider = new NodeTracerProvider({
        spanProcessors: [
            new LangfuseSpanProcessor({
                exporter,
                exportMode: 'immediate',
                shouldExportSpan: () => true,
            }),
        ],
    });
    const originalEnv = { ...process.env };

    beforeAll(() => {
        // Installs the async-hooks context manager propagation depends on.
        provider.register();
        setLangfuseTracerProvider(provider);
    });
    afterAll(async () => {
        setLangfuseTracerProvider(null);
        await provider.shutdown();
    });
    beforeEach(() => {
        exporter.reset();
        process.env.LANGFUSE_TRACING = 'true';
        process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
        process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    });
    afterEach(() => {
        process.env = { ...originalEnv };
    });

    // Stands in for the AI SDK: a plain OTel span opened by another library.
    const childLlmCall = () =>
        trace
            .getTracer('ai')
            .startActiveSpan('ai.generateText', async (span) => {
                span.end();
                return 'answer';
            });

    async function run() {
        const result = await withLangfuseTrace(
            {
                traceName: 'conversationAgent',
                sessionId: 'org-1:repo-9:42',
                userId: 'org-1',
                metadata: { organizationId: 'org-1', repositoryId: undefined },
            },
            async () => ({ steps: ['…'], text: await childLlmCall() }),
            { input: 'fix the bug', output: (r) => r.text },
        );
        await provider.forceFlush();
        const spans = exporter.getFinishedSpans();
        const root = spans.find((s) => s.name === 'conversationAgent')!;
        const child = spans.find((s) => s.name === 'ai.generateText')!;
        return { result, spans, root, child };
    }

    it('opens one root observation that parents the library spans', async () => {
        const { result, spans, root, child } = await run();

        expect(result.text).toBe('answer');
        expect(spans).toHaveLength(2);
        expect(root.parentSpanContext).toBeUndefined();
        expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
        expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
    });

    it('puts the trace input/output on the root observation', async () => {
        const { root } = await run();

        expect(root.attributes['langfuse.observation.input']).toBe(
            'fix the bug',
        );
        // The mapper's value, not the whole run state.
        expect(root.attributes['langfuse.observation.output']).toBe('answer');
    });

    it('propagates session, user, name and metadata to the root and every child', async () => {
        const { root, child } = await run();

        for (const span of [root, child]) {
            expect(span.attributes['session.id']).toBe('org-1:repo-9:42');
            expect(span.attributes['user.id']).toBe('org-1');
            expect(span.attributes['langfuse.trace.name']).toBe(
                'conversationAgent',
            );
            // SDK v6 JSON-encodes metadata values; absent ids never leave.
            expect(
                span.attributes['langfuse.trace.metadata.organizationId'],
            ).toBe('"org-1"');
            expect(
                span.attributes['langfuse.trace.metadata.repositoryId'],
            ).toBeUndefined();
        }
    });

    it('records nothing when tracing is disabled', async () => {
        delete process.env.LANGFUSE_TRACING;

        const out = await withLangfuseTrace(
            { traceName: 'conversationAgent' },
            async () => 'value',
            { input: 'x', output: (r) => r },
        );

        expect(out).toBe('value');
        await provider.forceFlush();
        expect(exporter.getFinishedSpans()).toHaveLength(0);
    });
});
