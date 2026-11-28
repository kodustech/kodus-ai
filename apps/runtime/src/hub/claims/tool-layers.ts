import { randomUUID } from 'crypto';

import type { Blocked, Claim } from '@libs/runtime/environment';
import { computeToolLayerKey, type Envelope, type LayerBuild, type MessageBody, type ToolLayerPlan } from '@libs/runtime/protocol';

import { claimIdFor } from '../../shared/claim-id';
import { supports } from '../cell-capabilities';
import type { CellConnection, CellConnectionRegistry } from '../gateway/cell-connections';
import type { CellSession, HubStore } from '../hub-store';
import type { ClaimRef, HubLog } from '../hub-types';

// Tool layers on the hub (docs/runtime/persistent-state.md section 4, feature
// toolLayers). Two parts:
//
//   ToolLayerService  what a review's sandbox.acquire carries (the keys, only to
//                     a cell that names the feature and an image digest), what
//                     its claim.ready answers become (hit or miss per layer, the
//                     registry host opened for a miss only), and the audit row.
//   ToolLayerBuilds   the builder claims the cell asks for with `build: true`
//                     (its second miss of a key): single-flight, capped, queued
//                     behind reviews, failures remembered, results recorded.
//
// A layer can only make a review faster: whatever goes wrong here, the layer is
// a miss and the provider installs as it always did.

/** A planned CLI with the key this cell would hold it under. */
export interface KeyedLayer {
    plan: ToolLayerPlan;
    key: string;
}

/** A failed build is not tried again for this long (the cell remembers it too). */
export const BUILD_FAILURE_MEMORY_MS = 10 * 60_000;
export const MAX_BUILDERS_PER_CELL = 1;
export const MAX_BUILDERS_PER_ORG = 2;
/** A builder that reports neither result nor failure is given up on after this (the cell's own build ceiling is 10 minutes). */
export const BUILD_REPORT_CEILING_MS = 12 * 60_000;
/** A builder queues behind reviews: with no room on the cell it waits and asks again, a few times. */
export const BUILD_CAPACITY_RETRY_MS = 30_000;
export const BUILD_CAPACITY_RETRIES = 4;

type CellFacts = Pick<CellConnection, 'sandboxImageDigest' | 'arch'>;
type SandboxLayerRequest = { sandboxToolLayers?: ToolLayerPlan[]; sandboxSnapshot?: { prepares?: boolean; templateKey?: string; resumeFrom?: string }; sandboxLayerBuild?: LayerBuild };

export class ToolLayerService {
    readonly builds: ToolLayerBuilds;

    constructor(
        private readonly store: HubStore,
        private readonly egress: { sandboxEgressOf(orgId: string, asked: string[], ids: { cellId: string; claimId: string }): Promise<{ allow: string[]; inspect: Array<{ host: string; paths: string[] }> }> },
        private readonly connections: CellConnectionRegistry,
        private readonly log: HubLog,
        private readonly now: () => Date,
        acquire: ToolLayerBuilds['acquire'],
        release: ToolLayerBuilds['release'],
    ) {
        this.builds = new ToolLayerBuilds(acquire, release, log, now);
    }

    /**
     * The planned layers keyed for this cell, or undefined when the claim carries none to this cell: it plans
     * none, the cell does not name toolLayers, its hello gave no image digest or arch (U6: no digest, no layers), the
     * sandbox starts from a template or a session (those mount none), or a plan cannot be keyed.
     */
    keyed(session: Pick<CellSession, 'features'>, conn: CellFacts, req: SandboxLayerRequest): KeyedLayer[] | undefined {
        const plans = req.sandboxToolLayers;
        if (!plans?.length || req.sandboxLayerBuild) return undefined;
        const s = req.sandboxSnapshot;
        if (s?.prepares || s?.templateKey || s?.resumeFrom) return undefined;
        if (!supports(session, 'toolLayers') || !conn.sandboxImageDigest || !conn.arch) return undefined;
        try {
            return plans.map((plan) => ({
                plan,
                key: computeToolLayerKey({ installer: plan.installer, argv: plan.argv, binary: plan.binary, imageDigest: conn.sandboxImageDigest!, arch: conn.arch!, registry: plan.registry }),
            }));
        } catch (e) {
            this.log('warn', 'toollayer.key_refused', { error: (e as Error).message });
            return undefined;
        }
    }

    /**
     * claim.ready of a review that asked for layers: one answer per planned layer (a layer the cell did not
     * answer is a miss), a hit trusted only for a path under its own mount, the registry host of the held layers taken
     * out of the sandbox's egress (the acquire carried it, as an install needs it; a hit needs no network, and a host
     * that a missed layer still installs from stays), the audit row, and a builder requested for each miss the cell
     * asked one for. Never throws: the layers are an optimization, and a policy that cannot be pushed only leaves the
     * registry open until the seal, as it was.
     */
    async settle(input: { ids: { cellId: string; claimId: string; orgId: string }; layers: KeyedLayer[]; asked: string[]; states: MessageBody<'claim.ready'>['toolLayers']; build: boolean }): Promise<NonNullable<Claim['toolLayers']>> {
        const { ids, layers } = input;
        const byId = new Map((input.states ?? []).map((s) => [s.id, s] as const));
        const out: NonNullable<Claim['toolLayers']> = [];
        const misses: KeyedLayer[] = [];
        const audit: string[] = [];
        for (const l of layers) {
            const s = byId.get(l.plan.id);
            const mount = `/opt/kcli/${l.plan.id}/`;
            const hit = s?.state === 'hit' && !!s.binaryPath?.startsWith(mount) && !s.binaryPath.includes('..') && !!s.interpreter;
            if (hit) {
                out.push({ id: l.plan.id, state: 'hit', binaryPath: s!.binaryPath, interpreter: s!.interpreter });
                audit.push(`${l.plan.id}:${l.key}:hit:${s!.digest ?? ''}`);
                continue;
            }
            out.push({ id: l.plan.id, state: 'miss' });
            misses.push(l);
            audit.push(`${l.plan.id}:${l.key}:miss:${s?.reason ?? (s ? 'untrusted_hit' : 'unanswered')}`);
            if (s?.build) this.builds.request(ids.orgId, ids.cellId, { key: l.key, ...l.plan });
        }
        const needed = new Set(misses.map((m) => m.plan.registry.toLowerCase()));
        const dropped = new Set(layers.filter((l) => !misses.includes(l)).map((l) => l.plan.registry.toLowerCase()).filter((h) => !needed.has(h)));
        if (dropped.size) await this.closeRegistries(ids, input.asked.filter((h) => !dropped.has(h.toLowerCase())));
        await this.audit(ids, audit);
        return out;
    }

    /** egress.policy with the sandbox's hosts (the caller's and the org's approved ones) minus the registries no missed layer needs. */
    private async closeRegistries(ids: { cellId: string; claimId: string; orgId: string }, asked: string[]): Promise<void> {
        try {
            const egress = await this.egress.sandboxEgressOf(ids.orgId, asked, ids);
            const features = this.connections.get(ids.cellId)?.features ?? [];
            const reply = await this.connections.request(
                ids.cellId,
                'egress.policy',
                { allow: egress.allow, ...(features.includes('egressTiers') && egress.inspect.length ? { inspect: egress.inspect } : {}), issuedAt: this.now().toISOString() },
                ids.claimId,
            );
            this.log(reply.type === 'ack' ? 'info' : 'warn', 'toollayer.registries_closed', { ...ids, hosts: egress.allow.length, reply: reply.type });
        } catch (e) {
            // The registry stays open until the seal, as it was before layers; nothing a hit does uses it.
            this.log('warn', 'toollayer.registries_kept', { ...ids, error: (e as Error).message });
        }
    }

    /** One audit row per sandbox: the layer keys and what each was, never a path or content. */
    private async audit(ids: { cellId: string; claimId: string; orgId: string }, entries: string[]): Promise<void> {
        await this.store
            .recordSandboxAudit({ orgId: ids.orgId, claimId: ids.claimId, cellId: ids.cellId, stepId: randomUUID(), op: 'tool_layers', outcome: 'ok', detail: entries.join(' '), durationMs: 0, at: this.now().toISOString() })
            .catch((e: unknown) => this.log('error', 'sandbox.audit_unrecorded', { ...ids, error: (e as Error).message }));
    }
}

interface ActiveBuild {
    orgId: string;
    cellId: string;
    layer: LayerBuild;
    claimId: string;
    flight: string;
    timer?: NodeJS.Timeout;
}
interface QueuedBuild {
    orgId: string;
    cellId: string;
    layer: LayerBuild;
    flight: string;
    tries: number;
    notBefore: number;
}

/** What a builder claim takes: a sandbox claim with a layerBuild and nothing else (no secret, no snapshot). */
export interface BuilderAcquire {
    organizationId: string;
    idempotencyKey: string;
    sandboxLayerBuild: LayerBuild;
}

export class ToolLayerBuilds {
    private readonly failed = new Map<string, number>();
    private readonly flights = new Set<string>();
    private readonly queue: QueuedBuild[] = [];
    private readonly active = new Map<string, ActiveBuild>();
    private starting = 0;
    private seq = 0;
    private timer?: NodeJS.Timeout;

    constructor(
        readonly acquire: (cellId: string, req: BuilderAcquire) => Promise<Claim | Blocked>,
        readonly release: (ref: ClaimRef) => Promise<void>,
        private readonly log: HubLog,
        private readonly now: () => Date,
    ) {}

    private flightOf(orgId: string, cellId: string, key: string) {
        return `${orgId}\0${cellId}\0${key}`;
    }

    /**
     * The cell asked for a build of this layer (its second miss of the key). Single-flight per (org, cell, key),
     * not again for 10 minutes after a failure; it starts when a slot is free (one builder per cell, two per org)
     * and, like every sandbox, only when the cell has room.
     */
    request(orgId: string, cellId: string, layer: LayerBuild): 'queued' | 'duplicate' | 'recent_failure' {
        const flight = this.flightOf(orgId, cellId, layer.key);
        if (this.flights.has(flight)) return 'duplicate';
        const until = this.failed.get(flight);
        if (until !== undefined && until > this.now().getTime()) return 'recent_failure';
        this.failed.delete(flight);
        this.flights.add(flight);
        this.queue.push({ orgId, cellId, layer, flight, tries: 0, notBefore: 0 });
        this.log('info', 'toollayer.build_requested', { cellId, orgId, key: layer.key, id: layer.id });
        this.pump();
        return 'queued';
    }

    private running(match: (b: { orgId: string; cellId: string }) => boolean): number {
        return [...this.active.values()].filter(match).length;
    }

    /** Starts every queued build a slot is free for, in order. */
    private pump(): void {
        const now = this.now().getTime();
        let next: number | undefined;
        for (const q of [...this.queue]) {
            if (q.notBefore > now) {
                next = Math.min(next ?? q.notBefore, q.notBefore);
                continue;
            }
            if (this.running((b) => b.cellId === q.cellId) >= MAX_BUILDERS_PER_CELL || this.running((b) => b.orgId === q.orgId) >= MAX_BUILDERS_PER_ORG) continue;
            this.queue.splice(this.queue.indexOf(q), 1);
            void this.start(q);
        }
        if (next !== undefined && !this.timer) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                this.pump();
            }, Math.max(next - now, 0));
            this.timer.unref?.();
        }
    }

    private async start(q: QueuedBuild): Promise<void> {
        const idempotencyKey = `toollayer-build:${q.layer.key.slice(0, 16)}:${q.layer.id}:${Date.now().toString(36)}:${this.seq++}`;
        const claimId = claimIdFor(q.orgId, idempotencyKey);
        // Registered before the acquire answers: the cell reports its result after claim.ready, which may reach this
        // replica before the acquire's own promise settles.
        const entry: ActiveBuild = { orgId: q.orgId, cellId: q.cellId, layer: q.layer, claimId, flight: q.flight };
        this.active.set(claimId, entry);
        entry.timer = setTimeout(() => this.finish(claimId, 'failed', 'no_report'), BUILD_REPORT_CEILING_MS);
        entry.timer.unref?.();
        let result: Claim | Blocked;
        try {
            result = await this.acquire(q.cellId, { organizationId: q.orgId, idempotencyKey, sandboxLayerBuild: q.layer });
        } catch (e) {
            this.log('warn', 'toollayer.build_unopened', { cellId: q.cellId, claimId, error: (e as Error).message });
            return this.giveUp(entry, q, 'cell_unavailable');
        }
        if (!('status' in result)) return; // ready: the cell builds and reports toollayer.built or toollayer.failed
        const signature = result.blockers[0]?.signature ?? 'blocked';
        if (signature === 'no_capacity' && q.tries < BUILD_CAPACITY_RETRIES) {
            // Behind the reviews: they take the room, the builder asks again later.
            this.dropActive(entry);
            this.queue.push({ ...q, tries: q.tries + 1, notBefore: this.now().getTime() + BUILD_CAPACITY_RETRY_MS });
            this.log('info', 'toollayer.build_waits', { cellId: q.cellId, orgId: q.orgId, key: q.layer.key, tries: q.tries + 1 });
            return this.pump();
        }
        // No room after every try is the cell being busy, not the layer failing: nothing is remembered, and a later miss asks again.
        this.giveUp(entry, q, signature, signature !== 'no_capacity');
    }

    /** A build that did not open (or never got room): the layer stays a miss and the failure is remembered. */
    private giveUp(entry: ActiveBuild, q: QueuedBuild, why: string, remember = true): void {
        this.dropActive(entry);
        this.flights.delete(q.flight);
        if (remember) this.failed.set(q.flight, this.now().getTime() + BUILD_FAILURE_MEMORY_MS);
        this.log('warn', 'toollayer.build_refused', { cellId: q.cellId, orgId: q.orgId, key: q.layer.key, why });
        this.pump();
    }

    private dropActive(entry: ActiveBuild): void {
        if (entry.timer) clearTimeout(entry.timer);
        this.active.delete(entry.claimId);
    }

    /**
     * toollayer.built or toollayer.failed from the cell, on a builder claim this replica opened. A frame for a
     * claim that is not an active builder of this cell, or that names another layer, is refused. The result is
     * recorded, the builder claim released (the cell ended it itself, so its answer to the release is
     * unknown_claim, which is normal), and the next queued build may start.
     */
    onResult(conn: Pick<CellConnection, 'cred'>, msg: Envelope<'toollayer.built'> | Envelope<'toollayer.failed'>): 'recorded' | 'unknown' {
        const a = msg.claimId ? this.active.get(msg.claimId) : undefined;
        const body = msg.body as MessageBody<'toollayer.built'> | MessageBody<'toollayer.failed'>;
        if (!a || a.cellId !== conn.cred.cellId || a.layer.key !== body.key || a.layer.id !== body.id) return 'unknown';
        if (msg.type === 'toollayer.built') {
            const b = body as MessageBody<'toollayer.built'>;
            this.log('info', 'toollayer.built', { cellId: a.cellId, claimId: a.claimId, orgId: a.orgId, key: a.layer.key, id: a.layer.id, digest: b.digest, bytes: b.bytes, ...(b.unsigned ? { unsigned: b.unsigned } : {}) });
            this.finish(a.claimId, 'built');
        } else {
            this.finish(a.claimId, 'failed', (body as MessageBody<'toollayer.failed'>).reason);
        }
        return 'recorded';
    }

    private finish(claimId: string, outcome: 'built' | 'failed', reason?: string): void {
        const a = this.active.get(claimId);
        if (!a) return;
        this.dropActive(a);
        this.flights.delete(a.flight);
        if (outcome === 'failed') {
            this.failed.set(a.flight, this.now().getTime() + BUILD_FAILURE_MEMORY_MS);
            this.log('warn', 'toollayer.failed', { cellId: a.cellId, claimId, orgId: a.orgId, key: a.layer.key, id: a.layer.id, reason });
        }
        // Not awaited: this runs on the cell's frame chain, which must go on to read the cell's answer to the release.
        void this.release({ claimId, organizationId: a.orgId, runId: null }).catch((e: unknown) => this.log('warn', 'toollayer.release_failed', { cellId: a.cellId, claimId, error: (e as Error).message }));
        this.pump();
    }

    /** Builds this replica is running or has queued (for a test or a gauge). */
    pending(): number {
        return this.active.size + this.queue.length;
    }

    /** Forgets timers when the hub stops. */
    stop(): void {
        if (this.timer) clearTimeout(this.timer);
        for (const a of this.active.values()) if (a.timer) clearTimeout(a.timer);
    }
}
