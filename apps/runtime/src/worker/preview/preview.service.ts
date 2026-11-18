import { metrics as otel } from '@opentelemetry/api';

import { claimHeldMinutes } from '@libs/runtime/api/domain/run-cost';
import {
    DEFAULT_PREVIEW_POLICY,
    isOpenPreviewState,
    newPreviewHostLabel,
    PREVIEW_CAP_CODE,
    PREVIEW_CEILING_MINUTES,
    PREVIEW_IDLE_MINUTES,
    PREVIEW_OFF_CODE,
    PREVIEW_REASONS,
    PREVIEW_RECORD_DAYS,
    type PreviewOpen,
    type PreviewRef,
    type PreviewState,
    type PreviewView,
    previewHost,
    previewTokenBinding,
} from '@libs/runtime/contracts/preview';
import { type Claim, type EnvironmentRuntime, isBlocked, isEnvError } from '@libs/runtime/environment';
import type { ClaimCanary } from '@libs/runtime/protocol';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';
import { safeFailure } from '@libs/runtime/telemetry/failure';
import { CatalogMeter } from '@libs/runtime/telemetry/instruments';

import type { PreviewRow, PreviewStore } from '../../shared/persistence/preview-store';
import { acquireWaitingForRoom } from '../env/capacity-wait';
import type { EnvSessionEnvironmentInput } from '../env-session/env-session.service';

// The worker side of preview URLs (docs/runtime/preview-urls.md §5): one
// claim of consumer preview per start of a preview, booted from the
// environment's recorded setup at the Run's commit for that side, never the
// Run's own machines. The API opens and stops through the env-session
// listener; the edge writes only activity and wake requests, which each
// worker's tick reads. Every state change is a conditional update, so two
// replicas never both start or stop the same preview.

export const PREVIEW_SERVICE = Symbol('PREVIEW_SERVICE');

export class PreviewError extends Error {
    constructor(
        readonly status: 404 | 409 | 429 | 503,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

const notFound = () => new PreviewError(404, 'not_found', 'no such preview');
const MINUTE = 60_000;
/** A wake opens the token the API sealed at its last open; past this, it asks to be opened again from Kodus (the token lasts 1 h). */
export const PREVIEW_TOKEN_WAKE_MS = 50 * MINUTE;
/** A start that has not settled after this long lost its worker: blocked, the next open retries. */
const START_LOST_MS = 45 * MINUTE;
/** Renew the claim's lease when it ends within this, if the preview had traffic. */
const RENEW_BEFORE_MS = 5 * MINUTE;
/** A ready preview whose cell has no tunnel at an edge for this long gets its route (and a tunnel ticket) again. */
const TUNNEL_STALE_MS = 90_000;
const REROUTE_EVERY_MS = 30_000;
const TICK_BATCH = 200;

export interface PreviewHubPort {
    /** preview.tunnel then preview.route for this claim (hub internal route); false: the cell refused. */
    route(claim: { claimId: string; organizationId: string }, body: { previewId: string; target: { service: string; port: number }; until: string }): Promise<boolean>;
    unroute(claim: { claimId: string; organizationId: string }, previewId: string): Promise<void>;
}

export interface PreviewDeps {
    store: PreviewStore;
    setups: { get(environmentId: string): Promise<EnvironmentSetupRecord | null> };
    environment: (input: EnvSessionEnvironmentInput) => EnvironmentRuntime;
    hub: PreviewHubPort;
    isStopped: (organizationId: string) => Promise<boolean>;
    /** RUNTIME_PREVIEW_DOMAIN; absent, previews are off (decision 1). */
    domain?: string;
    /** The decoys (ADR-043) one start of a preview plants: a canary or a placeholder crossing the egress boundary compromises its claim. */
    canaries?: (previewId: string, start: number) => ClaimCanary[];
    now?: () => Date;
    /** Overrides every preview's idle stop (tests). */
    idleMs?: number;
    capacityWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    hostLabel?: typeof newPreviewHostLabel;
    log?: (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown>) => void;
    meter?: CatalogMeter;
}

export function previewView(row: PreviewRow): PreviewView {
    return {
        previewId: row.previewId,
        ...(row.runId ? { runId: row.runId } : {}),
        environmentId: row.environmentId,
        repositoryId: row.repositoryId,
        side: row.side,
        sha: row.sha,
        host: row.host,
        state: row.state,
        openedBy: row.openedBy,
        ...(row.reason ? { reason: row.reason } : {}),
        withoutSecrets: row.withoutSecrets,
        idleMinutes: row.idleMinutes ?? PREVIEW_IDLE_MINUTES,
        ceilingMinutes: row.ceilingMinutes ?? PREVIEW_CEILING_MINUTES,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        ...(row.lastActivityAt ? { lastActivityAt: row.lastActivityAt } : {}),
        ...(row.state === 'ready' && row.readyAt ? { readyAt: row.readyAt } : {}),
    };
}

/** The first instant of the UTC month `at` is in: the monthly cap counts from it (as the usage report's month). */
const monthStartOf = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();

/** The policy of an open, as the row keeps it: a secret-holding claim never on a fork's PR side. */
function policyColumns(req: PreviewOpen) {
    const p = req.policy ?? DEFAULT_PREVIEW_POLICY;
    const fork = p.forkPullRequest && req.side === 'pr';
    return {
        idleMinutes: p.idleMinutes,
        ceilingMinutes: p.ceilingMinutes,
        monthlyMachineMinutes: p.monthlyMachineMinutes,
        forkPullRequest: fork,
        withoutSecrets: !p.secrets || fork,
    };
}

const firstHttp = (claim: Claim) => claim.manifest.expose.find((e) => e.kind === 'http');

export class PreviewService {
    private readonly now: () => Date;
    private readonly meter: CatalogMeter;
    private readonly transitions;
    private readonly wakeDuration;
    readonly inFlight = new Set<Promise<unknown>>();

    constructor(private readonly deps: PreviewDeps) {
        this.now = deps.now ?? (() => new Date());
        this.meter = deps.meter ?? new CatalogMeter(otel.getMeter('kody-runtime'));
        this.transitions = this.meter.counter('runtime.preview.transitions');
        this.wakeDuration = this.meter.histogram('runtime.preview.wake_duration');
    }

    private log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown>) {
        this.deps.log?.(level, msg, fields);
    }

    private track<T>(p: Promise<T>): Promise<T> {
        this.inFlight.add(p);
        // The caller holds `p` and handles its rejection; this copy only must not be unhandled.
        void p.finally(() => this.inFlight.delete(p)).catch(() => undefined);
        return p;
    }

    async settle() {
        while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
    }

    private entered(row: Pick<PreviewRow, 'organizationId'>, state: PreviewState) {
        this.transitions.add(1, { state, 'kodus.organization.id': row.organizationId });
    }

    /** POST /preview/open: the preview of one side of a Run (or an environment's own), created on the first open and started again on a later one. */
    async open(req: PreviewOpen): Promise<PreviewView> {
        if (!this.deps.domain) {
            throw new PreviewError(409, PREVIEW_OFF_CODE, 'Previews are off on this deployment. Set RUNTIME_PREVIEW_DOMAIN to a domain other than the one Kodus runs on.');
        }
        if (await this.deps.isStopped(req.organizationId)) {
            throw new PreviewError(409, 'runtime_stopped', 'The Runtime is stopped for this organization; no preview starts until an admin clears the stop.');
        }
        const at = this.now().toISOString();
        const policy = policyColumns(req);
        const existing = await this.deps.store.getPreview(req.organizationId, req.previewId);
        if (existing) {
            if (existing.runId !== req.runId || existing.side !== req.side || existing.repositoryId !== req.repositoryId) throw notFound();
            const row = await this.expireIfDue(existing);
            if (row.state === 'expired') throw new PreviewError(409, 'preview_expired', row.reason ?? PREVIEW_REASONS.record);
            const restarts = row.state === 'sleeping' || row.state === 'blocked' || row.state === 'stopped';
            if (restarts && (await this.capReached(row.organizationId, policy.monthlyMachineMinutes))) throw new PreviewError(409, PREVIEW_CAP_CODE, PREVIEW_REASONS.cap);
            // A fresh token for this open and any wake within the next 50 minutes; the org's settings as they are now.
            await this.deps.store.updatePreview(row.organizationId, row.previewId, { ...policy, sealedRepoToken: req.sealedRepoToken, tokenSealedAt: at, updatedAt: at });
            if (restarts) await this.startAgain({ ...row, ...policy }, row.state === 'sleeping' ? 'woken' : 'started', req.openedBy);
            return previewView((await this.deps.store.getPreview(req.organizationId, req.previewId)) ?? row);
        }
        if (await this.capReached(req.organizationId, policy.monthlyMachineMinutes)) throw new PreviewError(409, PREVIEW_CAP_CODE, PREVIEW_REASONS.cap);
        const label = (this.deps.hostLabel ?? newPreviewHostLabel)(req.side);
        const row: PreviewRow = {
            previewId: req.previewId,
            organizationId: req.organizationId,
            environmentId: req.environmentId,
            repositoryId: req.repositoryId,
            repositoryFullName: req.repositoryFullName,
            ...(req.runId ? { runId: req.runId } : {}),
            ...(req.prNumber ? { prNumber: req.prNumber } : {}),
            side: req.side,
            sha: req.sha,
            host: previewHost(label, this.deps.domain),
            state: 'starting',
            openedBy: req.openedBy,
            ...policy,
            starts: 1,
            sealedRepoToken: req.sealedRepoToken,
            tokenSealedAt: at,
            createdAt: at,
            updatedAt: at,
            expiresAt: new Date(this.now().getTime() + PREVIEW_RECORD_DAYS * 24 * 60 * MINUTE).toISOString(),
        };
        if (!(await this.deps.store.insertPreview(row))) {
            // Another open won the insert: answer what it made.
            const won = await this.deps.store.getPreview(req.organizationId, req.previewId);
            if (!won) throw notFound();
            return previewView(won);
        }
        this.entered(row, 'starting');
        await this.deps.store.audit({ organizationId: row.organizationId, previewId: row.previewId, ...(row.runId ? { runId: row.runId } : {}), side: row.side, actor: req.openedBy, action: 'started' });
        this.log('info', 'preview.open', { previewId: row.previewId, runId: row.runId, side: row.side });
        // An environment's preview of a newer bake replaces the older one.
        if (!row.runId) {
            for (const old of await this.deps.store.openEnvironmentPreviews(row.organizationId, row.environmentId)) {
                if (old.previewId !== row.previewId) await this.end(old, 'expired', PREVIEW_REASONS.newerSetup);
            }
        }
        void this.track(this.start(row, this.now().getTime()));
        return previewView(row);
    }

    /**
     * A newer Run of the pull request (keepRunId: its own previews stay) or the
     * pull request closing ends its Runs' previews (§5.2): their machines go
     * back and their sessions end; the host says why.
     */
    async expirePullRequest(input: { organizationId: string; repositoryId: string; prNumber: number; keepRunId?: string; why: 'newer_run' | 'pr_closed' }): Promise<number> {
        let n = 0;
        for (const row of await this.deps.store.openPreviewsOfPullRequest(input.organizationId, input.repositoryId, input.prNumber)) {
            if (input.keepRunId && row.runId === input.keepRunId) continue;
            if (await this.end(row, 'expired', input.why === 'pr_closed' ? PREVIEW_REASONS.prClosed : PREVIEW_REASONS.newerRun)) n++;
        }
        return n;
    }

    /** Whether the org's preview claims of this UTC month reached the cap (machine-minutes, as the usage report counts them). */
    private async capReached(organizationId: string, cap: number | undefined): Promise<boolean> {
        if (!cap) return false;
        const now = this.now();
        const claims = await this.deps.store.previewClaimsSince(organizationId, monthStartOf(now));
        const used = claims.reduce((sum, c) => sum + (claimHeldMinutes(c, now) ?? 0), 0);
        return used >= cap;
    }

    async status(ref: PreviewRef): Promise<PreviewView> {
        const row = await this.deps.store.getPreview(ref.organizationId, ref.previewId);
        if (!row) throw notFound();
        return previewView(await this.expireIfDue(row));
    }

    /** POST /preview/stop: the opener or an owner (checked by the API). Ends its claim and its sessions. */
    async stop(ref: PreviewRef): Promise<PreviewView> {
        const row = await this.deps.store.getPreview(ref.organizationId, ref.previewId);
        if (!row) throw notFound();
        if (!isOpenPreviewState(row.state)) return previewView(row);
        await this.end(row, 'stopped', PREVIEW_REASONS.stopped, ref.actor);
        return previewView({ ...row, state: 'stopped', reason: PREVIEW_REASONS.stopped });
    }

    /** One worker tick: wake what a viewer asked for, sleep what is idle, renew what is used, heal lost tunnels, expire old records. */
    async tick(): Promise<{ woken: number; slept: number; renewed: number; rerouted: number; expired: number }> {
        const out = { woken: 0, slept: 0, renewed: 0, rerouted: 0, expired: 0 };
        const now = this.now().getTime();
        const rows = await this.deps.store.listOpenPreviews(TICK_BATCH);
        // A security event on a live preview claim stops it before anything else (§5.3), as a Run halts on one.
        const live = rows.filter((r) => r.claimId && (r.state === 'ready' || r.state === 'starting'));
        // An unreadable security read stops nothing this tick (the next reads again, and a renew still answers a violation), but it is told.
        const violations = live.length
            ? await this.deps.store.securityViolations(live.map((r) => ({ organizationId: r.organizationId, claimId: r.claimId! }))).catch((e) => {
                  this.log('error', 'preview.security_read_failed', { claims: live.length, error: safeFailure(e) });
                  return new Map<string, string>();
              })
            : new Map<string, string>();
        for (const row of rows) {
            try {
                const signature = row.claimId ? violations.get(row.claimId) : undefined;
                if (signature) {
                    await this.securityStop(row, signature);
                    continue;
                }
                if (Date.parse(row.expiresAt) <= now) {
                    await this.expireIfDue(row);
                    out.expired++;
                    continue;
                }
                if ((row.state === 'sleeping' || row.state === 'blocked') && row.wakeRequestedAt) {
                    if (await this.wake(row)) out.woken++;
                    continue;
                }
                if (row.state === 'starting' && now - Date.parse(row.updatedAt) > START_LOST_MS) {
                    await this.deps.store.updatePreview(row.organizationId, row.previewId, { state: 'blocked', reason: 'The preview did not finish starting. Open it again.', updatedAt: this.now().toISOString() }, ['starting']);
                    this.entered(row, 'blocked');
                    continue;
                }
                if (row.state !== 'ready' || !row.claimId) continue;
                const lastUse = Date.parse(row.lastActivityAt ?? row.readyAt ?? row.updatedAt);
                const ceilingMs = (row.ceilingMinutes ?? PREVIEW_CEILING_MINUTES) * MINUTE;
                const atCeiling =
                    (!!row.claimHardExpiresAt && Date.parse(row.claimHardExpiresAt) - now < MINUTE) || (!!row.readyAt && now - Date.parse(row.readyAt) >= ceilingMs);
                if (now - lastUse >= (this.deps.idleMs ?? (row.idleMinutes ?? PREVIEW_IDLE_MINUTES) * MINUTE) || atCeiling) {
                    if (await this.sleepOne(row, atCeiling ? 'ceiling' : 'idle')) out.slept++;
                    continue;
                }
                // Not idle (above), so it had traffic within the idle window: keep its claim.
                if (row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) - now < RENEW_BEFORE_MS) {
                    if (await this.renew(row)) out.renewed++;
                    continue;
                }
                if (row.cellId && (!row.routedAt || now - Date.parse(row.routedAt) > REROUTE_EVERY_MS) && !(await this.deps.store.tunnelHeld(row.cellId, new Date(now - TUNNEL_STALE_MS).toISOString()))) {
                    if (await this.route(row, row.claimId, row.target!, row.leaseExpiresAt!)) out.rerouted++;
                }
            } catch (e) {
                this.log('warn', 'preview.tick_failed', { previewId: row.previewId, error: (e as Error).message.slice(0, 200) });
            }
        }
        return out;
    }

    private async expireIfDue(row: PreviewRow): Promise<PreviewRow> {
        if (!isOpenPreviewState(row.state) || Date.parse(row.expiresAt) > this.now().getTime()) return row;
        const reason = PREVIEW_REASONS.record;
        await this.end(row, 'expired', reason);
        return { ...row, state: 'expired', reason };
    }

    private async wake(row: PreviewRow): Promise<boolean> {
        const tokenAge = row.tokenSealedAt ? this.now().getTime() - Date.parse(row.tokenSealedAt) : Infinity;
        if (tokenAge > PREVIEW_TOKEN_WAKE_MS) {
            // The download token the last open sealed is too old for a boot: the viewer opens it again from Kodus.
            await this.deps.store.updatePreview(row.organizationId, row.previewId, { wakeRequestedAt: undefined, reason: 'reopen', updatedAt: this.now().toISOString() }, ['sleeping', 'blocked']);
            return false;
        }
        if (await this.capReached(row.organizationId, row.monthlyMachineMinutes)) {
            // Past the month's cap a wake boots nothing; the host says why and the next open checks again.
            if (await this.deps.store.updatePreview(row.organizationId, row.previewId, { state: 'blocked', wakeRequestedAt: undefined, reason: PREVIEW_REASONS.cap, updatedAt: this.now().toISOString() }, ['sleeping', 'blocked'])) {
                if (row.state !== 'blocked') this.entered(row, 'blocked');
            }
            return false;
        }
        return this.startAgain(row, 'woken');
    }

    /**
     * The cell reported a security violation on this preview's claim (a canary
     * or a placeholder crossed the egress boundary): the preview stops, every
     * session ends, the route goes, and the claim's machines stay as evidence
     * until its lease ends, as a halted Run's do (§5.3).
     */
    private async securityStop(row: PreviewRow, signature: string) {
        const at = this.now().toISOString();
        const moved = await this.deps.store.updatePreview(
            row.organizationId,
            row.previewId,
            { state: 'stopped', reason: PREVIEW_REASONS.security, wakeRequestedAt: undefined, routedAt: undefined, sealedRepoToken: undefined, updatedAt: at },
            ['starting', 'ready', 'sleeping', 'blocked'],
        );
        if (!moved) return;
        this.entered(row, 'stopped');
        if (row.claimId) await this.unroute(row, row.claimId);
        await this.deps.store.closeSessionsOf(row.previewId, at);
        await this.deps.store.audit({ organizationId: row.organizationId, previewId: row.previewId, ...(row.runId ? { runId: row.runId } : {}), side: row.side, action: 'stopped', reason: 'security_event' });
        this.log('error', 'preview.stopped', { previewId: row.previewId, claimId: row.claimId, why: 'security_event', signature });
    }

    private async startAgain(row: PreviewRow, action: 'woken' | 'started', actor?: string): Promise<boolean> {
        const at = this.now();
        const moved = await this.deps.store.updatePreview(
            row.organizationId,
            row.previewId,
            { state: 'starting', starts: row.starts + 1, wakeRequestedAt: undefined, reason: undefined, claimId: undefined, cellId: undefined, target: undefined, leaseExpiresAt: undefined, claimHardExpiresAt: undefined, readyAt: undefined, routedAt: undefined, updatedAt: at.toISOString() },
            [row.state],
        );
        if (!moved) return false;
        this.entered(row, 'starting');
        await this.deps.store.audit({ organizationId: row.organizationId, previewId: row.previewId, ...(row.runId ? { runId: row.runId } : {}), side: row.side, ...(actor ? { actor } : {}), action });
        this.log('info', action === 'woken' ? 'preview.wake' : 'preview.open', { previewId: row.previewId, runId: row.runId, side: row.side });
        const fresh = (await this.deps.store.getPreview(row.organizationId, row.previewId))!;
        void this.track(this.start(fresh, at.getTime()));
        return true;
    }

    private env(row: PreviewRow, setup?: EnvironmentSetupRecord) {
        return this.deps.environment({
            correlationId: `preview:${row.previewId}`,
            organizationId: row.organizationId,
            fullName: row.repositoryFullName,
            sealedRepoToken: row.sealedRepoToken ?? '',
            tokenBinding: previewTokenBinding(row.previewId),
            imageId: setup?.imageId ?? 'latest',
            expose: setup?.expose ?? [],
        });
    }

    private async block(row: PreviewRow, reason: string) {
        if (await this.deps.store.updatePreview(row.organizationId, row.previewId, { state: 'blocked', reason: reason.slice(0, 500), updatedAt: this.now().toISOString() }, ['starting'])) {
            this.entered(row, 'blocked');
            this.log('warn', 'preview.blocked', { previewId: row.previewId, reason: reason.slice(0, 120) });
        }
    }

    /** Boots one claim for the preview and routes it; any outcome but ready leaves it blocked with the reason. */
    private async start(row: PreviewRow, startedAt: number) {
        const loaded = await this.deps.setups.get(row.environmentId);
        const setup = loaded ? structuredClone(loaded) : null;
        if (!setup || setup.organizationId !== row.organizationId || setup.repositoryId !== row.repositoryId) return this.block(row, 'This environment was never set up.');
        if (setup.state !== 'active') return this.block(row, `The environment setup is ${setup.state}; fix it before opening a preview.`);
        const env = this.env(row, setup);
        const canaries = this.deps.canaries?.(row.previewId, row.starts) ?? [];
        const recipe = setup.recipe
            ? {
                  path: setup.recipe.path,
                  content: setup.recipe.state === 'found' && typeof setup.recipe.content === 'string' ? setup.recipe.content : null,
                  ...(setup.recipe.digest ? { digest: setup.recipe.digest } : {}),
                  // Kody's build files from the setup's record, as a Run boots them (run-requested.handler.ts): an authored
                  // recipe's compose file is not in the repository, and without them the cell answers compose_load.
                  ...(setup.recipe.state === 'found' && typeof setup.recipe.content === 'string' && setup.recipe.files?.length ? { files: setup.recipe.files } : {}),
              }
            : undefined;
        let claim: Claim;
        try {
            const r = await acquireWaitingForRoom(
                env,
                {
                    organizationId: row.organizationId,
                    environmentId: row.environmentId,
                    imageId: setup.imageId ?? 'latest',
                    // The Run's side and commit; the side's egress policy comes with it (a PR side gets test-phase egress only).
                    ref: { side: row.side, sha: row.sha },
                    consumer: 'preview',
                    idempotencyKey: `preview:${row.previewId}:${row.starts}`,
                    ...(recipe ? { recipe } : {}),
                    ...(setup.machineSize ? { size: setup.machineSize } : {}),
                    // A fork's PR side: none of the environment's approved hosts, none of the org's secrets.
                    ...(row.forkPullRequest ? { forkPullRequest: true } : {}),
                    // The org's secrets as placeholders only when an owner set the environment to "same as the Run".
                    ...(!row.withoutSecrets && !row.forkPullRequest ? { previewSecrets: true } : {}),
                    ...(canaries.length ? { canaries } : {}),
                },
                { until: this.now().getTime() + (this.deps.capacityWaitMs ?? 10 * MINUTE), now: this.now, ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}) },
            );
            if (isBlocked(r.claim)) {
                const capacity = 'capacity' in r.claim && r.claim.capacity;
                return this.block(row, capacity ? 'No capacity right now. Open it again in a few minutes.' : (r.claim.blockers[0]?.message ?? 'The preview did not boot.'));
            }
            claim = r.claim;
        } catch (e) {
            this.log('warn', 'preview.start_failed', { previewId: row.previewId, error: safeFailure(e) });
            return this.block(row, 'No cell could take this preview now. Open it again in a minute.');
        }
        const current = await this.deps.store.getPreview(row.organizationId, row.previewId);
        if (!current || current.state !== 'starting' || current.starts !== row.starts) {
            // Stopped (or started again) while booting: give the machines back at once.
            await this.giveBack(env, row, claim.claimId);
            return;
        }
        const target = firstHttp(claim);
        if (!target) {
            await this.giveBack(env, row, claim.claimId);
            return this.block(row, 'The environment exposes no http service to open.');
        }
        await this.deps.store.updatePreview(row.organizationId, row.previewId, {
            claimId: claim.claimId,
            cellId: claim.cellId,
            target: { service: target.service, port: target.port },
            leaseExpiresAt: claim.leaseExpiresAt,
            claimHardExpiresAt: claim.hardExpiresAt,
            updatedAt: this.now().toISOString(),
        }, ['starting']);
        if (!(await this.route(row, claim.claimId, target, claim.leaseExpiresAt))) {
            await this.giveBack(env, row, claim.claimId);
            return this.block(row, 'The cell refused to serve the preview.');
        }
        const at = this.now().toISOString();
        if (!(await this.deps.store.updatePreview(row.organizationId, row.previewId, { state: 'ready', readyAt: at, lastActivityAt: at, updatedAt: at }, ['starting']))) {
            await this.unroute(row, claim.claimId);
            await this.giveBack(env, row, claim.claimId);
            return;
        }
        this.entered(row, 'ready');
        this.wakeDuration.record(this.now().getTime() - startedAt);
        this.log('info', 'preview.ready', { previewId: row.previewId, claimId: claim.claimId, cellId: claim.cellId });
    }

    private async route(row: PreviewRow, claimId: string, target: { service: string; port: number }, until: string): Promise<boolean> {
        let ok = false;
        try {
            ok = await this.deps.hub.route({ claimId, organizationId: row.organizationId }, { previewId: row.previewId, target: { service: target.service, port: target.port }, until });
        } catch (e) {
            this.log('warn', 'preview.route_failed', { previewId: row.previewId, claimId, error: (e as Error).message.slice(0, 200) });
        }
        if (ok) await this.deps.store.updatePreview(row.organizationId, row.previewId, { routedAt: this.now().toISOString() });
        return ok;
    }

    private async renew(row: PreviewRow): Promise<boolean> {
        const env = this.env(row);
        const r = env.renew ? await env.renew(row.claimId!, 'preview') : undefined;
        if (r && isEnvError(r) && r.code === 'security_violation') {
            await this.securityStop(row, r.signature);
            return false;
        }
        if (!r || isEnvError(r) || r.status === 'gone') {
            await this.sleepOne(row, 'lease_lost');
            return false;
        }
        await this.deps.store.updatePreview(row.organizationId, row.previewId, { leaseExpiresAt: r.leaseExpiresAt, claimHardExpiresAt: r.hardExpiresAt, updatedAt: this.now().toISOString() }, ['ready']);
        // The cell refuses a route past its `until`: declare it again to the new lease end.
        await this.route(row, row.claimId!, row.target!, r.leaseExpiresAt);
        return true;
    }

    /** ready → sleeping: the claim goes back; the record and its sessions stay, so the next request wakes it. */
    private async sleepOne(row: PreviewRow, why: 'idle' | 'ceiling' | 'lease_lost'): Promise<boolean> {
        const moved = await this.deps.store.updatePreview(
            row.organizationId,
            row.previewId,
            { state: 'sleeping', reason: undefined, claimId: undefined, cellId: undefined, target: undefined, leaseExpiresAt: undefined, claimHardExpiresAt: undefined, routedAt: undefined, updatedAt: this.now().toISOString() },
            ['ready'],
        );
        if (!moved) return false;
        this.entered(row, 'sleeping');
        await this.releaseClaim(row);
        await this.deps.store.audit({ organizationId: row.organizationId, previewId: row.previewId, ...(row.runId ? { runId: row.runId } : {}), side: row.side, action: 'slept', reason: why });
        this.log('info', 'preview.slept', { previewId: row.previewId, why });
        return true;
    }

    private async end(row: PreviewRow, state: 'stopped' | 'expired', reason: string, actor?: string): Promise<boolean> {
        const at = this.now().toISOString();
        const moved = await this.deps.store.updatePreview(
            row.organizationId,
            row.previewId,
            { state, reason, wakeRequestedAt: undefined, claimId: undefined, cellId: undefined, target: undefined, leaseExpiresAt: undefined, claimHardExpiresAt: undefined, routedAt: undefined, sealedRepoToken: undefined, updatedAt: at },
            ['starting', 'ready', 'sleeping', 'blocked'],
        );
        if (!moved) return false;
        this.entered(row, state);
        await this.releaseClaim(row);
        await this.deps.store.closeSessionsOf(row.previewId, at);
        await this.deps.store.audit({ organizationId: row.organizationId, previewId: row.previewId, ...(row.runId ? { runId: row.runId } : {}), side: row.side, ...(actor ? { actor } : {}), action: state });
        this.log('info', state === 'stopped' ? 'preview.stopped' : 'preview.expired', { previewId: row.previewId });
        return true;
    }

    private async releaseClaim(row: PreviewRow) {
        if (!row.claimId) return;
        await this.unroute(row, row.claimId);
        try {
            await this.env(row).release(row.claimId);
        } catch (e) {
            // The lease (15 min) and the reaper take the machines back.
            this.log('warn', 'preview.release_failed', { previewId: row.previewId, claimId: row.claimId, error: (e as Error).message.slice(0, 200) });
        }
    }

    /** Gives a claim back on a path that already ends the start; a failure is told, and the lease and the reaper take the machines back. */
    private async giveBack(env: EnvironmentRuntime, row: PreviewRow, claimId: string) {
        await env.release(claimId).catch((e) => this.log('warn', 'preview.release_failed', { previewId: row.previewId, claimId, error: safeFailure(e) }));
    }

    /** Takes the preview's route off its cell; a failure is told, and the route still ends at its `until` (the lease end). */
    private async unroute(row: PreviewRow, claimId: string) {
        await this.deps.hub.unroute({ claimId, organizationId: row.organizationId }, row.previewId).catch((e) => this.log('warn', 'preview.unroute_failed', { previewId: row.previewId, claimId, error: safeFailure(e) }));
    }
}
