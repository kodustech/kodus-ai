import { randomUUID } from 'crypto';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { MessageBody } from '@libs/runtime/protocol';

import { CellConnection, type CellConnectionRegistry } from '../gateway/cell-connections';
import { InMemoryHubStore } from '../hub-store';
import type { ClaimService } from './claim.service';
import { StepDispatcher } from './step-dispatcher';

// A real dispatcher and in-memory exporter; only the cell's transport is a
// fixture. No service, model, database, broker or wall-clock sleep is needed.
describe('step dispatch diagnostics', () => {
    let exporter: InMemorySpanExporter;
    let provider: BasicTracerProvider;
    beforeEach(() => {
        jest.useFakeTimers({ now: 100_000 });
        exporter = new InMemorySpanExporter();
        provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
        trace.setGlobalTracerProvider(provider);
    });
    afterEach(async () => { jest.useRealTimers(); trace.disable(); await provider.shutdown(); });

    function fixture(response: MessageBody<'step.result'> | { refused: string } | { compromised: string } | 'lost' | 'timeout', streamDelayMs = 0) {
        const claim = { cellId: 'cell-fixture', claimId: 'claim-fixture', orgId: 'org-fixture', runId: 'run-fixture', side: 'base', state: 'bound' };
        const conn = new CellConnection({ send: () => {}, close: () => {} }, { cellId: claim.cellId, owner: 'kodus' });
        conn.helloDone = true;
        const events: Array<{ type: string; data: Record<string, unknown> }> = [];
        const logs: Array<Record<string, unknown>> = [];
        let dispatcher: StepDispatcher;
        const connections = {
            get: () => conn,
            envelope: (cellId, type, body, extra) => ({ v: 1, id: randomUUID(), cellId, type, body, ...extra }),
            ack: () => {},
            send: (_conn, frame) => {
                if (response === 'timeout') return true;
                void Promise.resolve().then(async () => {
                    if (response === 'lost') {
                        const pending = conn.steps.get(frame.body.stepId)!;
                        clearTimeout(pending.timer); conn.steps.delete(frame.body.stepId);
                        pending.resolve({ type: 'lost' }); return;
                    }
                    if ('compromised' in response) {
                        const pending = conn.steps.get(frame.body.stepId)!;
                        clearTimeout(pending.timer); conn.steps.delete(frame.body.stepId);
                        pending.resolve({ type: 'compromised', signature: response.compromised }); return;
                    }
                    if ('refused' in response) {
                        dispatcher.onStepReply(conn, { v: 1, id: randomUUID(), cellId: claim.cellId, type: 'nack', re: frame.id, body: { code: response.refused, message: 'PRIVATE fixture response message' } }); return;
                    }
                    jest.setSystemTime(Date.now() + 17);
                    await dispatcher.onStepFrame(conn, { v: 1, id: randomUUID(), cellId: claim.cellId, claimId: claim.claimId, type: 'step.result', body: { ...response, stepId: frame.body.stepId, ...(response.probe ? { probe: { ...response.probe, stepId: frame.body.stepId } } : {}) } });
                });
                return true;
            },
        } as unknown as CellConnectionRegistry;
        dispatcher = new StepDispatcher(
            { findActiveClaim: async () => claim, scoped: async () => claim } as unknown as ClaimService,
            new InMemoryHubStore(), connections,
            async (_org, _run, event) => { events.push(event); if (event.type === 'step.started') jest.setSystemTime(Date.now() + streamDelayMs); },
            { recordProtocolViolation: () => {} } as any,
            { step: () => {} } as any,
            (level, msg, fields) => logs.push({ level, msg, ...fields }),
        );
        const req = { stepId: randomUUID(), command: 'fixture command', timeoutMs: 1000 };
        return {
            req, events, logs,
            exec: () => dispatcher.exec({ claimId: claim.claimId, organizationId: claim.orgId }, req),
            probe: () => dispatcher.probe({ claimId: claim.claimId, organizationId: claim.orgId }, { id: 'probe-fixture', origin: 'agent', spec: { kind: 'http', target: { service: 'app', port: 3000 }, method: 'GET', path: '/', timeoutMs: 1000 }, purpose: 'fixture', expected: '200', compare: ['status'] }, req.stepId),
            reset: () => dispatcher.reset({ claimId: claim.claimId, organizationId: claim.orgId }, 'image-fixture', req.stepId),
        };
    }

    it.each(['lost', 'timeout'] as const)('marks returned %s as an error span with closed outcome/reason and tenant IDs', async response => {
        const f = fixture(response);
        const pending = f.exec();
        if (response === 'timeout') await jest.advanceTimersByTimeAsync(11_000);
        const out = await pending;
        const reason = response === 'lost' ? 'transport_lost' : 'timeout';
        expect(out).toMatchObject({ code: reason });
        const span = exporter.getFinishedSpans().at(-1)!;
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        expect(span.attributes).toMatchObject({ 'runtime.step.outcome': reason, 'runtime.step.reason': reason, 'runtime.org.id': 'org-fixture', 'runtime.run.id': 'run-fixture' });
    });

    it.each(['step_capacity', 'step_conflict', 'not_accepting', 'PRIVATE arbitrary nack code'])('retains only a known refusal code or unknown in span, log and stream: %s', async refused => {
        const f = fixture({ refused }); const out = await f.exec();
        const code = refused.startsWith('PRIVATE') ? 'unknown' : refused;
        expect(out).toMatchObject({ code: refused === 'not_accepting' ? 'cell_unavailable' : 'transport_lost' });
        expect(exporter.getFinishedSpans().at(-1)!).toMatchObject({ status: { code: SpanStatusCode.ERROR }, attributes: { 'runtime.step.outcome': 'refused', 'runtime.step.reason': code } });
        expect(f.logs.find(l => l.msg === 'step.refused')).toMatchObject({ code });
        expect(f.events.find(e => e.type === 'step.finished')!.data).toMatchObject({ outcome: 'refused', transport: 'ok', code });
        expect(JSON.stringify({ events: f.events, logs: f.logs, spans: exporter.getFinishedSpans().map(s => ({ attributes: s.attributes, events: s.events, status: s.status })) })).not.toContain('PRIVATE');
    });

    it('marks security failure without copying its cell-provided signature into diagnostics', async () => {
        const f = fixture({ compromised: 'PRIVATE fixture signature' });
        expect(await f.exec()).toMatchObject({ code: 'security_violation', signature: 'PRIVATE fixture signature' });
        const span = exporter.getFinishedSpans().at(-1)!;
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        expect(span.attributes).toMatchObject({ 'runtime.step.outcome': 'security_violation', 'runtime.step.reason': 'security_violation' });
        expect(JSON.stringify({ events: f.events, logs: f.logs, attributes: span.attributes, spanEvents: span.events })).not.toContain('PRIVATE');
    });

    it.each(['exec', 'probe'] as const)('separates nested %s cell time from stream latency without changing the returned result', async kind => {
        const body: MessageBody<'step.result'> = { stepId: randomUUID(), executor: kind === 'exec' ? 'vm' : 'observer', imageId: 'image-fixture', vmHealth: 'ok', ...(kind === 'exec' ? { exec: { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 17 } } : { probe: { stepId: randomUUID(), executor: 'observer' as const, imageId: 'image-fixture', http: { status: 500, headers: {}, body: 'fixture application failure' }, requests: [{ method: 'GET', route: '/', status: 500 }], durationMs: 17, transport: 'ok' as const } }) };
        const f = fixture(body, 1000);
        const outcome = await f[kind]();
        expect(outcome).toMatchObject({ durationMs: 17 });
        if (kind === 'probe') expect(outcome).toMatchObject({ http: { status: 500 } });
        expect(f.logs.find(l => l.msg === 'step.result')).toMatchObject({ durationMs: 1017, cellDurationMs: 17 });
        expect(f.events.find(e => e.type === 'step.finished')!.data).toMatchObject({ durationMs: 1017, cellDurationMs: 17 });
        expect(exporter.getFinishedSpans().at(-1)!).toMatchObject({ status: { code: SpanStatusCode.OK }, attributes: { 'runtime.step.outcome': 'ok', 'runtime.cell.duration_ms': 17 } });
    });

    it('retains top-level reset timing precedence without modifying nested results', async () => {
        const f = fixture({ stepId: randomUUID(), executor: 'vm', imageId: 'image-fixture', vmHealth: 'ok', durationMs: 9, exec: { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 17 } });
        expect(await f.reset()).toEqual({ ok: true, durationMs: 9 });
        expect(f.logs.find(l => l.msg === 'step.result')).toMatchObject({ cellDurationMs: 9 });
    });

    it.each([
        { vmHealth: 'crashed' as const },
        { vmHealth: 'ok' as const, exec: { exitCode: 1, stdout: '', stderr: 'PRIVATE reset failure', truncated: false, durationMs: 9 } },
    ])('never treats an unsuccessful reset as a completed clean round: %j', async failure => {
        const f = fixture({ stepId: randomUUID(), executor: 'vm', imageId: 'image-fixture', ...failure });
        expect(await f.reset()).toMatchObject({ code: 'transport_lost' });
    });
});
