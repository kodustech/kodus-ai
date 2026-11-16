import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { activeTraceparent, exportStepsOf, METRIC, RuntimeMetrics, runContext, traceHeaders, traceIdFromCorrelationId, traceparentFor, withRunSpan } from './runtime-telemetry';

class TestReader extends MetricReader {
    constructor() {
        super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
    }
    protected async onForceFlush() {}
    protected async onShutdown() {}
}

async function harness() {
    const reader = new TestReader();
    const m = new RuntimeMetrics(new MeterProvider({ readers: [reader] }).getMeter('test'));
    const points = async (name: string) => {
        const { resourceMetrics } = await reader.collect();
        const metric = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((x) => x.descriptor.name === name);
        return (metric?.dataPoints ?? []).map((d) => ({ labels: d.attributes, value: d.value }));
    };
    return { m, points };
}

describe('runtime telemetry', () => {
    it('maps a UUID correlationId to the same traceId everywhere', () => {
        const cid = '7d1f0c3e-2b4a-4c5d-9e6f-0a1b2c3d4e5f';
        expect(traceIdFromCorrelationId(cid)).toBe('7d1f0c3e2b4a4c5d9e6f0a1b2c3d4e5f');
        expect(traceIdFromCorrelationId('not-a-uuid')).toMatch(/^[0-9a-f]{32}$/);
        expect(trace.getSpanContext(runContext(cid))!.traceId).toBe(traceIdFromCorrelationId(cid));
        expect(traceHeaders(cid).traceparent).toMatch(/^00-7d1f0c3e2b4a4c5d9e6f0a1b2c3d4e5f-[0-9a-f]{16}-01$/);
        expect(traceHeaders(cid)['x-correlation-id']).toBe(cid);
        expect(traceparentFor(cid)).toBe(traceHeaders(cid).traceparent);
    });

    it('puts a Run under the traceparent the product sent, and ignores one that is not W3C', () => {
        const cid = '7d1f0c3e-2b4a-4c5d-9e6f-0a1b2c3d4e5f';
        const product = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
        expect(trace.getSpanContext(runContext(cid, context.active(), product))).toMatchObject({ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331' });
        expect(traceHeaders(cid, product).traceparent).toBe(product);
        for (const bad of ['01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', '00-00000000000000000000000000000000-b7ad6b7169203331-01', 'junk']) {
            expect(trace.getSpanContext(runContext(cid, context.active(), bad))!.traceId).toBe(traceIdFromCorrelationId(cid));
        }
    });

    it('spans of a Run carry the correlationId, its trace, and hand their own context to the hub call', async () => {
        const exporter = new InMemorySpanExporter();
        const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
        provider.register();
        const cid = '7d1f0c3e-2b4a-4c5d-9e6f-0a1b2c3d4e5f';
        let headers: Record<string, string> = {};
        await withRunSpan('runtime.run.boot', cid, { 'kodus.runtime.run.id': 'r1' }, async () => {
            headers = traceHeaders(cid);
            expect(activeTraceparent()).toBe(headers.traceparent);
        });
        const [span] = exporter.getFinishedSpans();
        expect(span.spanContext().traceId).toBe('7d1f0c3e2b4a4c5d9e6f0a1b2c3d4e5f');
        expect(span.attributes['kodus.correlation.id']).toBe(cid);
        expect(headers.traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
        await provider.shutdown();
        trace.disable();
        context.disable();
    });

    it('counts Runs by state, trigger and org, and Run verdicts apart from probe verdicts', async () => {
        const { m, points } = await harness();
        m.recordRunState('booting', { orgId: 'org-1', trigger: 'comment' });
        m.recordRunVerdict('regression', { orgId: 'org-1', trigger: 'pull_request' });
        m.recordVerdict('finding');
        expect(await points(METRIC.runState)).toEqual([{ labels: { 'kodus.runtime.run.state': 'booting', 'kodus.runtime.run.trigger': 'comment', 'kodus.organization.id': 'org-1' }, value: 1 }]);
        expect(await points(METRIC.runVerdict)).toEqual([{ labels: { 'kodus.runtime.verdict': 'regression', 'kodus.runtime.run.trigger': 'pull_request', 'kodus.organization.id': 'org-1' }, value: 1 }]);
        expect(await points(METRIC.probeVerdict)).toEqual([{ labels: { 'kodus.runtime.probe.verdict': 'finding' }, value: 1 }]);
    });

    it('keeps the host the app chose and the cell out of the egress metric (bounded cardinality)', async () => {
        const { m, points } = await harness();
        for (const host of ['a.evil.test', 'b.evil.test', 'c.evil.test']) m.recordEgressBlocked({ cellId: 'c1', orgId: 'o1', host, phase: 'test' });
        expect(await points(METRIC.egressDenied)).toEqual([{ labels: { 'kodus.organization.id': 'o1', 'kodus.runtime.egress.phase': 'test' }, value: 3 }]);
    });

    it('counts a blocker by its signature class, never the repository text after it', async () => {
        const { m, points } = await harness();
        m.recordBlocker({ kind: 'missing_env', signature: 'missing_env:DATABASE_URL' }, { orgId: 'o1', consumer: 'setup' });
        m.recordBlocker({ kind: 'external_service', signature: 'external_service:api.private-vendor.example' }, { orgId: 'o1', consumer: 'setup' });
        m.recordBlocker({ kind: 'unknown', signature: 'something the cell made up' }, { orgId: 'o1', consumer: 'runtime' });
        const signatures = (await points(METRIC.blocker)).map((p) => p.labels['kodus.runtime.blocker.signature']);
        expect(signatures.sort()).toEqual(['external_service', 'missing_env', 'other']);
    });

    it('counts LLM tokens by task and token type', async () => {
        const { m, points } = await harness();
        m.recordLlmTokens({ inputTokens: 1200, outputTokens: 300 }, { orgId: 'o1', task: 'runtime.plan' });
        m.recordLlmTokens({ inputTokens: 50, outputTokens: 0 }, { orgId: 'o1', task: 'runtime.intent' });
        const byKey = Object.fromEntries((await points(METRIC.llmTokens)).map((p) => [`${p.labels['kodus.llm.task']}/${p.labels['gen_ai.token.type']}`, p.value]));
        expect(byKey).toEqual({ 'run_agent/input': 1200, 'run_agent/output': 300, 'intent/input': 50 });
    });

    it('counts evidence the worker could not write by kind only', async () => {
        const { m, points } = await harness();
        m.recordEvidenceWriteFailed({ orgId: 'o1', kind: 'probe' });
        m.recordEvidenceWriteFailed({ orgId: 'o1', kind: 'probe' });
        m.recordEvidenceWriteFailed({ orgId: 'o1', kind: 'exploration' });
        expect(await points(METRIC.evidenceWriteFailed)).toEqual([
            { labels: { kind: 'probe' }, value: 2 },
            { labels: { kind: 'exploration' }, value: 1 },
        ]);
    });

    it('reads the export steps of claim.ready timing.phases by the cell’s own names only', () => {
        expect(
            exportStepsOf([
                { name: 'yarn install', ms: 900 },
                { name: 'export layers', ms: 30_000 },
                { name: 'send tarball', ms: 4_000 },
                { name: 'export layers', ms: 1_000 },
                { name: 'push layers', ms: 5, running: true },
            ]),
        ).toEqual({ export_layers: 31_000, send_tarball: 4_000 });
        expect(exportStepsOf(undefined)).toEqual({});
    });
});
