import { BROWSER_EXPLORE_LIMITS, BrowserExploreRequestSchema, BrowserExploreResultSchema, type BrowserExploreRequest, type BrowserExploreResult } from '@libs/runtime/contracts/browser-exploration';
import { createHash, randomUUID } from 'crypto';
import { SpanStatusCode } from '@opentelemetry/api';

import { BROWSER_ROUND_GRACE_MS } from '@libs/runtime/contracts/evidence';
import type { EnvError, ExecRequest, ProbeOutcome, StepResult } from '@libs/runtime/environment';
import type { Probe } from '@libs/runtime/probe';
import { type Envelope, type EvidenceRequest, evidenceRequestFor, type MessageBody } from '@libs/runtime/protocol';
import type { RunStreamEvent } from '@libs/runtime/run';
import type { RuntimeMetrics } from '@libs/runtime/telemetry';

import { inSpan } from '../../shared/tracing';
import type { CellConnection, CellConnectionRegistry } from '../gateway/cell-connections';
import type { StepRepository } from '../hub-store';
import type { ClaimRef, HubLog, HubMetrics, StepOutcome } from '../hub-types';
import type { ClaimService } from './claim.service';

// Steps on a bound claim (probe.run, exec, machine.reset), at most once: the
// stepId is indexed before the frame goes out (S-30: a reused stepId with
// another command is refused), and a step sent and not answered before the
// connection drops becomes transport 'lost', never resent.
//
// A step's evidence request (what to capture, the upload grants) reaches only
// the part a cell named in its hello (evidenceRequestFor): an older cell's
// strict decoder never sees the field, and its result says "not captured".

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

type StepKind = 'probe.run' | 'exec' | 'machine.reset' | 'browser.explore';
// Known cell admission failures only. A customer's arbitrary nack code is not
// diagnostic data and must not reach a stream, span or structured log.
const STEP_REFUSALS = new Set([
    'unknown_claim', 'claim_compromised', 'diagnostic_hold', 'not_accepting',
    'step_conflict', 'step_capacity', 'browser_explore_unavailable', 'invalid_body',
    'exploration_scope', 'invalid_envelope', 'not_implemented', 'unexpected_type',
]);

export class StepDispatcher {
    constructor(
        private readonly claims: ClaimService,
        private readonly steps: StepRepository,
        private readonly connections: CellConnectionRegistry,
        /** `key`: step:{stepId}:started|finished. A stepId is sent at most once, so each event is written once. */
        private readonly appendStepEvent: (orgId: string, runId: string | null | undefined, event: Omit<RunStreamEvent, 'at'>, key?: string) => Promise<void>,
        private readonly metrics: RuntimeMetrics,
        private readonly hubMetrics: HubMetrics,
        private readonly log: HubLog,
        /** The cell's session, for the features its hello named; absent: no cell gets an evidence request. */
        private readonly sessionOf?: (cellId: string) => Promise<{ features?: readonly string[]; sessionEpoch?: string; driver?: string; isolation?: string } | null>,
    ) {}

    /** The evidence request as this claim's cell can read it; undefined: send none. */
    private async evidenceFor(ref: ClaimRef, req: EvidenceRequest | undefined): Promise<EvidenceRequest | undefined> {
        if (!req || !this.sessionOf) return undefined;
        const claim = await this.claims.findActiveClaim(ref, { allowHeld: true });
        if (!claim) return undefined;
        const session = await this.sessionOf(claim.cellId).catch(() => null);
        return evidenceRequestFor(session?.features, req);
    }

    /** Sends one step and waits for its result, at most once. */
    private async sendStep<T extends StepKind>(ref: ClaimRef, type: T, body: MessageBody<T>, commandForHash: string, waitMs: number, expectedConnection?: CellConnection): Promise<Envelope<'step.result'> | EnvError> {
        // A held claim (diagnostic hold) takes exec only: no verdict probe, no reset.
        const claim = await this.claims.findActiveClaim(ref, { allowHeld: type === 'exec' });
        if (!claim) {
            const row = await this.claims.scoped(ref);
            if (row?.state === 'compromised') return { code: 'security_violation', claimId: row.claimId, signature: (await this.claims.violationOf(row.claimId)) ?? 'unknown' };
            return { code: 'lease_expired' };
        }
        const stepId = (body as { stepId: string }).stepId;
        const conn = this.connections.get(claim.cellId);
        if (!conn || (expectedConnection && conn !== expectedConnection)) return { code: 'cell_unavailable', cellId: claim.cellId };
        const fresh = await this.steps.insertStep({ stepId, cellId: claim.cellId, claimId: claim.claimId, orgId: claim.orgId, runId: claim.runId, commandHash: hash(commandForHash) }, type === 'browser.explore' ? { requireFresh: true } : undefined);
        if (!fresh) {
            this.metrics.recordProtocolViolation({ cellId: claim.cellId, code: 'step_reused' });
            return { code: 'transport_lost', stepId };
        }
        const probeId = type === 'probe.run' ? (body as MessageBody<'probe.run'>).probe.id : undefined;
        const ids = { organizationId: claim.orgId, cellId: claim.cellId, claimId: claim.claimId, runId: claim.runId ?? undefined, stepId, kind: type };
        return inSpan<Envelope<'step.result'> | EnvError>('runtime.hub.step', { 'runtime.org.id': claim.orgId, ...(claim.runId ? { 'runtime.run.id': claim.runId } : {}), 'runtime.cell.id': claim.cellId, 'runtime.claim.id': claim.claimId, 'runtime.step.id': stepId, 'runtime.step.kind': type }, async (span) => {
            const startedAt = Date.now();
            this.log('info', 'step.sent', ids);
            await this.appendStepEvent(claim.orgId, claim.runId, { type: 'step.started', data: { stepId, kind: type, side: claim.side, ...(probeId ? { probeId } : {}) } }, `step:${stepId}:started`);
            const result = expectedConnection && (!this.connections.isCurrent(conn) || conn.closed || !conn.helloDone)
                ? {type:'lost'} as const
                : await this.awaitResult(conn, claim.claimId, stepId, this.connections.envelope(claim.cellId, type, body, { claimId: claim.claimId }), waitMs);
            const durationMs = Date.now() - startedAt;
            span.setAttribute('runtime.hub.duration_ms', durationMs);
            if (result === 'timeout') {
                span.setAttributes({ 'runtime.step.outcome': 'timeout', 'runtime.step.reason': 'timeout' });
                this.hubMetrics.step(durationMs, { kind: type, outcome: 'timeout' });
                this.log('warn', 'step.timeout', { ...ids, durationMs });
                await this.appendStepEvent(claim.orgId, claim.runId, { type: 'step.finished', data: { stepId, outcome: 'timeout', transport: 'ok', durationMs } }, `step:${stepId}:finished`);
                return { code: 'timeout', afterMs: waitMs };
            }
            if ('type' in result && result.type === 'compromised') {
                span.setAttributes({ 'runtime.step.outcome': 'security_violation', 'runtime.step.reason': 'security_violation' });
                this.hubMetrics.step(durationMs, { kind: type, outcome: 'security_violation' });
                this.log('warn', 'step.compromised', { ...ids, durationMs });
                await this.appendStepEvent(claim.orgId, claim.runId, { type: 'step.finished', data: { stepId, outcome: 'security_violation', transport: 'ok', durationMs } }, `step:${stepId}:finished`);
                return { code: 'security_violation', claimId: claim.claimId, signature: result.signature };
            }
            if ('type' in result && result.type === 'refused') {
                // The cell refused the step; it never ran. Its reason maps onto the
                // errors the worker already handles (and the gate reads as inconclusive).
                const code = STEP_REFUSALS.has(result.code) ? result.code : 'unknown';
                span.setAttributes({ 'runtime.step.outcome': 'refused', 'runtime.step.reason': code });
                this.hubMetrics.step(durationMs, { kind: type, outcome: 'refused' });
                this.log('warn', 'step.refused', { ...ids, code, durationMs });
                await this.appendStepEvent(claim.orgId, claim.runId, { type: 'step.finished', data: { stepId, outcome: 'refused', transport: 'ok', code, durationMs } }, `step:${stepId}:finished`);
                switch (result.code) {
                    case 'claim_compromised':
                        return { code: 'security_violation', claimId: claim.claimId, signature: (await this.claims.violationOf(claim.claimId)) ?? 'unknown' };
                    case 'unknown_claim':
                        return { code: 'lease_expired' };
                    case 'not_accepting':
                        return { code: 'cell_unavailable', cellId: claim.cellId };
                    default:
                        return { code: 'transport_lost', stepId };
                }
            }
            if ('type' in result && result.type === 'lost') {
                span.setAttributes({ 'runtime.step.outcome': 'transport_lost', 'runtime.step.reason': 'transport_lost' });
                this.hubMetrics.step(durationMs, { kind: type, outcome: 'transport_lost' });
                this.log('warn', 'step.lost', { ...ids, durationMs });
                await this.appendStepEvent(claim.orgId, claim.runId, { type: 'step.finished', data: { stepId, outcome: 'transport_lost', transport: 'lost', durationMs } }, `step:${stepId}:finished`);
                return { code: 'transport_lost', stepId };
            }
            const env = result as Envelope<'step.result'>;
            const cellDurationMs = env.body.durationMs ?? env.body.probe?.durationMs ?? env.body.exec?.durationMs;
            span.setAttribute('runtime.step.outcome', 'ok');
            if (cellDurationMs !== undefined) span.setAttribute('runtime.cell.duration_ms', cellDurationMs);
            this.hubMetrics.step(durationMs, { kind: type, outcome: 'ok' });
            this.log('info', 'step.result', { ...ids, vmHealth: env.body.vmHealth, durationMs, ...(cellDurationMs !== undefined ? { cellDurationMs } : {}) });
            await this.appendStepEvent(claim.orgId, claim.runId, {
                type: 'step.finished',
                data: {
                    stepId,
                    outcome: 'ok',
                    transport: env.body.probe?.transport ?? 'ok',
                    vmHealth: env.body.vmHealth,
                    status: env.body.probe?.http?.status,
                    exitCode: env.body.exec?.exitCode,
                    // S-51: how many values the cell redacted before the result left it.
                    ...(env.body.redactions !== undefined ? { redactions: env.body.redactions } : {}),
                    durationMs,
                    // The cell reports reset time at the top level, probe/exec time in their typed result.
                    ...(cellDurationMs !== undefined ? { cellDurationMs } : {}),
                    ...(probeId ? { probeId } : {}),
                },
            }, `step:${stepId}:finished`);
            return env;
        }, { statusOf: (result) => 'code' in result ? SpanStatusCode.ERROR : SpanStatusCode.OK });
    }

    private awaitResult(conn: CellConnection, claimId: string, stepId: string, frame: Envelope, waitMs: number): Promise<StepOutcome | 'timeout'> {
        return new Promise<StepOutcome | 'timeout'>((resolve) => {
            const timer = setTimeout(() => {
                conn.steps.delete(stepId);
                conn.stepFrames.delete(frame.id);
                resolve('timeout');
            }, waitMs);
            conn.steps.set(stepId, { claimId, resolve, timer });
            conn.stepFrames.set(frame.id, stepId);
            if (!this.connections.send(conn, frame)) {
                clearTimeout(timer);
                conn.steps.delete(stepId);
                conn.stepFrames.delete(frame.id);
                resolve({ type: 'lost' });
            }
        });
    }

    /**
     * The cell's ack or nack of a step frame this connection sent. An ack says
     * the step was admitted (its result follows); a nack says it was refused
     * and will never run, so the step ends now with the cell's reason. False
     * when re is not a step frame (the caller answers other requests).
     */
    onStepReply(conn: CellConnection, msg: Envelope<'ack'> | Envelope<'nack'>): boolean {
        const stepId = msg.re ? conn.stepFrames.get(msg.re) : undefined;
        if (!stepId) return false;
        conn.stepFrames.delete(msg.re!);
        if (msg.type === 'ack') return true;
        const pending = conn.steps.get(stepId);
        if (pending) {
            conn.steps.delete(stepId);
            clearTimeout(pending.timer);
            pending.resolve({ type: 'refused', code: (msg.body as MessageBody<'nack'>).code });
        }
        return true;
    }

    /**
     * A step.result or step.stream frame. Checked against the step this
     * connection sent (in memory: no database read per frame); step.stream
     * carries no result and is dropped once checked.
     */
    async onStepFrame(conn: CellConnection, msg: Envelope<'step.result'> | Envelope<'step.stream'>): Promise<void> {
        const stepId = (msg.body as { stepId: string }).stepId;
        const pending = conn.steps.get(stepId);
        // Only a step this hub sent on this connection, for the claim it was sent on, is accepted.
        if (!pending || (msg.claimId && msg.claimId !== pending.claimId)) {
            return this.connections.nack(conn, msg.id, 'unknown_step', 'step was not sent to this cell on this connection');
        }
        if (msg.type === 'step.stream') return;
        conn.steps.delete(stepId);
        for (const [frameId, id] of conn.stepFrames) if (id === stepId) conn.stepFrames.delete(frameId);
        clearTimeout(pending.timer);
        await this.steps.finishStep(stepId);
        this.connections.ack(conn, msg.id);
        pending.resolve(msg as Envelope<'step.result'>);
    }

    async probe(ref: ClaimRef, probe: Probe, stepId: string = randomUUID(), evidence?: EvidenceRequest): Promise<ProbeOutcome | EnvError> {
        // The grants are not part of what the step runs: a retried step with fresh grants is the same step (S-30).
        const ev = await this.evidenceFor(ref, evidence);
        // A browser round also starts a container and uploads its artifacts (ADR-071).
        const grace = probe.spec.kind === 'browser' && ev?.capture.includes('browser') ? BROWSER_ROUND_GRACE_MS : 0;
        const r = await this.sendStep(ref, 'probe.run', { stepId, probe, ...(ev ? { evidence: ev } : {}) }, JSON.stringify(probe), probe.spec.timeoutMs + 10_000 + grace);
        if ('code' in r) return r;
        // OOM or a crash on the machine reaches the gate as vmHealth, not as a lost transport.
        const vmHealth = r.body.vmHealth;
        if (!r.body.probe) return vmHealth === 'ok' ? { code: 'transport_lost', stepId } : { code: 'vm_unhealthy', stepId, vmHealth };
        return { ...r.body.probe, vmHealth };
    }

    /** Exploration is base-only, separately negotiated, and never a replay probe. */
    async exploreBrowser(ref: ClaimRef, request: BrowserExploreRequest, stepId: string): Promise<BrowserExploreResult | EnvError> {
        const unavailable = (): BrowserExploreResult => ({ status: 'unavailable', snapshot: '', candidates: [], actionsCompleted: 0, durationMs: 0, cliCalls: 0, truncated: false });
        const claim = await this.claims.findActiveClaim(ref);
        if (!claim) return { code: 'lease_expired' };
        const parsed = BrowserExploreRequestSchema.safeParse(request);
        if (claim.side !== 'base' || !parsed.success) return unavailable();
        const connection = this.connections.get(claim.cellId);
        if (!connection) return { code: 'cell_unavailable', cellId: claim.cellId };
        const session = await this.sessionOf?.(claim.cellId).catch(() => null);
        if (!this.connections.isCurrent(connection) || !connection.helloDone || connection.closed) return { code: 'cell_unavailable', cellId: claim.cellId };
        if (session?.sessionEpoch !== connection.sessionEpoch || !session.features?.includes('browserExplore')) return unavailable();
        const result = await this.sendStep(ref, 'browser.explore', { stepId, request: parsed.data }, JSON.stringify({ kind: 'browser.explore', request: parsed.data }), parsed.data.timeoutMs + BROWSER_EXPLORE_LIMITS.runnerGraceMs + 10_000, connection);
        if ('code' in result) return result;
        if (result.body.executor !== 'observer' || result.body.exec || result.body.probe) return unavailable();
        const body = BrowserExploreResultSchema.safeParse(result.body.browserExploration);
        return body.success ? body.data : unavailable();
    }

    async exec(ref: ClaimRef, req: ExecRequest): Promise<StepResult | EnvError> {
        let expectedConnection: CellConnection | undefined;
        if (req.executionScope !== undefined) {
            if (req.executionScope !== 'workload') return { code: 'workload_exec_unavailable' };
            const claim = await this.claims.findActiveClaim(ref);
            if (!claim) return { code: 'lease_expired' };
            const connection = this.connections.get(claim.cellId);
            if (!connection) return { code: 'cell_unavailable', cellId: claim.cellId };
            const session = await this.sessionOf?.(claim.cellId).catch(() => null);
            if (
                !this.connections.isCurrent(connection) ||
                connection.closed ||
                !connection.helloDone ||
                (session && session.sessionEpoch !== connection.sessionEpoch)
            )
                return { code: 'cell_unavailable', cellId: claim.cellId };
            // local-docker exec runs on the cell host: it can never satisfy this scope.
            if (session?.driver !== 'docker-gvisor' || session.isolation !== 'sandboxed-container')
                return { code: 'workload_exec_unavailable' };
            expectedConnection = connection;
        }
        const ev = await this.evidenceFor(ref, req.evidence);
        const r = await this.sendStep(
            ref,
            'exec',
            { stepId: req.stepId, command: req.command, cwd: req.cwd, timeoutMs: req.timeoutMs, ...(ev ? { evidence: ev } : {}) },
            req.command,
            req.timeoutMs + 10_000,
            expectedConnection,
        );
        if ('code' in r) return r;
        const e = r.body.exec;
        if (!e) return { code: 'transport_lost', stepId: req.stepId };
        return {
            stepId: req.stepId,
            exitCode: e.exitCode,
            stdout: e.stdout,
            stderr: e.stderr,
            truncated: e.truncated,
            durationMs: e.durationMs,
            transport: 'ok',
            ...(r.body.redactions !== undefined ? { redactions: r.body.redactions } : {}),
            ...(e.refs?.length ? { refs: e.refs } : {}),
        };
    }

    /** machine.reset; durationMs is how long the cell says the reset took (down, up, migrate, seed, ready). */

    async reset(ref: ClaimRef, imageId: string, stepId: string = randomUUID()): Promise<{ ok: true; durationMs?: number } | EnvError> {
        const r = await this.sendStep(ref, 'machine.reset', { stepId, snapshot: { kind: 'compose_volumes', ref: `${imageId}:seed` } }, `reset:${imageId}`, 120_000);
        if ('code' in r) return r;
        // A failed reset supplies no clean starting state. It is infrastructure
        // uncertainty, never proof that this PR destabilized its workload.
        if (r.body.executor !== 'vm' || r.body.imageId !== imageId || r.body.vmHealth !== 'ok' || (r.body.exec && r.body.exec.exitCode !== 0)) {
            return { code: 'transport_lost', stepId };
        }
        return { ok: true, ...(r.body.durationMs !== undefined ? { durationMs: r.body.durationMs } : {}) };
    }
}
