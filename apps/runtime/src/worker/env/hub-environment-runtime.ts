import { DEFAULT_RESET_TIMEOUT_MS } from './ready-check';
import { BROWSER_ROUND_GRACE_MS } from '@libs/runtime/contracts/evidence';
import { BROWSER_EXPLORE_LIMITS, BrowserExploreRequestSchema, BrowserExploreResultSchema, type BrowserExploreRequest, type BrowserExploreResult } from '@libs/runtime/contracts/browser-exploration';
import { z } from 'zod';
import { request as httpRequest } from 'http';
import { Agent as HttpsAgent, request as httpsRequest } from 'https';

import type { AcquireOptions, AcquireRequest, BakeOutcome, BakeRequest, Blocked, Blocker, Claim, ClaimProgress, Consumer, EnvError, EnvironmentHealth, EnvironmentRuntime, ExecRequest, LeaseRenewal, PoolTargetRequest, ProbeOutcome, StepResult, UploadRequest } from '@libs/runtime/environment';
import type { IsolationMinimum } from '@libs/runtime/contracts/isolation';
import { bootTimedOut, environmentHealthOf, isBlocked, isolationUnavailable, readyTimeoutMinutes } from '@libs/runtime/environment';
import { typedBlocked } from '@libs/runtime/environment/typed-blocker';
import type { Probe } from '@libs/runtime/probe';
import type { ClaimRepo, EvidenceRequest, ExercisedRequest, ExercisedResult, RepoRef } from '@libs/runtime/protocol';
import { type ClaimWorkspace, type RunStreamEvent, workspaceSideOf } from '@libs/runtime/run';
import { traceHeaders } from '@libs/runtime/telemetry';

import { describeMachineSize } from '@libs/runtime/contracts/machine-size';
import { repositoryAliasOf } from '@libs/runtime/contracts/workspace';

import { type CellDirectory, type CellRefusal, type CellWant, isCellRefusal } from '../../shared/persistence/cell-directory';
import { claimIdFor, isSetupChildSuffix } from '../../shared/claim-id';
import { CellUnavailableError, HubRefused, HubUnreachableError, MemberCleanupPendingError, NoCellConnectedError } from '../../shared/errors';
export { HubRefused } from '../../shared/errors';
import type { PhysicalAdmissionTicket } from '../../shared/admission/admission-contract';
import type { ClaimReleaser, RunEventSink } from '../run/ports';
import { evidenceReadUrl, type EvidenceUploads } from '../run/run-evidence';
import { canonicalEvidenceKey } from '../../shared/evidence/file-evidence-store';
import type { SecretOpener } from '../secrets/sealed-tokens';

// EnvironmentRuntime over the hub (docs §1b "Do worker ao hub"): the worker
// finds the replica that holds the cell in the cell directory and calls its
// internal listener over mTLS. It never talks to a cloud or a machine.

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND']);
/** A hub answer larger than this is refused (no route answers more than a step result). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** The hub did not answer within the request's time. */
export class HubRequestTimeoutError extends Error {
    constructor() {
        super('hub request timed out');
        this.name = 'HubRequestTimeoutError';
    }
}

/**
 * A connection that failed or dropped, as opposed to an answer from the hub.
 * Decided on Node's error `code` (a "socket hang up" carries ECONNRESET), never on the message.
 */
export function isNetworkError(e: unknown): boolean {
    if (e instanceof HubRequestTimeoutError) return true;
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    return typeof code === 'string' && NETWORK_CODES.has(code);
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
            req.setTimeout(timeoutMs, () => req.destroy(new HubRequestTimeoutError()));
            req.on('error', reject);
            req.end(body);
        });
}

/** Per-route deadlines: the hub answers a step after the step's own timeout, an acquire after the boot. */
// An acquire waits for the hub's own wait for claim.ready (READY_TIMEOUT_MINUTES), and a minute more.
const TIMEOUT = {
    acquire: (consumer: Consumer, side?: string) => (readyTimeoutMinutes(consumer, side) + 1) * 60_000,
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
    /** Pauses before sending again a request the hub refused at connect (a replica restarting); tests pass short ones. */
    refusedRetryDelaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
}

/** How long past a boot's ready deadline the worker still waits for the hub's own answer (its boot_timeout names the cell). */
export const READY_ANSWER_GRACE_MS = 60_000;

/** About a minute and a half in all: what a hub replica takes to come back after a deploy. */
export const HUB_REFUSED_RETRY_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 30_000, 30_000];

export class HubClient {
    private readonly send: Post;
    constructor(private readonly opts: HubClientOptions) {
        this.send = opts.postImpl ?? mtlsPost(opts.tls);
    }

    async post<T>(baseUrl: string, path: string, body: unknown, correlationId?: string, timeoutMs: number = TIMEOUT.short): Promise<T> {
        let res: { status: number; text: string };
        const delays = this.opts.refusedRetryDelaysMs ?? HUB_REFUSED_RETRY_MS;
        const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        // A refused connection never reached the hub, so sending it again cannot do anything twice.
        const sendReaching: Post = async (...a) => {
            for (let attempt = 0; ; attempt++) {
                try {
                    return await this.send(...a);
                } catch (e) {
                    if (attempt >= delays.length || (e as NodeJS.ErrnoException | undefined)?.code !== 'ECONNREFUSED') throw e;
                    await sleep(delays[attempt]);
                }
            }
        };
        try {
            res = await sendReaching(
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
            if (isNetworkError(e)) throw new HubUnreachableError(`hub unreachable: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
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
    /**
     * The least isolation every claim of this client asks when the request
     * names none (RUNTIME_ISOLATION_MINIMUM): the hub places it only on a cell
     * that satisfies it, never lower (isolation-architecture.md C1).
     */
    isolationMinimum?: IsolationMinimum;
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
    /** How long a machine.reset may take (resetTimeoutMs); absent, the hub's default. */
    resetTimeoutMs?: number;
    /**
     * The repositories of a multi-repository environment, each side's token
     * sealed (bound to tokenBinding): the primary's token replaces
     * sealedRepoToken and sealedPrRepoToken, and every other repository goes
     * in the acquire as repos. Absent: one repository, as before.
     */
    workspace?: ClaimWorkspace;
    /**
     * The member repository the PR is in (its alias), when it is not the
     * primary: every command this client runs is on the PR's code, so each
     * goes there (exec.repository). Absent: the claim's own repository.
     */
    execRepository?: string;
    /**
     * The cell that holds the environment's warm pool (its last setup's), tried
     * first among the eligible cells. Any failure finding it is no preference.
     */
    preferCell?: (organizationId: string, environmentId: string) => Promise<string | undefined>;
    /**
     * The health of an environment of this org (EnvironmentRuntime.status), from
     * what the worker already keeps (the setup record); absent: not_set_up.
     */
    health?: (organizationId: string, environmentId: string) => Promise<EnvironmentHealth>;
    /** Where a cell reads evidence objects (the store its upload grants go to): absent, an upload is upload_unavailable. */
    evidenceReads?: EvidenceUploads;
}

/**
 * Connected cells that may not take the claim now, as a blocked acquire
 * (kind resources): nothing booted and nothing was sent to a cell. The
 * catalog's org_capacity and no_capacity cards say to wait or use an own
 * cell; its size_unavailable card, to choose a size a cell grants.
 */
export function capacityBlocked(r: CellRefusal): Blocked {
    return { status: 'blocked', blockers: [refusalBlocker(r)], ...capacityOf(r) };
}

/** What a refusal for room knows about when it may end (Blocked.capacity), for the Run page. */
function capacityOf(r: CellRefusal): Pick<Blocked, 'capacity'> {
    if (r.refused === 'no_capacity' && (r.hosts !== undefined || r.nextFreeAt)) return { capacity: { ...(r.hosts !== undefined ? { hosts: r.hosts } : {}), ...(r.nextFreeAt ? { nextFreeAt: r.nextFreeAt } : {}) } };
    if (r.refused === 'org_capacity') return { capacity: { cap: r.cap, ...(r.nextFreeAt ? { nextFreeAt: r.nextFreeAt } : {}) } };
    return {};
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
            if (r.hostStarting) {
                return {
                    kind: 'resources',
                    signature: 'no_capacity',
                    message: `a host of pool ${r.pool} is starting for this Run; the claim was not started yet`,
                };
            }
            return {
                kind: 'resources',
                signature: 'no_capacity',
                message: `every cell that may serve this organization is full${r.hosts ? ` (${r.hosts} ${r.hosts === 1 ? 'host' : 'hosts'})` : ''}${r.pool ? ` in pool ${r.pool}` : ''}; the claim was not started`,
            };
        case 'host_unavailable':
            return {
                kind: 'capacity',
                signature: 'host_unavailable',
                message: `the host of pool ${r.pool} for this Run could not be started (${r.reason}); run it again`,
            };
        case 'isolation_unavailable':
            return isolationUnavailable(r.isolation).blockers[0];
        case 'backend_unavailable':
            return {
                kind: 'capacity',
                signature: 'backend_unavailable',
                message: `the Run's other side ran on ${r.driver}${r.isolation ? ` (${r.isolation})` : ''}, and no connected cell that may serve this organization runs it now; both sides must run on one backend, so the claim was not started`,
            };
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

/**
 * The claim ids of the same Run attempt's other side (its first claim and its
 * renewed one), for a Runtime claim keyed `${runId}:${side}:${attempt}[:renewed]`
 * (acquireRequest). Any other claim has no other side: undefined.
 */
export function sameBackendAs(req: Pick<AcquireRequest, 'organizationId' | 'runId' | 'consumer' | 'ref' | 'idempotencyKey'>): string[] | undefined {
    const side = req.ref?.side;
    if (req.consumer !== 'runtime' || !req.runId || (side !== 'base' && side !== 'pr')) return undefined;
    const prefix = `${req.runId}:${side}:`;
    if (!req.idempotencyKey.startsWith(prefix)) return undefined;
    const attempt = req.idempotencyKey.slice(prefix.length).split(':')[0];
    if (!attempt) return undefined;
    const other = `${req.runId}:${side === 'base' ? 'pr' : 'base'}:${attempt}`;
    return [other, `${other}:renewed`].map((key) => claimIdFor(req.organizationId, key));
}

/** A repository of the workspace has no download token for the side: nothing is sent, and the blocker names it. */
function workspaceTokenMissing(alias: string, side: string): Blocked {
    const blocker: Blocker = {
        kind: 'other_repo',
        signature: 'workspace_token_missing',
        message: `the request carries no download token for ${alias} on the ${side} side; the claim was not started`,
        alias,
    };
    return { status: 'blocked', blockers: [blocker] };
}

/** The primary's alias is not the one the cell gives its directory: the members' `../<alias>` paths would not meet. */
function workspacePrimaryAlias(alias: string, fullName: string): Blocked {
    const blocker: Blocker = {
        kind: 'other_repo',
        signature: 'workspace_primary_alias',
        message: `the primary repository ${fullName} has the alias ${alias}, and a cell lays it out as ${repositoryAliasOf(fullName)}; the claim was not started`,
        alias,
    };
    return { status: 'blocked', blockers: [blocker] };
}

/** How long the cell may take to write an upload's files (each fetched from the evidence store). */
export const UPLOAD_TIMEOUT_MS = 120_000;

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

    /**
     * With opts.readyBy (a boot that began on an earlier call) the call waits
     * only until then, and a minute more for the hub's own answer: a hub that
     * waits a fresh ready wait for a round it sent again (a new round after a
     * restart, claim-deadlines.ts readyWaitMs) is cut there, and the boot is
     * boot_timeout, never a dropped call that is asked again.
     */
    async acquire(req: AcquireRequest, opts: AcquireOptions = {}): Promise<Claim | Blocked> {
        const min = this.run.isolationMinimum;
        const asked = req.isolation || !min || min === 'any' ? req : { ...req, isolation: min };
        const out = await this.acquireUntyped(asked, opts);
        // The border with the hub (docs §5): a kind this worker does not know reads unknown, and every blocker carries the catalog's card.
        return isBlocked(out) ? typedBlocked(out) : out;
    }

    private async acquireUntyped(req: AcquireRequest, opts: AcquireOptions): Promise<Claim | Blocked> {
        const { readyBy } = opts;
        if (readyBy === undefined) return this.sendAcquire(req, TIMEOUT.acquire(req.consumer, req.ref?.side));
        const leftMs = readyBy - Date.now();
        if (leftMs <= 0) return bootTimedOut(req.consumer, req.ref?.side);
        try {
            return await this.sendAcquire(req, Math.min(TIMEOUT.acquire(req.consumer, req.ref?.side), leftMs + READY_ANSWER_GRACE_MS));
        } catch (e) {
            if (e instanceof HubUnreachableError && Date.now() >= readyBy) return bootTimedOut(req.consumer, req.ref?.side);
            throw e;
        }
    }

    private async sendAcquire(req: AcquireRequest, timeoutMs: number): Promise<Claim | Blocked> {
        const ticket = this.run.admissionTicket;
        if (ticket) {
            if (ticket.organizationId !== req.organizationId || req.organizationId !== this.run.organizationId ||
                (ticket.kind === 'run' && (ticket.key !== this.run.runId || req.runId !== this.run.runId || req.consumer !== 'runtime')) ||
                (ticket.kind === 'setup' && req.consumer !== 'setup')) throw new Error('admission scope mismatch');
            const member = ticket.members.find((m) => m.side === req.ref.side && m.idempotencyKey === req.idempotencyKey && m.claimId === claimIdFor(req.organizationId, req.idempotencyKey));
            const setupChild = ticket.kind === 'setup' && req.ref.side === 'setup' &&
                req.idempotencyKey.startsWith(`setup:${ticket.key}:`) && isSetupChildSuffix(req.idempotencyKey.slice(`setup:${ticket.key}:`.length));
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
            const fetch = this.fetchOf(req);
            if ('status' in fetch) return fetch;
            try {
                const outcome = await this.hub.post<Claim | Blocked>(url, `/internal/cells/${encodeURIComponent(ticket.cellId)}/acquire`, { ...req, admission: ticket, expose: this.run.expose, ...fetch }, this.run.correlationId, timeoutMs);
                if ('status' in outcome && outcome.status === 'blocked' && outcome.blockers.some((b) => b.signature === 'admission_ticket_invalid' || b.signature === 'admission_ticket_required')) return capacityBlocked({ refused: 'no_capacity' });
                return outcome;
            } catch (error) {
                if (error instanceof HubRefused && error.body.code === 'admission_refused') return capacityBlocked({ refused: 'no_capacity' });
                throw error;
            }
        }
        // Any failure finding the pool's cell is no preference (HubRunContext.preferCell): any eligible cell.
        const prefer = await this.run.preferCell?.(req.organizationId, req.environmentId).catch(() => undefined);
        // A new round of the same claim never counts against its own org's cap; a sized
        // claim only goes to a cell that grants the size it will ask (req.size, sent as is),
        // and a claim with an isolation minimum only to a cell that satisfies it.
        const cell = await this.hub.reserveCell(req.organizationId, {
            prefer,
            claimId: claimIdFor(req.organizationId, req.idempotencyKey),
            ...(req.size ? { size: req.size } : {}),
            ...(req.isolation && req.isolation !== 'any' ? { isolation: req.isolation } : {}),
            // A Run's two sides compare one build on one backend: once a side is placed, the other follows it.
            ...(sameBackendAs(req) ? { sameBackendAs: sameBackendAs(req) } : {}),
            // Placement by pool (docs/runtime/host-providers.md §6): a Run's side may wait for its own perRun host.
            consumer: req.consumer,
            ...(req.runId ? { runId: req.runId } : {}),
            ...(req.environmentId ? { environmentId: req.environmentId } : {}),
        });
        if (!cell) throw new NoCellConnectedError('no cell is connected for this organization');
        if (isCellRefusal(cell)) return capacityBlocked(cell);
        const fetch = this.fetchOf(req);
        if ('status' in fetch) return fetch;
        return this.hub.post(
            cell.replicaUrl,
            `/internal/cells/${encodeURIComponent(cell.cellId)}/acquire`,
            { ...req, expose: this.run.expose, ...fetch },
            this.run.correlationId,
            timeoutMs,
        );
    }

    /**
     * What the cell downloads for this claim: the repository and its token for
     * the claim's side and, in a multi-repository environment, every other
     * repository at that side's commit with that side's token. Opened here,
     * inside the acquire step, for this one call; never returned, stored or
     * logged. A repository without a token blocks the claim before any is opened.
     */
    private fetchOf(req: AcquireRequest): { repo: RepoRef; repoToken: string; repos?: ClaimRepo[] } | Blocked {
        const ws = this.run.workspace;
        if (!ws) {
            const sealed = req.ref?.side === 'pr' && this.run.sealedPrRepoToken ? this.run.sealedPrRepoToken : this.run.sealedRepoToken;
            return { repo: this.run.repo, repoToken: this.secrets.open(sealed, this.run.tokenBinding) };
        }
        const side = workspaceSideOf(req.ref.side);
        // The cell lays the primary out under the alias of its name (repositoryAliasOf), which the protocol does not carry.
        if (ws.members.length && repositoryAliasOf(ws.primary.fullName) !== ws.primary.alias) return workspacePrimaryAlias(ws.primary.alias, ws.primary.fullName);
        for (const r of [ws.primary, ...ws.members]) if (!r[side].sealedToken) return workspaceTokenMissing(r.alias, side);
        const open = (sealed: string | undefined) => this.secrets.open(sealed!, this.run.tokenBinding);
        const repos = ws.members.map((m): ClaimRepo => ({ alias: m.alias, repo: { ...this.run.repo, fullName: m.fullName }, sha: m[side].sha, repoToken: open(m[side].sealedToken) }));
        return { repo: { ...this.run.repo, fullName: ws.primary.fullName }, repoToken: open(ws.primary[side].sealedToken), ...(repos.length ? { repos } : {}) };
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
        // A browser round with browser evidence also starts the runner container and uploads its artifacts:
        // the hub gives the cell the same grace (step-dispatcher.ts), so the worker waits past it.
        const grace = probe.spec.kind === 'browser' && evidence?.capture.includes('browser') ? BROWSER_ROUND_GRACE_MS : 0;
        return this.onClaim(claimId, '/probe', { probe, stepId, ...(evidence ? { evidence } : {}) }, TIMEOUT.step(probe.spec.timeoutMs + grace));
    }

    async exploreBrowser(claimId: string, request: BrowserExploreRequest, stepId: string): Promise<BrowserExploreResult | EnvError> {
        const parsed = BrowserExploreRequestSchema.parse(request);
        const result = await this.onClaim<BrowserExploreResult>(claimId, '/browser-explore', { request: parsed, stepId }, TIMEOUT.step(parsed.timeoutMs + BROWSER_EXPLORE_LIMITS.runnerGraceMs));
        if ('code' in result) return result;
        const valid = BrowserExploreResultSchema.safeParse(result);
        return valid.success ? valid.data : { status: 'unavailable', snapshot: '', candidates: [], actionsCompleted: 0, durationMs: 0, cliCalls: 0, truncated: false };
    }

    exec(claimId: string, req: ExecRequest): Promise<StepResult | EnvError> {
        const repository = req.repository ?? this.run.execRepository;
        return this.onClaim(claimId, '/exec', { ...req, ...(repository ? { repository } : {}) }, TIMEOUT.step(req.timeoutMs));
    }

    async reset(claimId: string, imageId?: string, roundSnapshotId?: string): Promise<void | EnvError> {
        const waitMs = this.run.resetTimeoutMs;
        const body = { imageId: imageId ?? this.run.imageId, ...(roundSnapshotId ? { roundSnapshotId } : {}), ...(waitMs ? { timeoutMs: waitMs } : {}) };
        const r = await this.onClaim<{ ok?: boolean; code?: string }>(claimId, '/reset', body, TIMEOUT.step(waitMs ?? DEFAULT_RESET_TIMEOUT_MS));
        if (r && 'code' in r && r.code) return r as EnvError;
    }

    /** claim.snapshot round through the claim's replica; a cell that refuses it (no snapshots, a tainted machine) is an EnvError. */
    async snapshotRound(claimId: string, stepId: string): Promise<{ id: string; ms: number } | EnvError> {
        try {
            const r = await this.onClaim<{ id: string; ms: number } | EnvError>(claimId, '/snapshot', { stepId, purpose: 'round' }, TIMEOUT.step(10 * 60_000));
            if ('code' in r) return r;
            return { id: r.id, ms: r.ms };
        } catch (e) {
            if (e instanceof HubRefused) return { code: 'transport_lost', stepId };
            throw e;
        }
    }

    /**
     * claim.exercised through the claim's replica: undefined when the cell does not name
     * exercisedLines (the hub sent nothing) or refused the frame.
     */
    async exercisedLines(claimId: string, stepId: string, request: ExercisedRequest): Promise<ExercisedResult | undefined | EnvError> {
        try {
            const r = await this.onClaim<{ exercised: ExercisedResult | null }>(claimId, '/exercised', { stepId, exercised: request }, TIMEOUT.step(60_000));
            if ('code' in r) return r;
            return r.exercised ?? undefined;
        } catch (e) {
            if (e instanceof HubRefused) return undefined;
            throw e;
        }
    }

    /**
     * upload through the claim's replica (the protocol's upload frame). Each
     * contentRef must be an evidence key of this client's org; the worker
     * signs a read URL of that one key (at most 5 minutes) per file, which
     * the cell GETs over its own path. No evidence store a cell can read
     * from, or a cell that cannot take files: upload_unavailable.
     */
    async upload(claimId: string, req: UploadRequest): Promise<void | EnvError> {
        if (!this.run.evidenceReads) return { code: 'upload_unavailable' };
        const files: Array<UploadRequest['files'][number] & { url: string }> = [];
        for (const [i, f] of req.files.entries()) {
            let key: string;
            try {
                key = canonicalEvidenceKey(f.contentRef);
            } catch {
                key = '';
            }
            if (!key || key.split('/')[0] !== this.run.organizationId) return { code: 'upload_failed', stepId: req.stepId, reason: `files[${i}].contentRef is not an object of this org` };
            files.push({ ...f, url: evidenceReadUrl(this.run.evidenceReads, key) });
        }
        const r = await this.onClaim<{ ok?: boolean; code?: string }>(claimId, '/upload', { stepId: req.stepId, files }, TIMEOUT.step(UPLOAD_TIMEOUT_MS));
        if (r && 'code' in r && r.code) return r as EnvError;
    }

    /** status of an environment of this client's org only; another org's reads as never set up. */
    async status(req: { organizationId: string; environmentId: string }): Promise<EnvironmentHealth> {
        const none = environmentHealthOf({ environmentId: req.environmentId }, new Date());
        if (req.organizationId !== this.run.organizationId || !this.run.health) return none;
        return this.run.health(req.organizationId, req.environmentId);
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
