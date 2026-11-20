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

import { CatalogMeter } from './instruments';
import { ATTR, blockerSignatureClass, EXPORT_STEPS } from './catalog';

// §11: every Run has a trace. When the product sent a W3C traceparent with the
// request (the webhook's or the API call's trace), the Run's spans are its
// children; otherwise the trace is derived from the product's correlationId,
// deterministically, so worker, hub and cell land in the same trace without
// sharing state.

/** The metric names (taxonomy.json `metrics`) the control plane records. */
export const METRIC = {
    protocolViolation: 'runtime.hub.protocol_violation',
    hardExpired: 'runtime.claim.hard_expired',
    egressDenied: 'runtime.egress.denied',
    llmBudgetUsed: 'runtime.llm.budget_used',
    llmTokens: 'runtime.llm.tokens',
    runQueueWait: 'runtime.run.queue_wait',
    runState: 'runtime.run.state',
    runDuration: 'runtime.run.duration',
    runVerdict: 'runtime.run.verdict',
    probeVerdict: 'runtime.probe.verdict',
    setupOutcome: 'runtime.setup.outcome',
    blocker: 'runtime.blocker',
    cellConnected: 'runtime.cell.connected',
    securityEvent: 'runtime.security.event',
    evidenceWriteFailed: 'runtime.evidence.write_failed',
    stuckItems: 'runtime.stuck.items',
    stuckDetected: 'runtime.stuck.detected',
    claimsOpen: 'runtime.claims.open',
    admissionQueueDepth: 'runtime.admission.queue_depth',
    admissionOldestWait: 'runtime.admission.oldest_wait',
    maintenancePass: 'runtime.maintenance.pass',
} as const;

import { TRACEPARENT } from '@libs/runtime/contracts/trace-context';
export { TRACEPARENT };

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

/** The traceparent a product request starts with when no span is active: its correlationId's trace. */
export const traceparentFor = (correlationId: string): string => `00-${traceIdFromCorrelationId(correlationId)}-${rootSpanId(correlationId)}-01`;

/** The remote parent a valid traceparent names, or undefined. */
export function contextFromTraceparent(traceparent: string | undefined, parent: Context = context.active()): Context | undefined {
    if (!traceparent || !TRACEPARENT.test(traceparent)) return undefined;
    const [, traceId, spanId, flags] = traceparent.split('-');
    return trace.setSpanContext(parent, { traceId, spanId, traceFlags: flags === '01' ? TraceFlags.SAMPLED : TraceFlags.NONE, isRemote: true });
}

/** The traceparent of the active span (or of `ctx`), or undefined when none is valid. */
export function activeTraceparent(ctx: Context = context.active()): string | undefined {
    const sc = trace.getSpanContext(ctx);
    if (!sc || !trace.isSpanContextValid(sc)) return undefined;
    const tp = `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags & TraceFlags.SAMPLED ? '01' : '00'}`;
    return TRACEPARENT.test(tp) ? tp : undefined;
}

/**
 * A context whose remote parent is the Run's root: the product's traceparent
 * when the request carried one, else the span derived from the correlationId.
 * An active span already in that trace is kept as the parent.
 */
export function runContext(correlationId: string, parent: Context = context.active(), traceparent?: string): Context {
    const fromProduct = contextFromTraceparent(traceparent, parent);
    const traceId = fromProduct ? trace.getSpanContext(fromProduct)!.traceId : traceIdFromCorrelationId(correlationId);
    const active = trace.getSpanContext(parent);
    if (active && active.traceId === traceId) return parent;
    if (fromProduct) return fromProduct;
    return trace.setSpanContext(parent, {
        traceId,
        spanId: rootSpanId(correlationId),
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
    });
}

export const correlationAttributes = (correlationId: string, extra: Attributes = {}): Attributes => ({
    [ATTR.correlationId]: correlationId,
    ...extra,
});

export async function withRunSpan<T>(
    name: string,
    correlationId: string,
    attributes: Attributes,
    fn: (span: Span) => Promise<T>,
    traceparent?: string,
): Promise<T> {
    const tracer = trace.getTracer('kody-runtime');
    return tracer.startActiveSpan(name, { attributes: correlationAttributes(correlationId, attributes) }, runContext(correlationId, context.active(), traceparent), async (span) => {
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

/**
 * W3C traceparent plus x-correlation-id, for worker → hub calls: the active
 * span's (a Run's spans, whichever trace the Run is in), else the Run's root.
 */
export function traceHeaders(correlationId: string, traceparent?: string): Record<string, string> {
    const carrier: Record<string, string> = { 'x-correlation-id': correlationId };
    const active = trace.getSpanContext(context.active());
    const ctx = active && trace.isSpanContextValid(active) ? context.active() : runContext(correlationId, context.active(), traceparent);
    propagation.inject(ctx, carrier);
    if (!carrier.traceparent) carrier.traceparent = activeTraceparent(ctx) ?? traceparentFor(correlationId);
    return carrier;
}

type Org = { orgId: string };

/** The §11 metrics of the control plane (runtime-worker and hub), named and labelled by the taxonomy. */
export class RuntimeMetrics {
    private readonly protocolViolation;
    private readonly hardExpired;
    private readonly egressDenied;
    private readonly llmBudget;
    private readonly llmTokens;
    private readonly queueWait;
    private readonly runState;
    private readonly runDuration;
    private readonly runVerdict;
    private readonly probeVerdict;
    private readonly setupOutcome;
    private readonly blocker;
    private readonly cellConnected;
    private readonly securityEvent;
    private readonly evidenceWriteFailed;
    private readonly stuckDetected;
    private readonly maintenancePass;
    private readonly meter: CatalogMeter;

    constructor(meter: Meter = metrics.getMeter('kody-runtime')) {
        const m = (this.meter = new CatalogMeter(meter));
        this.protocolViolation = m.counter(METRIC.protocolViolation);
        this.hardExpired = m.counter(METRIC.hardExpired);
        this.egressDenied = m.counter(METRIC.egressDenied);
        this.llmBudget = m.histogram(METRIC.llmBudgetUsed);
        this.llmTokens = m.counter(METRIC.llmTokens);
        this.queueWait = m.histogram(METRIC.runQueueWait);
        this.runState = m.counter(METRIC.runState);
        this.runDuration = m.histogram(METRIC.runDuration);
        this.runVerdict = m.counter(METRIC.runVerdict);
        this.probeVerdict = m.counter(METRIC.probeVerdict);
        this.setupOutcome = m.counter(METRIC.setupOutcome);
        this.blocker = m.counter(METRIC.blocker);
        this.cellConnected = m.updown(METRIC.cellConnected);
        this.securityEvent = m.counter(METRIC.securityEvent);
        this.evidenceWriteFailed = m.counter(METRIC.evidenceWriteFailed);
        this.stuckDetected = m.counter(METRIC.stuckDetected);
        this.maintenancePass = m.counter(METRIC.maintenancePass);
    }

    /** The cell stays out of the label: its id is on the hub's log line. */
    recordProtocolViolation(attrs: { cellId?: string; code: string }) {
        this.protocolViolation.add(1, { code: attrs.code });
    }
    recordReaperTerminated(attrs: { cellId?: string; orgId?: string; reason: string }) {
        this.hardExpired.add(1, { reason: attrs.reason });
    }
    /**
     * The host and the cell stay out of the metric: the app under test picks
     * the host, so as a label it would grow one series per name it tries.
     * They belong to the egress event log and the span.
     */
    recordEgressBlocked(attrs: { cellId?: string; orgId: string; host?: string; phase: string }) {
        this.egressDenied.add(1, { [ATTR.organizationId]: attrs.orgId, [ATTR.egressPhase]: attrs.phase });
    }
    recordLlmBudget(fractionUsed: number, attrs: { orgId?: string; state: 'ok' | 'near_limit' | 'exhausted' }) {
        this.llmBudget.record(fractionUsed, { outcome: attrs.state });
    }
    /** Tokens of one gateway answer, by the task the worker asked for. */
    recordLlmTokens(usage: { inputTokens: number; outputTokens: number }, attrs: Org & { task: string }) {
        const task = llmTaskOf(attrs.task);
        if (usage.inputTokens > 0) this.llmTokens.add(usage.inputTokens, { [ATTR.llmTask]: task, [ATTR.tokenType]: 'input', [ATTR.organizationId]: attrs.orgId });
        if (usage.outputTokens > 0) this.llmTokens.add(usage.outputTokens, { [ATTR.llmTask]: task, [ATTR.tokenType]: 'output', [ATTR.organizationId]: attrs.orgId });
    }
    recordQueueWait(ms: number, attrs: { orgId?: string; trigger?: string }) {
        this.queueWait.record(ms, { [ATTR.runTrigger]: attrs.trigger });
    }
    recordRunState(state: string, attrs: Org & { trigger?: string }) {
        this.runState.add(1, { [ATTR.runState]: state, [ATTR.runTrigger]: attrs.trigger, [ATTR.organizationId]: attrs.orgId });
    }
    recordRunDuration(ms: number, attrs: { orgId?: string; state: string; trigger?: string }) {
        this.runDuration.record(ms, { [ATTR.runState]: attrs.state, [ATTR.runTrigger]: attrs.trigger });
    }
    /** A Run that reached its computed verdict (no_regressions, regression, partly_tested, could_not_boot). */
    recordRunVerdict(verdict: string, attrs: Org & { trigger?: string }) {
        this.runVerdict.add(1, { [ATTR.verdict]: verdict, [ATTR.runTrigger]: attrs.trigger, [ATTR.organizationId]: attrs.orgId });
    }
    /** What the gate decided for one probe. */
    recordVerdict(verdict: string, _attrs?: { orgId?: string }) {
        this.probeVerdict.add(1, { [ATTR.probeVerdict]: verdict });
    }
    recordSetupOutcome(outcome: 'active' | 'blocked', attrs: Org & { recipeOrigin?: string }) {
        this.setupOutcome.add(1, { [ATTR.setupOutcome]: outcome, [ATTR.recipeOrigin]: attrs.recipeOrigin ?? 'none', [ATTR.organizationId]: attrs.orgId });
    }
    /** A blocker recorded on a setup or a Run: its kind and its signature class, never the signature's repository text. */
    recordBlocker(blocker: { kind: string; signature: string }, attrs: Org & { consumer: string }) {
        this.blocker.add(1, {
            [ATTR.blockerKind]: blocker.kind,
            [ATTR.blockerSignature]: blockerSignatureClass(blocker.signature),
            [ATTR.claimConsumer]: attrs.consumer,
            [ATTR.organizationId]: attrs.orgId,
        });
    }
    cellConnectedDelta(delta: 1 | -1, attrs: { owner: string }) {
        this.cellConnected.add(delta, { [ATTR.cellOwner]: attrs.owner });
    }
    /** Never carries the canary value: only where it was seen. */
    recordSecurityEvent(attrs: Org & { kind: 'canary' | 'exfiltration'; where: string }) {
        this.securityEvent.add(1, { kind: attrs.kind, where: attrs.where, [ATTR.organizationId]: attrs.orgId });
    }
    recordEvidenceWriteFailed(attrs: { orgId?: string; kind: 'probe' | 'exploration' | 'test' }) {
        this.evidenceWriteFailed.add(1, { kind: attrs.kind });
    }
    recordStuckDetected(subject: string) {
        this.stuckDetected.add(1, { [ATTR.stuckSubject]: subject });
    }
    recordMaintenancePass(outcome: 'ran' | 'skipped' | 'failed') {
        this.maintenancePass.add(1, { outcome });
    }
    /** A gauge of the catalog read at collection time (the hang detector's last pass). */
    gauge(name: string, read: () => Array<{ value: number; labels: Record<string, unknown> }>) {
        this.meter.gauge(name, read);
    }
}

/** The kodus.llm.task of a gateway task (runtime.plan → run_agent, as the usage report names it). */
export function llmTaskOf(task: string): string {
    if (task === 'runtime.plan') return 'run_agent';
    if (task === 'runtime.intent' || task === 'runtime.intent_author') return 'intent';
    if (task === 'runtime.setup_learn') return 'setup_learn';
    if (task === 'runtime.recipe_author') return 'recipe_author';
    return 'other';
}

/** The export parts of claim.ready timing.phases, by their label value, summed (a phase the cell did not report is absent). */
export function exportStepsOf(phases: ReadonlyArray<{ name: string; ms: number; running?: true }> | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of phases ?? []) {
        const step = EXPORT_STEPS[p.name];
        if (step && !p.running && Number.isFinite(p.ms)) out[step] = (out[step] ?? 0) + p.ms;
    }
    return out;
}
