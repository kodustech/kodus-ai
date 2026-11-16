import { type SandboxOpen, type SandboxOpRequest, type SandboxRef, type SandboxSnapshotRequest, type SandboxSnapshotView, type SandboxTemplate, type SandboxView, sandboxIdempotencyKey } from '@libs/runtime/contracts/sandbox';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Blocked, Claim, EnvError, LeaseRenewal } from '@libs/runtime/environment';
import type { SandboxResult } from '@libs/runtime/protocol';
import { safeFailure } from '@libs/runtime/telemetry/failure';

import { claimIdFor } from '../../shared/claim-id';
import { type CellLocation, type CellRefusal, isCellRefusal } from '../../shared/persistence/cell-directory';
import { type SnapshotPlacements, sessionRef, templateRef } from '../../shared/persistence/snapshot-placements';
import { capacityBlocked } from '../env/hub-environment-runtime';

// The worker side of a code sandbox (docs/runtime/sandbox.md): one hub claim
// of consumer sandbox per sandbox, found again from its org and sandboxId
// alone (no row of its own), so any replica serves any call. The hub records
// and audits every op; this service only routes and refuses.

export const SANDBOX_SERVICE = Symbol('SANDBOX_SERVICE');

const logger = new Logger('SandboxService');

export class SandboxError extends Error {
    constructor(
        readonly status: 404 | 409 | 503,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

/** The part of HubClient a sandbox needs. */
export interface SandboxHub {
    post<T>(baseUrl: string, path: string, body: unknown, correlationId?: string, timeoutMs?: number): Promise<T>;
    replicaForClaim(claimId: string): Promise<string | null>;
    reserveCell(orgId: string, want?: { claimId?: string; size?: SandboxOpen['size']; prefer?: string }): Promise<CellLocation | CellRefusal | null>;
    readonly hubBaseUrl: string;
}

export interface SandboxDeps {
    hub: SandboxHub;
    isStopped: (organizationId: string) => Promise<boolean>;
    /**
     * The cell of each template and session: a sandbox that starts from one is reserved there first,
     * since no other cell holds it. Absent: any cell (a sandbox on another one boots cold).
     */
    placements?: SnapshotPlacements;
}

const ACQUIRE_TIMEOUT_MS = 4 * 60_000;
// A template's memory file is the machine's memory, written and read back for its digest.
const SNAPSHOT_TIMEOUT_MS = 10 * 60_000;
const SHORT_MS = 30_000;

export class SandboxService {
    constructor(private readonly deps: SandboxDeps) {}

    private claimId(ref: SandboxRef) {
        return claimIdFor(ref.organizationId, sandboxIdempotencyKey(ref.sandboxId));
    }

    private async onClaim<T>(ref: SandboxRef, path: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
        const claimId = this.claimId(ref);
        const url = await this.deps.hub.replicaForClaim(claimId);
        if (!url) throw new SandboxError(404, 'not_found', 'no such sandbox');
        return this.deps.hub.post<T>(url, `/internal/claims/${encodeURIComponent(claimId)}${path}`, { organizationId: ref.organizationId, runId: null, ...body }, `sandbox:${ref.sandboxId}`, timeoutMs);
    }

    async open(req: SandboxOpen): Promise<SandboxView> {
        return this.openWith(req);
    }

    private async openWith(req: SandboxOpen & { prepares?: boolean }): Promise<SandboxView> {
        if (await this.deps.isStopped(req.organizationId)) {
            throw new SandboxError(409, 'runtime_stopped', 'The Runtime is stopped for this organization; no sandbox opens until an admin clears the stop.');
        }
        const claimId = this.claimId(req);
        const prefer = await this.cellOfSnapshot(req);
        const cell = await this.deps.hub.reserveCell(req.organizationId, { claimId, ...(req.size ? { size: req.size } : {}), ...(prefer ? { prefer } : {}) });
        if (!cell) throw new SandboxError(503, 'no_cell', 'No cell is connected for this organization.');
        if (isCellRefusal(cell)) return blockedView(req.sandboxId, capacityBlocked(cell));
        const out = await this.deps.hub.post<Claim | Blocked>(
            cell.replicaUrl,
            `/internal/cells/${encodeURIComponent(cell.cellId)}/sandbox`,
            {
                organizationId: req.organizationId,
                idempotencyKey: sandboxIdempotencyKey(req.sandboxId),
                ...(req.egressAllow?.length ? { egressAllow: req.egressAllow } : {}),
                ...(req.size ? { size: req.size } : {}),
                ...(req.secrets ? { secrets: true } : {}),
                ...(req.prepares ? { prepares: true } : {}),
                ...(req.templateKey ? { templateKey: req.templateKey } : {}),
                ...(req.resumeFrom ? { resumeFrom: req.resumeFrom } : {}),
            },
            `sandbox:${req.sandboxId}`,
            ACQUIRE_TIMEOUT_MS,
        );
        if ('status' in out) return blockedView(req.sandboxId, out);
        return { sandboxId: req.sandboxId, state: 'ready', cellId: out.cellId, leaseExpiresAt: out.leaseExpiresAt, hardExpiresAt: out.hardExpiresAt };
    }

    async op(req: SandboxOpRequest): Promise<SandboxResult> {
        const wait = (req.op.timeoutMs ?? 60_000) + 60_000;
        const r = await this.onClaim<SandboxResult | EnvError>(req, '/sandbox-op', { stepId: req.stepId, op: req.op }, wait);
        if ('code' in r) throw new SandboxError(r.code === 'lease_expired' ? 404 : 409, r.code, sandboxErrorMessage(r));
        return r;
    }

    /** claim.snapshot of the sandbox's machine: a session (it ends; resumeFrom brings it back once) or a round. */
    async snapshot(req: SandboxSnapshotRequest): Promise<SandboxSnapshotView> {
        if (req.purpose === 'template') throw new SandboxError(409, 'not_template_source', 'A template is made through the template route, from a sandbox made for it.');
        return this.snapshotOf(req);
    }

    private async snapshotOf(req: SandboxSnapshotRequest, templateKey?: string): Promise<SandboxSnapshotView> {
        const r = await this.onClaim<{ id: string; purpose: SandboxSnapshotView['purpose']; ms: number; cellId?: string } | EnvError>(req, '/snapshot', { stepId: req.stepId, purpose: req.purpose }, SNAPSHOT_TIMEOUT_MS);
        if ('code' in r) throw new SandboxError(r.code === 'lease_expired' ? 404 : 409, r.code, sandboxErrorMessage(r));
        // Where it lives, for the sandbox that starts from it; a lost record only costs that sandbox a cold boot.
        const ref = r.purpose === 'template' && templateKey ? templateRef(templateKey) : r.purpose === 'session' ? sessionRef(r.id) : undefined;
        if (ref && r.cellId && this.deps.placements) {
            // A session of a PR's sandbox names the PR: it goes when the PR closes (pr-sessions.ts).
            const pr = r.purpose === 'session' ? req.pullRequest : undefined;
            // Lost, the next sandbox boots cold and a PR session waits for its SessionTTL instead of the PR's close: told, never failed.
            await this.deps.placements
                .record(req.organizationId, ref, r.cellId, pr)
                .catch((e) => logger.warn({ msg: 'sandbox.placement_record_failed', organizationId: req.organizationId, sandboxId: req.sandboxId, purpose: r.purpose, error: safeFailure(e) }));
        }
        return { snapshotId: r.id, purpose: r.purpose, ms: r.ms };
    }

    /** The cell that holds the snapshot this sandbox starts from (a session it resumes, a template it starts from). */
    private async cellOfSnapshot(req: SandboxOpen & { prepares?: boolean }): Promise<string | undefined> {
        const ref = req.resumeFrom ? sessionRef(req.resumeFrom) : req.templateKey && !req.prepares ? templateRef(req.templateKey) : undefined;
        if (!ref || !this.deps.placements) return undefined;
        // A placement that cannot be read is no preference: any cell, booted cold (SandboxDeps.placements).
        return this.deps.placements.cellOf(req.organizationId, ref).catch(() => undefined);
    }

    /**
     * The org's template under templateKey (SandboxTemplateSchema): a fresh
     * sandbox that prepares it, the steps, the template, the release, whatever
     * happened. A step that fails leaves no template.
     */
    async template(req: SandboxTemplate): Promise<SandboxSnapshotView> {
        const view = await this.openWith({
            organizationId: req.organizationId,
            sandboxId: req.sandboxId,
            prepares: true,
            templateKey: req.templateKey,
            ...(req.egressAllow?.length ? { egressAllow: req.egressAllow } : {}),
            ...(req.size ? { size: req.size } : {}),
        });
        if (view.state !== 'ready') throw new SandboxError(409, view.blockers?.[0]?.signature ?? 'blocked', view.blockers?.[0]?.message ?? 'The template sandbox did not open.');
        try {
            for (const [i, op] of req.steps.entries()) {
                const r = await this.op({ organizationId: req.organizationId, sandboxId: req.sandboxId, stepId: randomUUID(), op });
                if (!r.ok || (r.exec && r.exec.exitCode !== 0)) throw new SandboxError(409, 'template_step_failed', `Template step ${i + 1} (${op.op}) did not succeed.`);
            }
            return await this.snapshotOf({ organizationId: req.organizationId, sandboxId: req.sandboxId, stepId: randomUUID(), purpose: 'template' }, req.templateKey);
        } finally {
            // Never masks the template's answer; a sandbox not given back is taken by its lease.
            await this.release(req).catch((e) => logger.warn({ msg: 'sandbox.release_failed', organizationId: req.organizationId, sandboxId: req.sandboxId, error: safeFailure(e) }));
        }
    }

    async renew(ref: SandboxRef): Promise<LeaseRenewal> {
        const r = await this.onClaim<LeaseRenewal | EnvError>(ref, '/renew', { consumer: 'sandbox' }, SHORT_MS);
        if ('code' in r) throw new SandboxError(409, r.code, sandboxErrorMessage(r));
        return r;
    }

    async release(ref: SandboxRef): Promise<{ ok: true }> {
        const claimId = this.claimId(ref);
        // No replica holds the cell any more: any one records the release, and the cell's lease takes the machine back.
        const url = (await this.deps.hub.replicaForClaim(claimId)) ?? this.deps.hub.hubBaseUrl;
        await this.deps.hub.post(url, `/internal/claims/${encodeURIComponent(claimId)}/release`, { organizationId: ref.organizationId, runId: null }, `sandbox:${ref.sandboxId}`, SHORT_MS);
        return { ok: true };
    }
}

function blockedView(sandboxId: string, b: Blocked): SandboxView {
    return { sandboxId, state: 'blocked', blockers: b.blockers.map((x) => ({ kind: x.kind, signature: x.signature, message: x.message.slice(0, 500) })) };
}

function sandboxErrorMessage(e: EnvError): string {
    switch (e.code) {
        case 'lease_expired':
            return 'The sandbox ended (its lease or its ceiling passed, or it was released).';
        case 'cell_unavailable':
            return 'The sandbox cell is not reachable now.';
        case 'timeout':
            return 'The sandbox did not answer in time.';
        default:
            return `The sandbox operation did not complete (${e.code}).`;
    }
}
