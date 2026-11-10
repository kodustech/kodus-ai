import { randomUUID } from 'crypto';

import { AcquireRequest, FakeEnvironment, FakeEnvironmentRuntime, isBlocked, isEnvError } from '@libs/runtime/environment';
import { CELL_FEATURES, decodeFrame, Envelope, MACHINE_SIZE_LIMITS, MessageBody, MessageType, PROTOCOL_VERSION } from '@libs/runtime/protocol';

// A cell that speaks the real protocol over WebSocket and runs the in-memory
// driver behind it. It stands in for apps/runtime-cell (Go, PR 1b) in the
// local stack and in the end-to-end Run. It deduplicates steps by stepId and
// command hash, like the real cell must (ADR-051).

export interface FakeCellOptions {
    cellId: string;
    owner: 'kodus' | 'customer';
    scenarios: Record<string, FakeEnvironment>;
    send: (frame: string) => void;
    /** Hosts the fake proxy reports as blocked during the test phase. */
    blockedHosts?: string[];
    log?: (msg: string) => void;
}

export class FakeCell {
    private readonly env: FakeEnvironmentRuntime;
    private readonly claims = new Map<string, string>(); // hub claimId -> fake claimId
    private readonly seen = new Map<string, string>(); // stepId -> command
    readonly received: string[] = [];

    constructor(private readonly o: FakeCellOptions) {
        this.env = new FakeEnvironmentRuntime(o.scenarios, () => new Date());
    }

    private out<T extends MessageType>(type: T, body: MessageBody<T>, extra: { re?: string; claimId?: string } = {}) {
        const e = { v: PROTOCOL_VERSION, id: randomUUID(), cellId: this.o.cellId, type, body, ...extra };
        this.o.send(JSON.stringify(e));
    }

    hello() {
        // It decodes with this build's schema, so it reads every optional field, and grants any size.
        this.out('hello', {
            versions: [PROTOCOL_VERSION],
            driver: 'fake',
            isolation: 'vm',
            regions: ['local'],
            owner: this.o.owner,
            features: [...CELL_FEATURES],
            maxClaimSize: { memoryMb: MACHINE_SIZE_LIMITS.memoryMb.max, cpus: MACHINE_SIZE_LIMITS.cpus.max },
        });
    }

    heartbeat() {
        this.out('heartbeat', { claims: [...this.claims.keys()].map((claimId) => ({ claimId, machines: 1 })), freeSlots: 4 });
    }

    async onFrame(raw: string | Buffer) {
        const d = decodeFrame(raw);
        if ('code' in d) {
            this.o.log?.(`refused frame from hub: ${d.code}`);
            return;
        }
        const msg = d.message;
        this.received.push(msg.type);
        switch (msg.type) {
            case 'ack':
            case 'nack':
                if (msg.type === 'nack') this.o.log?.(`hub nack: ${JSON.stringify(msg.body)}`);
                return;
            case 'claim.acquire':
                return this.acquire(msg as Envelope<'claim.acquire'>);
            case 'claim.release': {
                const fake = this.claims.get(msg.claimId!);
                if (fake) await this.env.release(fake);
                this.claims.delete(msg.claimId!);
                return this.out('ack', {}, { re: msg.id });
            }
            case 'claim.renew':
                // Like the real cell: acked only for a claim it holds.
                if (!this.claims.has(msg.claimId!)) return this.out('nack', { code: 'unknown_claim', message: String(msg.claimId) }, { re: msg.id });
                return this.out('ack', {}, { re: msg.id, claimId: msg.claimId });
            case 'probe.run':
            case 'exec':
            case 'machine.reset':
                return this.step(msg as Envelope<'probe.run' | 'exec' | 'machine.reset'>);
            default:
                return this.out('nack', { code: 'unsupported', message: msg.type }, { re: msg.id });
        }
    }

    private async acquire(msg: Envelope<'claim.acquire'>) {
        const b = msg.body;
        const req: AcquireRequest = {
            organizationId: b.orgId,
            environmentId: b.environmentId,
            imageId: b.imageId,
            ref: { side: b.side, sha: b.sha },
            consumer: b.consumer,
            idempotencyKey: msg.claimId!,
        };
        const r = await this.env.acquire(req);
        // ack = accepted; claim.ready / claim.failed say how it ended (ADR-051).
        this.out('ack', {}, { re: msg.id, claimId: msg.claimId });
        if (isBlocked(r)) {
            const first = r.blockers[0];
            return this.out('claim.failed', { kind: first.kind as any, signature: first.signature, reason: first.message }, { claimId: msg.claimId });
        }
        this.claims.set(msg.claimId!, r.claimId);
        this.out('claim.ready', { manifest: { ...r.manifest, expose: b.expose }, observer: r.observer }, { claimId: msg.claimId });
        if (b.side === 'pr') {
            for (const host of this.o.blockedHosts ?? []) {
                this.out('egress.blocked', { host, port: 443, phase: 'test', at: new Date().toISOString() }, { claimId: msg.claimId });
            }
        }
    }

    private async step(msg: Envelope<'probe.run' | 'exec' | 'machine.reset'>) {
        const body = msg.body as { stepId: string };
        const command = JSON.stringify(msg.body);
        const prev = this.seen.get(body.stepId);
        if (prev !== undefined) {
            // At most once: a repeated step is never executed again.
            return this.out('nack', { code: prev === command ? 'duplicate_step' : 'step_reused', message: body.stepId }, { re: msg.id });
        }
        this.seen.set(body.stepId, command);
        const fake = this.claims.get(msg.claimId!);
        if (!fake) return this.out('nack', { code: 'unknown_claim', message: String(msg.claimId) }, { re: msg.id });
        const imageId = (this.o.scenarios[Object.keys(this.o.scenarios)[0]] ?? { imageId: 'img' }).imageId;
        const base = { stepId: body.stepId, executor: 'vm' as const, imageId, vmHealth: 'ok' as const };

        if (msg.type === 'probe.run') {
            const b = msg.body as MessageBody<'probe.run'>;
            const r = await this.env.probe(fake, b.probe, b.stepId);
            if (isEnvError(r)) return this.out('nack', { code: r.code, message: 'probe failed' }, { re: msg.id });
            // vmHealth travels on step.result, not inside the observer's probe result.
            const { vmHealth, ...probe } = r;
            return this.out('step.result', { ...base, executor: 'observer', imageId: probe.imageId, vmHealth, probe }, { re: msg.id, claimId: msg.claimId });
        }
        if (msg.type === 'machine.reset') {
            await this.env.reset(fake);
            return this.out('step.result', { ...base, exec: { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1 } }, { re: msg.id, claimId: msg.claimId });
        }
        const b = msg.body as MessageBody<'exec'>;
        const r = await this.env.exec(fake, { stepId: b.stepId, command: b.command, timeoutMs: b.timeoutMs });
        if (isEnvError(r)) return this.out('nack', { code: r.code, message: 'exec failed' }, { re: msg.id });
        return this.out(
            'step.result',
            { ...base, exec: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated, durationMs: r.durationMs } },
            { re: msg.id, claimId: msg.claimId },
        );
    }
}
