import { createHash } from 'crypto';
import { recordSafeFailure } from './failure';

import {
    Attributes,
    context,
    Context,
    Meter,
    metrics,
    propagation,
    Span,
    SpanStatusCode,
    trace,
    TraceFlags,
} from '@opentelemetry/api';

// §11: every Run has a traceId born with RuntimeRunRequested and mapped to the
// product's correlationId / x-correlation-id. The mapping is deterministic, so
// worker, hub and cell land in the same trace without sharing state.

export const METRIC = {
    protocolViolation: 'protocol.violation',
    reaperTerminated: 'reaper.terminated',
    egressBlocked: 'egress.blocked',
    llmGatewayBudget: 'llm.gateway.budget',
    queueWait: 'runtime.queue.wait',
    runState: 'runtime.run.state',
    runDuration: 'runtime.run.duration',
    verdict: 'runtime.verdict',
    cellConnected: 'cell.connected',
    securityEvent: 'runtime.security.event',
    evidenceWriteFailed: 'runtime.evidence.write_failed',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** traceId = the correlationId's hex when it is a UUID, else the first 128 bits of its sha256. */
export function traceIdFromCorrelationId(correlationId: string): string {
    if (UUID.test(correlationId)) {
        const hex = correlationId.replace(/-/g, '').toLowerCase();
        if (!/^0+$/.test(hex)) return hex;
    }
    return createHash('sha256').update(correlationId).digest('hex').slice(0, 32);
}

const rootSpanId = (correlationId: string) => createHash('sha256').update(`span:${correlationId}`).digest('hex').slice(0, 16);

/** A context whose remote parent is the Run's root, keyed by the correlationId. */
export function runContext(correlationId: string, parent: Context = context.active()): Context {
    const active = trace.getSpanContext(parent);
    if (active && active.traceId === traceIdFromCorrelationId(correlationId)) return parent;
    return trace.setSpanContext(parent, {
        traceId: traceIdFromCorrelationId(correlationId),
        spanId: rootSpanId(correlationId),
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
    });
}

export const correlationAttributes = (correlationId: string, extra: Attributes = {}): Attributes => ({
    'correlation.id': correlationId,
    'x-correlation-id': correlationId,
    ...extra,
});

export async function withRunSpan<T>(
    name: string,
    correlationId: string,
    attributes: Attributes,
    fn: (span: Span) => Promise<T>,
): Promise<T> {
    const tracer = trace.getTracer('kody-runtime');
    return tracer.startActiveSpan(name, { attributes: correlationAttributes(correlationId, attributes) }, runContext(correlationId), async (span) => {
        try {
            const out = await fn(span);
            span.setStatus({ code: SpanStatusCode.OK });
            return out;
        } catch (error) {
            recordSafeFailure(span, error);
            throw error;
        } finally {
            span.end();
        }
    });
}

/** W3C traceparent plus x-correlation-id, for worker → hub → cell calls. */
export function traceHeaders(correlationId: string): Record<string, string> {
    const carrier: Record<string, string> = { 'x-correlation-id': correlationId };
    propagation.inject(runContext(correlationId), carrier);
    if (!carrier.traceparent) {
        const sc = trace.getSpanContext(runContext(correlationId))!;
        carrier.traceparent = `00-${sc.traceId}-${sc.spanId}-01`;
    }
    return carrier;
}

/** The §11 metrics of the control plane. */
export class RuntimeMetrics {
    private readonly protocolViolation;
    private readonly reaperTerminated;
    private readonly egressBlocked;
    private readonly llmBudget;
    private readonly queueWait;
    private readonly runState;
    private readonly runDuration;
    private readonly verdict;
    private readonly cellConnected;
    private readonly securityEvent;
    private readonly evidenceWriteFailed;

    constructor(meter: Meter = metrics.getMeter('kody-runtime')) {
        this.protocolViolation = meter.createCounter(METRIC.protocolViolation, {
            description: 'Cell messages refused: outside the schema, or answering a step that is not the cell’s',
        });
        this.reaperTerminated = meter.createCounter(METRIC.reaperTerminated, {
            description: 'Claims terminated past their hard expiry; above zero means lease and dead-man both failed',
        });
        this.egressBlocked = meter.createCounter(METRIC.egressBlocked, { description: 'Outbound requests denied by the cell proxy' });
        this.llmBudget = meter.createHistogram(METRIC.llmGatewayBudget, {
            description: 'Fraction of the Run token budget used after each LLM gateway call',
            unit: '1',
        });
        this.queueWait = meter.createHistogram(METRIC.queueWait, { description: 'Time from RuntimeRunRequested to the Run leaving the fair queue', unit: 'ms' });
        this.runState = meter.createCounter(METRIC.runState, { description: 'Runs entering each state' });
        this.runDuration = meter.createHistogram(METRIC.runDuration, { description: 'Run duration by terminal state', unit: 'ms' });
        this.verdict = meter.createCounter(METRIC.verdict, { description: 'Probe verdicts by kind' });
        this.cellConnected = meter.createUpDownCounter(METRIC.cellConnected, { description: 'Cells connected to this hub replica' });
        this.securityEvent = meter.createCounter(METRIC.securityEvent, {
            description: 'Runs halted because a canary planted in the machine crossed a boundary (ADR-043); above zero pages the owner',
        });
        this.evidenceWriteFailed = meter.createCounter(METRIC.evidenceWriteFailed, {
            description: 'Run evidence (a probe round, an exploration command) the worker could not write: the Run page has nothing behind its link',
        });
    }

    recordProtocolViolation(attrs: { cellId: string; code: string }) {
        this.protocolViolation.add(1, attrs);
    }
    recordReaperTerminated(attrs: { cellId: string; orgId: string; reason: string }) {
        this.reaperTerminated.add(1, attrs);
    }
    /**
     * The host and the cell stay out of the metric: the app under test picks
     * the host, so as an attribute it would grow one series per name it
     * tries. They belong to the egress event log and the span.
     */
    recordEgressBlocked(attrs: { cellId?: string; orgId: string; host?: string; phase: string }) {
        this.egressBlocked.add(1, { orgId: attrs.orgId, phase: attrs.phase });
    }
    recordLlmBudget(fractionUsed: number, attrs: { orgId: string; state: 'ok' | 'near_limit' | 'exhausted' }) {
        this.llmBudget.record(Math.max(0, fractionUsed), attrs);
    }
    recordQueueWait(ms: number, attrs: { orgId: string }) {
        this.queueWait.record(Math.max(0, ms), attrs);
    }
    recordRunState(state: string, attrs: { orgId: string }) {
        this.runState.add(1, { ...attrs, state });
    }
    recordRunDuration(ms: number, attrs: { orgId: string; state: string }) {
        this.runDuration.record(Math.max(0, ms), attrs);
    }
    recordVerdict(verdict: string, attrs: { orgId: string }) {
        this.verdict.add(1, { ...attrs, verdict });
    }
    cellConnectedDelta(delta: 1 | -1, attrs: { owner: string }) {
        this.cellConnected.add(delta, attrs);
    }
    /** Never carries the canary value: only where it was seen. */
    recordSecurityEvent(attrs: { orgId: string; kind: 'canary' | 'exfiltration'; where: string }) {
        this.securityEvent.add(1, attrs);
    }
    recordEvidenceWriteFailed(attrs: { orgId: string; kind: 'probe' | 'exploration' | 'test' }) {
        this.evidenceWriteFailed.add(1, attrs);
    }
}
