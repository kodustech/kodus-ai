import { BROWSER_EXPLORE_LIMITS, BrowserExploreRequestSchema, BrowserExploreResultSchema, type BrowserExploreRequest, type BrowserExploreResult } from '@libs/runtime/contracts/browser-exploration';
import { z } from 'zod';
import { request as httpRequest } from 'http';
import { Agent as HttpsAgent, request as httpsRequest } from 'https';

import type { AcquireRequest, BakeOutcome, BakeRequest, Blocked, Claim, ClaimProgress, Consumer, EnvError, EnvironmentRuntime, ExecRequest, LeaseRenewal, PoolTargetRequest, ProbeOutcome, StepResult } from '@libs/runtime/environment';
import { READY_TIMEOUT_MINUTES } from '@libs/runtime/environment';
import type { Probe } from '@libs/runtime/probe';
import type { EvidenceRequest, RepoRef } from '@libs/runtime/protocol';
import type { RunStreamEvent } from '@libs/runtime/run';
import { traceHeaders } from '@libs/runtime/telemetry';

import { describeMachineSize } from '@libs/runtime/contracts/machine-size';

import { type CellDirectory, type CellRefusal, type CellWant, isCellRefusal } from '../../shared/persistence/cell-directory';
import { claimIdFor } from '../../shared/claim-id';
import { CellUnavailableError, HubRefused, MemberCleanupPendingError } from '../../shared/errors';
export { HubRefused } from '../../shared/errors';
import type { PhysicalAdmissionTicket } from '../../shared/admission/admission-contract';
import type { ClaimReleaser, RunEventSink } from '../run/ports';
import type { SecretOpener } from '../secrets/sealed-tokens';

// EnvironmentRuntime over the hub (docs §1b "Do worker ao hub"): the worker
// finds the replica that holds the cell in the cell directory and calls its
// internal listener over mTLS. It never talks to a cloud or a machine.

/** @deprecated the old name of CellUnavailableError. */
export const CellUnavailable = CellUnavailableError;

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND']);
/** A hub answer larger than this is refused (no route answers more than a step result). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** A connection that failed or dropped, as opposed to an answer from the hub. */
export function isNetworkError(e: unknown): boolean {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    const message = (e as Error | undefined)?.message ?? '';
    return (!!code && NETWORK_CODES.has(code)) || /socket hang up|hub request timed out/i.test(message);
}

const CleanupPendingResponse = z.strictObject({
    code: z.literal('member_cleanup_pending'),
    message: z.literal('member_cleanup_pending'),
});

/** The worker's client certificate (OU=worker), and the CA it trusts for the hub (ADR-054). */
export interface WorkerTls {
    cert: string;
    key: string;
    ca: string;
}

type Post = (url: string, headers: Record<string, string>, body: string, timeoutMs: number) => Promise<{ status: number; text: string }>;

/** POST over mTLS with the worker certificate; plain http only in the test-only plaintext mode. */
export function mtlsPost(tls: WorkerTls | undefined): Post {
    const agent = tls ? new HttpsAgent({ cert: tls.cert, key: tls.key, ca: tls.ca, minVersion: 'TLSv1.3', keepAlive: true }) : undefined;
    return (url, headers, body, timeoutMs = 60_000) =>
        new Promise((resolve, reject) => {
            const u = new URL(url);
            if (u.protocol === 'https:' && !agent) return reject(new Error('worker TLS material is required for an https hub'));
            const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
            const req = send(u, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, ...(agent ? { agent } : {}) }, (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (c: Buffer) => {
                    size += c.length;
                    if (size > MAX_RESPONSE_BYTES) return req.destroy(new Error('hub answer too large'));
                    chunks.push(c);
                });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
                res.on('error', reject);
            });
            req.setTimeout(timeoutMs, () => req.destroy(new Error('hub request timed out')));
            req.on('error', reject);
            req.end(body);
        });
}

/** Per-route deadlines: the hub answers a step after the step's own timeout, an acquire after the boot. */
// An acquire waits for the hub's own wait for claim.ready (READY_TIMEOUT_MINUTES), and a minute more.
const TIMEOUT = {
    acquire: (consumer: Consumer) => (READY_TIMEOUT_MINUTES[consumer] + 1) * 60_000,
    step: (ms: number) => ms + 30_000,
    short: 30_000,
} as const;

export interface HubClientOptions {
    tls?: WorkerTls;
    /** TEST ONLY: bearer token for a hub in RUNTIME_TEST_ONLY_PLAINTEXT mode. */
    testOnlyToken?: string;
    cellDirectory: CellDirectory;
    /** A hub's internal listener (Run events; a release when no replica holds the cell). */
    hubBaseUrl: string;
    postImpl?: Post;
}

export class HubClient {
    private readonly send: Post;
    constructor(private readonly opts: HubClientOptions) {
        this.send = opts.postImpl ?? mtlsPost(opts.tls);
    }

    async post<T>(baseUrl: string, path: string, body: unknown, correlationId?: string, timeoutMs: number = TIMEOUT.short): Promise<T> {
        let res: { status: number; text: string };
        try {
            res = await this.send(
                `${baseUrl}${path}`,
                {
                    'content-type': 'application/json',
                    ...(this.opts.testOnlyToken ? { authorization: `Bearer ${this.opts.testOnlyToken}` } : {}),
                    ...(correlationId ? traceHeaders(correlationId) : {}),
                },
                JSON.stringify(body ?? {}),
                timeoutMs,
            );
        } catch (e) {
            // A hub replica restarting (a deploy) drops its connections: that is the cell
            // being out of reach for this call, not a failed Run.
            if (isNetworkError(e)) throw new CellUnavailableError(`hub unreachable: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
            throw e;
        }
        if (res.status === 503) {
            let body: unknown;
            try {
                body = JSON.parse(res.text);
            } catch {
                // Unknown or older hub responses remain unavailable.
            }
            if (CleanupPendingResponse.safeParse(body).success) throw new MemberCleanupPendingError();
        }
        if (res.status === 503 || res.status === 502 || res.status === 504) throw new CellUnavailableError(res.text.slice(0, 500));
        if (res.status === 409) {
            let body: { code?: unknown; message?: unknown } = {};
            try {
                body = JSON.parse(res.text);
            } catch {
                // fall through with an unknown code
            }
            throw new HubRefused({ code: String(body.code ?? 'refused'), message: String(body.message ?? res.text.slice(0, 500)) });
        }
        if (res.status < 200 || res.status >= 300) throw new Error(`hub ${path} answered ${res.status}: ${res.text.slice(0, 500)}`);
        let parsed: unknown;
        try {
            parsed = JSON.parse(res.text);
        } catch {
            throw new Error(`hub ${path} answered something that is not JSON`);
        }
        if (parsed === null || typeof parsed !== 'object') throw new Error(`hub ${path} answered a non-object`);
        return parsed as T;
    }

    replicaForClaim(claimId: string): Promise<string | null> {
        return this.opts.cellDirectory.replicaForClaim(claimId);
    }

    async replicaForCell(cellId: string): Promise<string | null> {
        return this.opts.cellDirectory.replicaForCell?.(cellId) ?? null;
    }

    reserveCell(orgId: string, want?: CellWant) {
        return this.opts.cellDirectory.reserveCell(orgId, want);
    }

    get hubBaseUrl() {
        return this.opts.hubBaseUrl;
    }
}

/**
 * egress.policy fan-out (ADR-034): each replica holding a live claim of the
 * environment gets the allowlist once and pushes it to the claims it holds.
 */
export class HubEgressPolicyPusher {
    constructor(
        private readonly hub: HubClient,
        private readonly replicasOfEnvironment: (organizationId: string, environmentId: string) => Promise<string[]>,
    ) {}

    async push(organizationId: string, environmentId: string, allow: string[]): Promise<void> {
        for (const url of new Set(await this.replicasOfEnvironment(organizationId, environmentId))) {
            await this.hub.post(url, `/internal/environments/${encodeURIComponent(environmentId)}/egress-policy`, { organizationId, allow });
        }
    }
}

/** What one environment client carries that AcquireRequest does not. The repo token stays sealed here. */
export interface HubRunContext {
    admissionTicket?: PhysicalAdmissionTicket;
    correlationId: string;
    organizationId: string;
    /** The Run of every claim this client touches; undefined for a setup (its claims have no Run). */
    runId?: string;
    repo: RepoRef;
    /** Sealed; opened only inside acquire. */
    sealedRepoToken: string;
    /** The PR side's own token (each claim revokes the one it fetched with); absent: the PR uses sealedRepoToken. */
    sealedPrRepoToken?: string;
    /** What the sealed token is bound to (the runId, or the setup binding). */
    tokenBinding: string;
    imageId: string;
    expose: Claim['manifest']['expose'];
    /**
     * The cell that holds the environment's warm pool (its last setup's), tried
     * first among the eligible cells. Any failure finding it is no preference.
     */
    preferCell?: (organizationId: string, environmentId: string) => Promise<string | undefined>;
}

/**
 * Connected cells that may not take the claim now, as a blocked acquire
 * (kind resources): nothing booted and nothing was sent to a cell. The
 * catalog's org_capacity and no_capacity cards say to wait or use an own
 * cell; its size_unavailable card, to choose a size a cell grants.
 */
export function capacityBlocked(r: CellRefusal): Blocked {
    return { status: 'blocked', blockers: [refusalBlocker(r)] };
}

function refusalBlocker(r: CellRefusal): Blocked['blockers'][number] {
    switch (r.refused) {
        case 'org_capacity':
            return {
                kind: 'resources',
                signature: 'org_capacity',
                message: `this organization already holds ${r.open} machines on shared Kodus cells, the most it may hold at once (cap ${r.cap}); the claim was not started`,
            };
        case 'no_capacity':
            return { kind: 'resources', signature: 'no_capacity', message: 'every cell that may serve this organization is full; the claim was not started' };
        case 'size_unavailable': {
            const largest = r.largest ? `the largest any of them grants is ${describeMachineSize(r.largest)}` : 'none of them grants a machine size (a cell older than machine sizes grants none)';
            return {
                kind: 'resources',
                signature: 'size_unavailable',
                message: `asked ${describeMachineSize(r.size)}, and no connected cell that may serve this organization grants it: ${largest}; the claim was not started`,
            };
        }
    }
}

/** One EnvironmentRuntime per Run (or setup), over the hub's internal listener. */
export class HubEnvironmentClient implements EnvironmentRuntime {
    constructor(
        private readonly hub: HubClient,
        private readonly secrets: SecretOpener,
        private readonly run: HubRunContext,
    ) {}

    private get tenant() {
        return { organizationId: this.run.organizationId, ...(this.run.runId !== undefined ? { runId: this.run.runId } : { runId: null }) };
    }

    async acquire(req: AcquireRequest): Promise<Claim | Blocked> {
        const ticket = this.run.admissionTicket;
        if (ticket) {
            if (ticket.organizationId !== req.organizationId || req.organizationId !== this.run.organizationId ||
                (ticket.kind === 'run' && (ticket.key !== this.run.runId || req.runId !== this.run.runId || req.consumer !== 'runtime')) ||
                (ticket.kind === 'setup' && req.consumer !== 'setup')) throw new Error('admission scope mismatch');
            const member = ticket.members.find((m) => m.side === req.ref.side && m.idempotencyKey === req.idempotencyKey && m.claimId === claimIdFor(req.organizationId, req.idempotencyKey));
            const setupChild = ticket.kind === 'setup' && req.ref.side === 'setup' &&
                req.idempotencyKey.startsWith(`setup:${ticket.key}:`) && /^learn-[1-3](-replay)?$/.test(req.idempotencyKey.slice(`setup:${ticket.key}:`.length));
            if (!member && !setupChild) throw new Error('admission member mismatch');
            const url = await this.hub.replicaForCell(ticket.cellId);
            if (!url) throw new CellUnavailableError('admission cell is unavailable');
            if (setupChild) {
                const until = Date.now() + 20_000;
                for (;;) {
                    const remainingMs = until - Date.now();
                    if (remainingMs <= 0) return capacityBlocked({ refused: 'no_capacity' });
                    let moved: { ok: boolean; reason?: string };
                    try {
                        moved = await this.hub.post(url, `/internal/cells/${encodeURIComponent(ticket.cellId)}/admission/retarget-setup`, { ticket, idempotencyKey: req.idempotencyKey }, this.run.correlationId, Math.min(5000, remainingMs));
                    } catch (error) {
                        if (error instanceof HubRefused) return capacityBlocked({ refused: 'no_capacity' });
                        throw error;
                    }
                    if (moved.ok) break;
                    if (moved.reason !== 'member_cleanup_pending' || Date.now() >= until) return capacityBlocked({ refused: 'no_capacity' });
                    await new Promise<void>((resolve) => setTimeout(resolve, 500));
                }
            }
            const sealed = req.ref.side === 'pr' && this.run.sealedPrRepoToken ? this.run.sealedPrRepoToken : this.run.sealedRepoToken;
            const repoToken = this.secrets.open(sealed, this.run.tokenBinding);
            try {
                const outcome = await this.hub.post<Claim | Blocked>(url, `/internal/cells/${encodeURIComponent(ticket.cellId)}/acquire`, { ...req, admission: ticket, expose: this.run.expose, repo: this.run.repo, repoToken }, this.run.correlationId, TIMEOUT.acquire(req.consumer));
                if ('status' in outcome && outcome.status === 'blocked' && outcome.blockers.some((b) => b.signature === 'admission_ticket_invalid' || b.signature === 'admission_ticket_required')) return capacityBlocked({ refused: 'no_capacity' });
                return outcome;
            } catch (error) {
                if (error instanceof HubRefused && error.body.code === 'admission_refused') return capacityBlocked({ refused: 'no_capacity' });
                throw error;
            }
        }
        const prefer = await this.run.preferCell?.(req.organizationId, req.environmentId).catch(() => undefined);
        // A new round of the same claim never counts against its own org's cap; a sized
        // claim only goes to a cell that grants the size it will ask (req.size, sent as is).
        const cell = await this.hub.reserveCell(req.organizationId, {
            prefer,
            claimId: claimIdFor(req.organizationId, req.idempotencyKey),
            ...(req.size ? { size: req.size } : {}),
        });
        if (!cell) throw new CellUnavailableError('no cell is connected for this organization');
        if (isCellRefusal(cell)) return capacityBlocked(cell);
        // Opened here, inside the acquire step, for this one call; never returned or stored.
        const sealed = req.ref?.side === 'pr' && this.run.sealedPrRepoToken ? this.run.sealedPrRepoToken : this.run.sealedRepoToken;
        const repoToken = this.secrets.open(sealed, this.run.tokenBinding);
        return this.hub.post(
            cell.replicaUrl,
            `/internal/cells/${encodeURIComponent(cell.cellId)}/acquire`,
            { ...req, expose: this.run.expose, repo: this.run.repo, repoToken },
            this.run.correlationId,
            TIMEOUT.acquire(req.consumer),
        );
    }

    /** Best effort: a hub that does not know the claim yet, or is unreachable, is "no progress". */
    async progress(req: { organizationId: string; idempotencyKey: string }): Promise<ClaimProgress | null> {
        const claimId = claimIdFor(req.organizationId, req.idempotencyKey);
        try {
            const url = (await this.hub.replicaForClaim(claimId)) ?? this.hub.hubBaseUrl;
            return await this.hub.post<ClaimProgress>(url, `/internal/claims/${encodeURIComponent(claimId)}/progress`, { organizationId: req.organizationId }, this.run.correlationId, TIMEOUT.short);
        } catch {
            return null;
        }
    }

    private async onClaim<T>(claimId: string, path: string, body: Record<string, unknown>, timeoutMs: number): Promise<T | EnvError> {
        const url = await this.hub.replicaForClaim(claimId);
        if (!url) return { code: 'cell_unavailable', cellId: 'unknown' };
        try {
            return await this.hub.post<T>(url, `/internal/claims/${encodeURIComponent(claimId)}${path}`, { ...this.tenant, ...body }, this.run.correlationId, timeoutMs);
        } catch (e) {
            if (e instanceof CellUnavailableError) return { code: 'cell_unavailable', cellId: 'unknown' };
            throw e;
        }
    }

    probe(claimId: string, probe: Probe, stepId: string, evidence?: EvidenceRequest): Promise<ProbeOutcome | EnvError> {
        return this.onClaim(claimId, '/probe', { probe, stepId, ...(evidence ? { evidence } : {}) }, TIMEOUT.step(probe.spec.timeoutMs));
    }

    async exploreBrowser(claimId: string, request: BrowserExploreRequest, stepId: string): Promise<BrowserExploreResult | EnvError> {
        const parsed = BrowserExploreRequestSchema.parse(request);
        const result = await this.onClaim<BrowserExploreResult>(claimId, '/browser-explore', { request: parsed, stepId }, TIMEOUT.step(parsed.timeoutMs + BROWSER_EXPLORE_LIMITS.runnerGraceMs));
        if ('code' in result) return result;
        const valid = BrowserExploreResultSchema.safeParse(result);
        return valid.success ? valid.data : { status: 'unavailable', snapshot: '', candidates: [], actionsCompleted: 0, durationMs: 0, cliCalls: 0, truncated: false };
    }

    exec(claimId: string, req: ExecRequest): Promise<StepResult | EnvError> {
        return this.onClaim(claimId, '/exec', { ...req }, TIMEOUT.step(req.timeoutMs));
    }

    async reset(claimId: string, imageId?: string): Promise<void | EnvError> {
        const r = await this.onClaim<{ ok?: boolean; code?: string }>(claimId, '/reset', { imageId: imageId ?? this.run.imageId }, TIMEOUT.step(120_000));
        if (r && 'code' in r && r.code) return r as EnvError;
    }

    async release(claimId: string): Promise<void> {
        await new HubClaimReleaser(this.hub).release({ claimId, ...this.tenant }, this.run.correlationId);
    }

    /** claim.renew through the replica that holds the claim's cell; no replica holds it: cell_unavailable (retry later). */
    renew(claimId: string, consumer: Consumer): Promise<LeaseRenewal | EnvError> {
        return this.onClaim<LeaseRenewal>(claimId, '/renew', { consumer }, TIMEOUT.short);
    }

    async bake(req: BakeRequest): Promise<BakeOutcome> {
        if (!req.claimId) return { status: 'refused', code: 'no_claim', message: 'this worker only bakes from the setup claim that booted the commit' };
        const { claimId, ...body } = req;
        try {
            const r = await this.onClaim<BakeOutcome>(claimId, '/bake', body, TIMEOUT.short);
            if ('code' in r && !('status' in r)) return { status: 'refused', code: r.code, message: 'the cell is not reachable' };
            return r as BakeOutcome;
        } catch (e) {
            if (e instanceof HubRefused) return { status: 'refused', code: e.body.code, message: e.body.message };
            throw e;
        }
    }

    async poolTarget(req: PoolTargetRequest): Promise<BakeOutcome> {
        // The replica that holds the setup claim holds its cell; the request itself names no claim (a pool never comes from one).
        const url = (await this.hub.replicaForClaim(req.claimId)) ?? this.hub.hubBaseUrl;
        return postPoolTarget(this.hub, url, req, this.run.correlationId);
    }
}

/** POST pool-target with `latest`: the cell resolves it to the environment's last bake there. */
async function postPoolTarget(hub: HubClient, url: string, req: Omit<PoolTargetRequest, 'claimId'>, correlationId?: string): Promise<BakeOutcome> {
    try {
        return await hub.post<BakeOutcome>(
            url,
            `/internal/cells/${encodeURIComponent(req.cellId)}/pool-target`,
            { organizationId: req.organizationId, environmentId: req.environmentId, imageId: 'latest', size: req.size, ...(req.machineSize ? { machineSize: req.machineSize } : {}) },
            correlationId,
            TIMEOUT.short,
        );
    } catch (e) {
        if (e instanceof HubRefused) return { status: 'refused', code: e.body.code, message: e.body.message };
        throw e;
    }
}

/**
 * The admin changed an environment's pool size: pool.target to the cell of
 * the environment's last setup, through the replica that holds it.
 */
export class HubPoolTargetSender {
    constructor(
        private readonly hub: HubClient,
        private readonly replicaForCell: (cellId: string) => Promise<string | null>,
    ) {}

    async send(req: Omit<PoolTargetRequest, 'claimId'>): Promise<BakeOutcome> {
        const url = await this.replicaForCell(req.cellId);
        if (!url) return { status: 'refused', code: 'cell_unavailable', message: `no replica holds cell ${req.cellId}` };
        return postPoolTarget(this.hub, url, req);
    }
}

/** @deprecated the old name of HubEnvironmentClient. */
export const HubEnvironmentRuntime = HubEnvironmentClient;

/**
 * Releases a claim through the hub. The replica that holds the cell tells it;
 * when no replica holds it any more, any replica records the release (the
 * cell's lease and dead-man take the machines back), so a claim never stays
 * open only because its cell went away.
 */
export class HubClaimReleaser implements ClaimReleaser {
    constructor(private readonly hub: HubClient) {}

    async release(ref: { claimId: string; organizationId: string; runId?: string | null }, correlationId?: string): Promise<void> {
        const url = (await this.hub.replicaForClaim(ref.claimId)) ?? this.hub.hubBaseUrl;
        const { claimId, ...tenant } = ref;
        await this.hub.post(url, `/internal/claims/${encodeURIComponent(claimId)}/release`, tenant, correlationId);
    }
}

/**
 * The worker hands Run events to the hub, which writes the stream (ADR-047).
 * A keyed event is written once even when its step is retried. A hub outage
 * does not fail the Run: the projection holds the truth and the stream is its
 * view, so after a few tries the event is dropped and counted.
 */
export class HubRunEventSink implements RunEventSink {
    constructor(
        private readonly hub: HubClient,
        private readonly onDropped: (e: Error, event: RunStreamEvent) => void = () => undefined,
        private readonly retryDelaysMs: number[] = [200, 1_000, 3_000],
    ) {}

    async append(orgId: string, runId: string, event: RunStreamEvent, key?: string) {
        for (let attempt = 0; ; attempt++) {
            try {
                await this.hub.post(this.hub.hubBaseUrl, `/internal/runs/${encodeURIComponent(runId)}/events`, { organizationId: orgId, event, ...(key ? { key } : {}) });
                return;
            } catch (e) {
                if (attempt >= this.retryDelaysMs.length) return this.onDropped(e as Error, event);
                await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
            }
        }
    }
}
