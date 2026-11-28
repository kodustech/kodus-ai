import { SpanStatusCode, trace } from '@opentelemetry/api';
import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

import { RedactingSpanExporter } from '@libs/runtime/telemetry/redacting-span-exporter';
import { RuntimeMetrics } from '@libs/runtime/telemetry/runtime-telemetry';
import { scrubText, spanAttributes } from '@libs/runtime/telemetry/telemetry-guard';

import { HubMetrics } from '../../hub/hub-types';
import { RuntimeLogger } from './logger';

// One sentence: no secret value, placeholder, canary or token reaches a log
// line, a span or a metric, whatever field, attribute or label a caller puts
// it in. Each sample is a shape the Runtime handles (docs/runtime/observability.md,
// "Never in telemetry"); none is a real credential.

const SECRETS = {
    placeholder: 'kph_abcdefghijklmnopqrstuvwxyz234567',
    canaryNpmrc: 'npm_0123456789abcdef0123456789abcdef',
    canaryConfig: 'kdx_live_0123456789abcdef0123456789abcdef',
    githubAppToken: 'ghs_EXAMPLE0EXAMPLE0EXAMPLE0EXAMPLE0EXAM',
    // The provider prefix is split from its body so the source holds no token shape.
    gitlabToken: 'glpat-' + 'EXAMPLE0EXAMPLE0EXAM',
    awsKey: 'AKIAIOSFODNN7EXAMPLE',
    teamKey: 'kodus_0123456789abcdef0123456789',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    bearer: 'Bearer example0example0example0example0',
    urlCredential: 'https://deploy:hunter2-example@registry.example.test/v2/',
};
const VALUES = Object.values(SECRETS);
const leaks = (text: string) => VALUES.filter((v) => text.includes(v) || text.includes(v.replace(/^Bearer /, '')));

class TestReader extends MetricReader {
    constructor() {
        super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
    }
    protected async onForceFlush() {}
    protected async onShutdown() {}
}

describe('Runtime telemetry never carries a secret', () => {
    it('scrubs every secret shape out of free text, and leaves ordinary text alone', () => {
        for (const v of VALUES) expect(leaks(scrubText(`boot failed near ${v} after 3 s`).text)).toEqual([]);
        expect(scrubText('claim.ready after 1234 ms on cell-a').text).toBe('claim.ready after 1234 ms on cell-a');
    });

    it('log lines: in the message, in any field, nested or under an id key', () => {
        const lines: string[] = [];
        const log = new RuntimeLogger('runtime-worker', (l) => void lines.push(l));
        for (const [name, v] of Object.entries(SECRETS)) {
            log.write('warn', `fixture ${v}`, { claimId: v, detail: `x ${v}`, nested: { reason: v, list: [v] }, [name]: v });
        }
        log.warn({ msg: `nest ${SECRETS.githubAppToken}`, runId: SECRETS.placeholder });
        expect(lines.length).toBe(VALUES.length + 1);
        expect(lines.flatMap(leaks)).toEqual([]);
    });

    it('spans: attributes under taxonomy keys or any other, events, links and the status message', async () => {
        const memory = new InMemorySpanExporter();
        const exported: string[] = [];
        const redacting = new RedactingSpanExporter({
            export: (spans, done) => {
                for (const s of spans) exported.push(JSON.stringify({ name: s.name, attributes: s.attributes, events: s.events, status: s.status, links: s.links }));
                memory.export(spans, done);
            },
            shutdown: async () => undefined,
        });
        const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(redacting)] });
        const tracer = provider.getTracer('test');
        for (const v of VALUES) {
            const span = tracer.startSpan(`step ${v}`, {
                attributes: { 'kodus.runtime.claim.id': v, 'kodus.runtime.blocker.signature': v, 'server.address': v, 'gen_ai.request.model': v, 'free.text': v, runId: v },
            });
            span.addEvent('exception', { 'exception.message': v, 'exception.type': v });
            span.setStatus({ code: SpanStatusCode.ERROR, message: v });
            span.end();
        }
        await provider.forceFlush();
        expect(exported).toHaveLength(VALUES.length);
        expect(exported.flatMap(leaks)).toEqual([]);
        // What stays is the taxonomy's: an id that looks like one, a dimension closed to its values.
        expect(spanAttributes({ runId: 'run-1', 'kodus.runtime.claim.side': 'pr', 'kodus.runtime.blocker.signature': 'missing_env:DATABASE_URL', 'free.text': 'x' })).toEqual({
            'kodus.runtime.run.id': 'run-1',
            'kodus.runtime.claim.side': 'pr',
            'kodus.runtime.blocker.signature': 'missing_env',
        });
        await provider.shutdown();
        trace.disable();
    });

    it('metrics: no label of any series carries a secret, wherever the caller put it', async () => {
        const reader = new TestReader();
        const meter = new MeterProvider({ readers: [reader] }).getMeter('test');
        const m = new RuntimeMetrics(meter);
        const hub = new HubMetrics(meter);
        for (const v of VALUES) {
            m.recordRunState(v, { orgId: v, trigger: v });
            m.recordEgressBlocked({ orgId: v, host: v, cellId: v, phase: v });
            m.recordBlocker({ kind: v, signature: `missing_env:${v}` }, { orgId: v, consumer: v });
            m.recordSecurityEvent({ orgId: v, kind: 'canary', where: v });
            m.recordProtocolViolation({ cellId: v, code: v });
            hub.claimReadyWait(10, { outcome: v, consumer: v, driver: v });
            hub.step(5, { kind: v, outcome: v });
            hub.backgroundError(v);
        }
        const { resourceMetrics } = await reader.collect();
        const labels = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).flatMap((x) => x.dataPoints.map((d) => JSON.stringify(d.attributes)));
        expect(labels.length).toBeGreaterThan(0);
        expect(labels.flatMap(leaks)).toEqual([]);
    });
});
