import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

import { METRIC, RuntimeMetrics, runContext, traceHeaders, traceIdFromCorrelationId, withRunSpan } from './runtime-telemetry';

class TestReader extends MetricReader {
    constructor() {
        super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
    }
    protected async onForceFlush() {}
    protected async onShutdown() {}
}

describe('runtime telemetry', () => {
    it('maps a UUID correlationId to the same traceId everywhere', () => {
        const cid = '7d1f0c3e-2b4a-4c5d-9e6f-0a1b2c3d4e5f';
        expect(traceIdFromCorrelationId(cid)).toBe('7d1f0c3e2b4a4c5d9e6f0a1b2c3d4e5f');
        expect(traceIdFromCorrelationId('not-a-uuid')).toMatch(/^[0-9a-f]{32}$/);
        expect(trace.getSpanContext(runContext(cid))!.traceId).toBe(traceIdFromCorrelationId(cid));
        expect(traceHeaders(cid).traceparent).toMatch(/^00-7d1f0c3e2b4a4c5d9e6f0a1b2c3d4e5f-[0-9a-f]{16}-01$/);
        expect(traceHeaders(cid)['x-correlation-id']).toBe(cid);
    });

    it('spans of a Run carry the correlationId and its traceId', async () => {
        const exporter = new InMemorySpanExporter();
        const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
        trace.setGlobalTracerProvider(provider);
        const cid = '7d1f0c3e-2b4a-4c5d-9e6f-0a1b2c3d4e5f';
        await withRunSpan('runtime.run.boot', cid, { 'runtime.run.id': 'r1' }, async () => 1);
        const [span] = exporter.getFinishedSpans();
        expect(span.spanContext().traceId).toBe('7d1f0c3e2b4a4c5d9e6f0a1b2c3d4e5f');
        expect(span.attributes['correlation.id']).toBe(cid);
        trace.disable();
    });

    it('records the §11 metrics', async () => {
        const reader = new TestReader();
        const provider = new MeterProvider({ readers: [reader] });
        const m = new RuntimeMetrics(provider.getMeter('test'));
        m.recordProtocolViolation({ cellId: 'c1', code: 'invalid_body' });
        m.recordReaperTerminated({ cellId: 'c1', orgId: 'o1', reason: 'hard_expired' });
        m.recordEgressBlocked({ cellId: 'c1', orgId: 'o1', host: 'evil.test', phase: 'test' });
        m.recordLlmBudget(0.5, { orgId: 'o1', state: 'ok' });
        m.recordQueueWait(1200, { orgId: 'o1' });
        m.recordSecurityEvent({ orgId: 'o1', kind: 'canary', where: 'egress' });
        const { resourceMetrics } = await reader.collect();
        const names = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics.map((x) => x.descriptor.name));
        expect(names).toEqual(
            expect.arrayContaining([METRIC.protocolViolation, METRIC.reaperTerminated, METRIC.egressBlocked, METRIC.llmGatewayBudget, METRIC.queueWait, METRIC.securityEvent]),
        );
    });

    it('keeps the host the app chose out of the egress metric (bounded cardinality)', async () => {
        const reader = new TestReader();
        const m = new RuntimeMetrics(new MeterProvider({ readers: [reader] }).getMeter('test'));
        for (const host of ['a.evil.test', 'b.evil.test', 'c.evil.test']) m.recordEgressBlocked({ cellId: 'c1', orgId: 'o1', host, phase: 'test' });
        const { resourceMetrics } = await reader.collect();
        const metric = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((x) => x.descriptor.name === METRIC.egressBlocked)!;
        expect(metric.dataPoints).toHaveLength(1);
        expect(metric.dataPoints[0].attributes).toEqual({ orgId: 'o1', phase: 'test' });
    });

    it('counts evidence the worker could not write, by org and kind only', async () => {
        const reader = new TestReader();
        const m = new RuntimeMetrics(new MeterProvider({ readers: [reader] }).getMeter('test'));
        m.recordEvidenceWriteFailed({ orgId: 'o1', kind: 'probe' });
        m.recordEvidenceWriteFailed({ orgId: 'o1', kind: 'probe' });
        m.recordEvidenceWriteFailed({ orgId: 'o1', kind: 'exploration' });
        const { resourceMetrics } = await reader.collect();
        const metric = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((x) => x.descriptor.name === METRIC.evidenceWriteFailed)!;
        expect(metric.dataPoints.map((d) => [d.attributes, d.value])).toEqual([
            [{ orgId: 'o1', kind: 'probe' }, 2],
            [{ orgId: 'o1', kind: 'exploration' }, 1],
        ]);
    });
});
