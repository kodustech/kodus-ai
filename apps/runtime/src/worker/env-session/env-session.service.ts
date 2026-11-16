import { createHash, randomUUID } from 'crypto';
import { evidenceKey } from '@libs/runtime/contracts/evidence';
import { UPLOAD_PATH } from '@libs/runtime/protocol/messages';
import { parseRecipe } from '@libs/runtime/protocol/recipe';
import { RecipeValidationSnapshotSchema } from '@libs/runtime/contracts/recipe-validation';
import type {EnvValidationResolution} from '@libs/runtime/contracts/env-session';
import {
    ENV_SESSION_IDLE_MS,
    ENV_SESSION_MAX_LIVE_PER_KEY,
    ENV_SESSION_MAX_LIVE_PER_ORG,
    ENV_SESSION_OPEN_WAIT_MS,
    ENV_STEP_LOST_AFTER_MS,
    ENV_UPLOAD_MAX_BYTES,
    envSessionTokenBinding,
    type EnvSessionExec,
    type EnvSessionOpen,
    type EnvSessionOwner,
    type EnvSessionRepositoryView,
    type EnvSessionUpload,
    type EnvSessionView,
    type EnvStepView,
    type EnvUploadView,
    isLiveEnvSession,
    ownsEnvSession,
} from '@libs/runtime/contracts/env-session';
import { type Claim, type EnvironmentRuntime, isBlocked, isEnvError } from '@libs/runtime/environment';
import type { ClaimWorkspace, EnvironmentSetupRecord, WorkspaceClaimRepo } from '@libs/runtime/run';
import { safeFailure } from '@libs/runtime/telemetry/failure';

import type { EvidenceStore } from '../../shared/evidence/file-evidence-store';
import { acquireWaitingForRoom } from '../env/capacity-wait';
import type { EnvSessionRow, EnvSessionStore, EnvStepRow } from './env-session.store';

// The worker side of /mcp/env (§4 "MCP e CLI", Inc. 1): one claim per
// session with consumer mcp, booted from the environment's recorded setup
// (the default branch's recipe and expose, never the checkout's). exec does
// not wait for the command: the step runs in the background and its result is
// read later by stepId. Every call names the owner (org, team, key and the
// repos the key reaches now) and a row of anyone else answers 404 before anything reaches the hub (S-46).

export const ENV_SESSION_SERVICE = Symbol('ENV_SESSION_SERVICE');

export class EnvSessionError extends Error {
    constructor(
        readonly status: 404 | 409 | 429 | 503,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

const notFound = () => new EnvSessionError(404, 'not_found', 'no such session');

/**
 * The ownership rule of the contract plus, for a multi-repository session,
 * every repository of it: the key must still reach each one (its list can
 * shrink between calls), or the session reads as absent.
 */
const ownsSession = (row: Pick<EnvSessionRow, 'organizationId' | 'teamId' | 'keyId' | 'repositoryId' | 'repositories'>, owner: EnvSessionOwner) =>
    ownsEnvSession(row, owner) && (row.repositories ?? []).every((r) => owner.repositoryIds.includes(r.repositoryId));

/** A multi-repository open's workspace as the environment boots it: each repository at its commit with its own sealed token, on both sides (a session runs the PR side). */
function sessionClaimWorkspace(req: EnvSessionOpen): ClaimWorkspace | undefined {
    if (!req.workspace) return undefined;
    const repo = (r: NonNullable<EnvSessionOpen['workspace']>[number]): WorkspaceClaimRepo => ({
        repositoryId: r.repositoryId,
        fullName: r.fullName,
        alias: r.alias,
        base: { sha: r.sha, sealedToken: r.sealedRepoToken },
        pr: { sha: r.sha, sealedToken: r.sealedRepoToken },
    });
    const primary = req.workspace.find((r) => r.role === 'primary');
    if (!primary) throw new Error('the session workspace has no primary repository');
    return { primary: repo(primary), members: req.workspace.filter((r) => r.role !== 'primary').map(repo) };
}

/** The layout of a multi-repository open, primary first, without any token. */
function sessionLayout(req: EnvSessionOpen): EnvSessionRepositoryView[] | undefined {
    if (!req.workspace) return undefined;
    const ordered = [...req.workspace.filter((r) => r.role === 'primary'), ...req.workspace.filter((r) => r.role !== 'primary')];
    return ordered.map((r) => ({ repositoryId: r.repositoryId, fullName: r.fullName, alias: r.alias, role: r.role, sha: r.sha }));
}
/** Output kept per stream; the cell already redacts and bounds what it sends. */
const MAX_OUTPUT = 64 * 1024;
const STALE_BATCH = 50;

export interface EnvSessionEnvironmentInput {
    correlationId: string;
    organizationId: string;
    fullName: string;
    sealedRepoToken: string;
    tokenBinding: string;
    imageId: string;
    expose: Claim['manifest']['expose'];
    /** The repositories of a multi-repository session, tokens sealed to tokenBinding; absent for one repository. */
    workspace?: ClaimWorkspace;
}

export interface EnvSessionDeps {
    store: EnvSessionStore;
    setups: { get(environmentId: string): Promise<EnvironmentSetupRecord | null> };
    environment: (input: EnvSessionEnvironmentInput) => EnvironmentRuntime;
    isStopped: (organizationId: string) => Promise<boolean>;
    now?: () => Date;
    openWaitMs?: number;
    idleMs?: number;
    /** How long an env_up waits for room on a cell before it is blocked (ADR-070); 10 min when absent. */
    capacityWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onWarn?: (msg: string, meta: Record<string, unknown>) => void;
    /** Where env_upload keeps a call's files for the cell to read (the Runs' evidence store); absent: upload_unavailable. */
    evidence?: Pick<EvidenceStore, 'put'>;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const invalidUpload = (why: string) => new EnvSessionError(409, 'invalid_upload', why);

/** The decoded files of one env_upload, or invalid_upload naming the first that cannot go. */
function uploadFilesOf(files: EnvSessionUpload['files']): Array<{ path: string; body: Buffer; mode?: number }> {
    const seen = new Set<string>();
    let total = 0;
    return files.map((f, i) => {
        if (!UPLOAD_PATH.test(f.path)) throw invalidUpload(`files[${i}].path must be relative to the checkout, without . or .. segments`);
        if (seen.has(f.path)) throw invalidUpload(`files[${i}].path names ${f.path.slice(0, 200)} twice`);
        seen.add(f.path);
        if (!BASE64.test(f.contentBase64)) throw invalidUpload(`files[${i}].contentBase64 is not base64`);
        const body = Buffer.from(f.contentBase64, 'base64');
        total += body.length;
        if (total > ENV_UPLOAD_MAX_BYTES) throw invalidUpload(`one env_upload takes at most ${ENV_UPLOAD_MAX_BYTES} bytes; split the files over several calls`);
        return { path: f.path, body, ...(f.mode !== undefined ? { mode: f.mode } : {}) };
    });
}

export function envSessionView(row: EnvSessionRow): EnvSessionView {
    return {
        sessionId: row.sessionId,
        environmentId: row.environmentId,
        repositoryId: row.repositoryId,
        sha: row.sha,
        state: row.state,
        ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
        ...(row.services ? { services: row.services } : {}),
        ...(row.repositories?.length ? { repositories: row.repositories } : {}),
        ...(row.blockers?.length ? { blockers: row.blockers } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
    };
}

const clip = (s: string | undefined) => (s && s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) : (s ?? ''));

export class EnvSessionService {
    private readonly now: () => Date;
    /** Acquires and execs started by this replica; awaited only by tests and shutdown. */
    readonly inFlight = new Set<Promise<unknown>>();

    constructor(private readonly deps: EnvSessionDeps) {
        this.now = deps.now ?? (() => new Date());
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

    private env(row: Pick<EnvSessionRow, 'organizationId' | 'sessionId'>, extra?: Partial<EnvSessionEnvironmentInput>) {
        return this.deps.environment({
            correlationId: `mcp:${row.sessionId}`,
            organizationId: row.organizationId,
            fullName: 'mcp/session',
            sealedRepoToken: '',
            tokenBinding: envSessionTokenBinding(row.sessionId),
            imageId: 'latest',
            expose: [],
            ...extra,
        });
    }

    private async load(owner: EnvSessionOwner, sessionId: string): Promise<EnvSessionRow> {
        const row = await this.deps.store.get(owner.organizationId, sessionId);
        if (!row || !ownsSession(row, owner)) throw notFound();
        return this.expireIfStale(row);
    }

    /** A live session past its idle limit or its lease is released here, so a late call learns it ended. */
    private async expireIfStale(row: EnvSessionRow): Promise<EnvSessionRow> {
        if (!isLiveEnvSession(row.state)) return row;
        const now = this.now();
        const idle = now.getTime() - Date.parse(row.lastUsedAt) > (this.deps.idleMs ?? ENV_SESSION_IDLE_MS);
        const leaseOver = !!row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) <= now.getTime();
        if (!idle && !leaseOver) return row;
        const reason = leaseOver
            ? 'The session lease ended (2 h). Call env_up again.'
            : 'The session was idle for 10 minutes and was released. Call env_up again.';
        await this.end(row, 'expired', reason);
        return { ...row, state: 'expired', reason };
    }

    private async end(row: EnvSessionRow, state: 'released' | 'expired', reason?: string) {
        await this.deps.store.update(row.organizationId, row.sessionId, { state, ...(reason ? { reason } : {}) });
        if (!row.claimId) return;
        try {
            await this.env(row).release(row.claimId);
        } catch (e) {
            // The cell's lease and the reaper take the machines back.
            this.deps.onWarn?.('env_session.release_failed', { sessionId: row.sessionId, error: (e as Error).message });
        }
    }

    async open(req: EnvSessionOpen): Promise<EnvSessionView> {
        const existing = await this.deps.store.get(req.organizationId, req.sessionId);
        if (existing) {
            if (!ownsSession(existing, req) || existing.environmentId !== req.environmentId) throw notFound();
            return envSessionView(await this.expireIfStale(existing));
        }
        const repositories = sessionLayout(req);
        if (!req.repositoryIds.includes(req.repositoryId) || !(repositories ?? []).every((r) => req.repositoryIds.includes(r.repositoryId))) throw notFound();
        if (await this.deps.isStopped(req.organizationId)) {
            throw new EnvSessionError(
                409,
                'runtime_stopped',
                'The Runtime is stopped for this organization; no environment opens until an admin clears the stop.',
            );
        }
        const live = await this.deps.store.listLive(req.organizationId);
        if (live.filter((s) => s.keyId === req.keyId).length >= ENV_SESSION_MAX_LIVE_PER_KEY) {
            throw new EnvSessionError(
                429,
                'key_session_quota',
                `This key already has ${ENV_SESSION_MAX_LIVE_PER_KEY} open environments; close one with env_down.`,
            );
        }
        if (live.length >= ENV_SESSION_MAX_LIVE_PER_ORG) {
            throw new EnvSessionError(429, 'org_session_quota', `This organization already has ${ENV_SESSION_MAX_LIVE_PER_ORG} open environments.`);
        }

        const at = this.now().toISOString();
        const row: EnvSessionRow = {
            sessionId: req.sessionId,
            organizationId: req.organizationId,
            teamId: req.teamId,
            repositoryId: req.repositoryId,
            keyId: req.keyId,
            environmentId: req.environmentId,
            sha: req.sha,
            ...(repositories ? { repositories } : {}),
            state: 'acquiring',
            createdAt: at,
            lastUsedAt: at,
        };

        // The recipe and expose come from the environment's setup on the default branch (§6), never from the commit asked for.
        const loadedSetup = await this.deps.setups.get(req.environmentId);
        const setup = loadedSetup ? structuredClone(loadedSetup) : null;
        if (!setup || setup.organizationId !== req.organizationId || setup.repositoryId !== req.repositoryId) {
            const blocked = {
                ...row,
                state: 'blocked' as const,
                blockers: [{ kind: 'platform', signature: 'no_setup', message: 'This environment was never set up. Set it up from the Runtime page first.' }],
            };
            if (await this.deps.store.insert(blocked)) {
                await this.deps.store.update(row.organizationId, row.sessionId, { state: 'blocked', blockers: blocked.blockers });
                return envSessionView(blocked);
            }
            return this.openedView(req);
        }
        if (setup.state !== 'active') {
            const blockers = (setup.blockers ?? []).map((b) => ({ kind: b.kind, signature: b.signature, message: b.message.slice(0, 500) }));
            const blocked = {
                ...row,
                state: 'blocked' as const,
                blockers: blockers.length
                    ? blockers
                    : [{ kind: 'platform', signature: `setup_${setup.state}`, message: `The environment setup is ${setup.state}.` }],
                reason: 'The environment setup is not active; env_blockers lists the fixes.',
            };
            if (await this.deps.store.insert(blocked)) {
                await this.deps.store.update(row.organizationId, row.sessionId, { state: 'blocked', blockers: blocked.blockers, reason: blocked.reason });
                return envSessionView(blocked);
            }
            return this.openedView(req);
        }

        // Only proven default-branch authority can supply validation commands (§6).
        // Pin before acquiring; the active setup may change while a lease is open.
        if (
            setup.refSource === 'default_branch' &&
            setup.recipe?.state === 'found' &&
            setup.recipe.sha === setup.sha &&
            typeof setup.recipe.content === 'string'
        ) {
            const parsed = parseRecipe(setup.recipe.content);
            const snapshot = RecipeValidationSnapshotSchema.safeParse({
                recipeSha: setup.recipe.sha,
                recipeDigest: createHash('sha256').update(setup.recipe.content).digest('hex'),
                checks: parsed.ok ? parsed.recipe.validate ?? [] : undefined,
            });
            if (parsed.ok && snapshot.success) row.validationSnapshot = snapshot.data;
        }
        if (!(await this.deps.store.insert(row))) return this.openedView(req);
        const acquiring = this.track(this.acquire(req, setup));
        const waitMs = this.deps.openWaitMs ?? ENV_SESSION_OPEN_WAIT_MS;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([acquiring, new Promise((r) => (timer = setTimeout(r, waitMs)))]);
        if (timer) clearTimeout(timer);
        return envSessionView((await this.deps.store.get(req.organizationId, req.sessionId)) ?? row);
    }

    private async openedView(req: EnvSessionOpen): Promise<EnvSessionView> {
        const row = await this.deps.store.get(req.organizationId, req.sessionId);
        if (!row || !ownsSession(row, req) || row.environmentId !== req.environmentId) throw notFound();
        return envSessionView(await this.expireIfStale(row));
    }
    private async acquire(req: EnvSessionOpen, setup: EnvironmentSetupRecord) {
        const env = this.env(req, {
            correlationId: req.correlationId,
            fullName: req.repositoryFullName,
            sealedRepoToken: req.sealedRepoToken,
            imageId: setup.imageId ?? 'latest',
            expose: setup.expose ?? [],
            ...(req.workspace ? { workspace: sessionClaimWorkspace(req) } : {}),
        });
        try {
            const recipe = setup.recipe
                ? {
                      path: setup.recipe.path,
                      content: setup.recipe.state === 'found' && typeof setup.recipe.content === 'string' ? setup.recipe.content : null,
                      ...(setup.recipe.digest ? { digest: setup.recipe.digest } : {}),
                  }
                : undefined;
            // No room on a cell now: the session stays booting and asks again (ADR-070).
            const { claim } = await acquireWaitingForRoom(env, {
                organizationId: req.organizationId,
                environmentId: req.environmentId,
                imageId: setup.imageId ?? 'latest',
                // The dev's commit runs under the PR side's policy: test-phase egress only (S-27).
                ref: { side: 'pr', sha: req.sha },
                consumer: 'mcp',
                idempotencyKey: `mcp:${req.sessionId}`,
                ...(recipe ? { recipe } : {}),
                // The size the environment's setup booted with.
                ...(setup.machineSize ? { size: setup.machineSize } : {}),
            }, { until: this.now().getTime() + (this.deps.capacityWaitMs ?? 10 * 60_000), now: this.now, ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}) });
            const current = await this.deps.store.get(req.organizationId, req.sessionId);
            if (isBlocked(claim)) {
                await this.deps.store.update(req.organizationId, req.sessionId, {
                    state: 'blocked',
                    blockers: claim.blockers.map((b) => ({ kind: b.kind, signature: b.signature, message: b.message.slice(0, 500) })),
                    reason: 'The environment did not boot at this commit; env_blockers lists the fixes.',
                });
                return;
            }
            // env_down while the claim was booting: give it back at once.
            if (current && !isLiveEnvSession(current.state)) {
                // Caught here so the ended session is not marked errored; the lease takes the machines back.
                await env.release(claim.claimId).catch((e) => this.deps.onWarn?.('env_session.release_failed', { sessionId: req.sessionId, claimId: claim.claimId, error: safeFailure(e) }));
                return;
            }
            await this.deps.store.update(req.organizationId, req.sessionId, {
                state: 'ready',
                claimId: claim.claimId,
                cellId: claim.cellId,
                leaseExpiresAt: claim.leaseExpiresAt,
                services: claim.manifest.services,
            });
        } catch {
            this.deps.onWarn?.('env_session.acquire_failed', { sessionId: req.sessionId, error: 'acquire_unavailable' });
            await this.deps.store.update(req.organizationId, req.sessionId, {
                state: 'errored',
                reason: 'No cell could take this environment now. Call env_up again in a minute.',
            });
        }
    }

    async get(owner: EnvSessionOwner, sessionId: string): Promise<EnvSessionView> {
        return envSessionView(await this.load(owner, sessionId));
    }

    async validation(owner: EnvSessionOwner, sessionId: string, name: string): Promise<EnvValidationResolution> {
        const row = await this.load(owner, sessionId);
        if (row.state !== 'ready' || !row.claimId)
            throw new EnvSessionError(409, 'session_not_ready', 'Wait for a ready session before validation.');
        const snapshot = RecipeValidationSnapshotSchema.safeParse(row.validationSnapshot);
        if (!snapshot.success)
            throw new EnvSessionError(409, 'validation_snapshot_unavailable', 'Open a new session to pin the recipe validations.');
        const check = snapshot.data.checks.find((c) => c.name === name);
        if (!check) throw new EnvSessionError(409, 'validation_not_found', 'The pinned recipe has no validation with this name.');
        return {
            session: envSessionView(row),
            name: check.name,
            command: check.run,
            recipeSha: snapshot.data.recipeSha,
            recipeDigest: snapshot.data.recipeDigest,
        };
    }
    async exec(req: EnvSessionExec & { sessionId: string }): Promise<EnvStepView> {
        const row = await this.load(req, req.sessionId);
        if (row.state !== 'ready' || !row.claimId) {
            throw new EnvSessionError(409, 'session_not_ready', row.reason ?? `The session is ${row.state}; wait for ready (env_up) before env_exec.`);
        }
        // 409 like the other refusals of a call: the API passes its code and message on to the dev (a 400 reaches them as a bare 503).
        if (req.repository !== undefined && !row.repositories?.some((r) => r.alias === req.repository)) {
            throw new EnvSessionError(
                409,
                'unknown_repository',
                row.repositories?.length
                    ? `${req.repository} is not a repository of this session; use one of ${row.repositories.map((r) => r.alias).join(', ')}.`
                    : 'This session has one repository; run the command without repository.',
            );
        }
        if (req.validationName !== undefined || req.executionScope !== undefined) {
            const resolved = await this.validation(req, req.sessionId, req.validationName ?? '');
            // A pinned check runs where the recipe pinned it: never with another cwd or in another repository.
            if (req.executionScope !== 'workload' || req.command !== resolved.command || req.cwd !== undefined || req.repository !== undefined) {
                throw new EnvSessionError(409, 'validation_mismatch', 'Validation execution must match the pinned recipe inside its workload.');
            }
        }
        const startedAt = this.now().toISOString();
        const step: EnvStepRow = {
            stepId: req.stepId,
            sessionId: row.sessionId,
            organizationId: row.organizationId,
            command: req.command,
            timeoutMs: req.timeoutMs,
            state: 'running',
            startedAt,
        };
        await this.deps.store.insertStep(step);
        await this.deps.store.update(row.organizationId, row.sessionId, { lastUsedAt: startedAt });
        void this.track(this.runStep(row, step, req.cwd, req.executionScope, req.repository));
        return stepView(step);
    }

    private async runStep(row: EnvSessionRow, step: EnvStepRow, cwd?: string, executionScope?: 'workload', repository?: string) {
        let result: EnvStepRow['result'];
        try {
            const r = await this.env(row).exec(row.claimId!, {
                stepId: step.stepId,
                command: step.command,
                ...(cwd ? { cwd } : {}),
                timeoutMs: step.timeoutMs,
                ...(executionScope ? {executionScope} : {}),
                ...(repository ? { repository } : {}),
            });
            if (isEnvError(r)) {
                result = { error: r.code };
            } else {
                result = {
                    exitCode: r.exitCode,
                    stdout: clip(r.stdout),
                    stderr: clip(r.stderr),
                    truncated: r.truncated || (r.stdout?.length ?? 0) > MAX_OUTPUT || (r.stderr?.length ?? 0) > MAX_OUTPUT,
                    durationMs: r.durationMs,
                    ...(r.redactions ? { redactions: r.redactions } : {}),
                    ...(r.transport === 'lost' ? { error: 'transport_lost' } : {}),
                };
            }
        } catch {
            this.deps.onWarn?.('env_session.exec_failed', { sessionId: row.sessionId, stepId: step.stepId, error: 'execution_unavailable' });
            result = { error: 'cell_unavailable' };
        }
        await this.deps.store.finishStep(row.organizationId, step.stepId, { state: 'done', finishedAt: this.now().toISOString(), result });
    }

    /**
     * env_upload: each file becomes an evidence object of the session's org
     * ({org}/{session}/pr/{uuid}/input), then the cell reads every one by its
     * key and writes it into the checkout (digest-checked). Answers once the
     * cell wrote them all; a refusal of the cell is passed on with its reason.
     */
    async upload(req: EnvSessionUpload & { sessionId: string }): Promise<EnvUploadView> {
        const row = await this.load(req, req.sessionId);
        if (row.state !== 'ready' || !row.claimId) {
            throw new EnvSessionError(409, 'session_not_ready', row.reason ?? `The session is ${row.state}; wait for ready (env_up) before env_upload.`);
        }
        const files = uploadFilesOf(req.files);
        const env = this.env(row);
        if (!this.deps.evidence || typeof env.upload !== 'function') {
            throw new EnvSessionError(409, 'upload_unavailable', 'This deployment cannot take files into an environment (no evidence store the cells read).');
        }
        const written = [];
        for (const f of files) {
            const key = evidenceKey({ organizationId: row.organizationId, runId: row.sessionId, side: 'pr', stepId: randomUUID(), type: 'input' });
            await this.deps.evidence.put(key, f.body, 'application/octet-stream');
            written.push({ ...f, key, sha256: createHash('sha256').update(f.body).digest('hex') });
        }
        await this.deps.store.update(row.organizationId, row.sessionId, { lastUsedAt: this.now().toISOString() });
        const r = await env.upload(row.claimId, {
            stepId: req.stepId,
            files: written.map((f) => ({ path: f.path, contentRef: f.key, sha256: f.sha256, ...(f.mode !== undefined ? { mode: f.mode } : {}) })),
        });
        if (isEnvError(r)) {
            if (r.code === 'upload_unavailable') throw new EnvSessionError(409, 'upload_unavailable', "The session's cell cannot take files.");
            throw new EnvSessionError(409, r.code, r.code === 'upload_failed' ? `Nothing was written: ${r.reason.slice(0, 500)}` : `Nothing was written (${r.code}).`);
        }
        return { stepId: req.stepId, sessionId: row.sessionId, files: written.map((f) => ({ path: f.path, bytes: f.body.length, sha256: f.sha256 })) };
    }

    async step(owner: EnvSessionOwner, stepId: string): Promise<EnvStepView> {
        const step = await this.deps.store.getStep(owner.organizationId, stepId);
        const row = step ? await this.deps.store.get(owner.organizationId, step.sessionId) : null;
        if (!step || !row || !ownsSession(row, owner)) throw notFound();
        await this.deps.store.update(row.organizationId, row.sessionId, { lastUsedAt: this.now().toISOString() });
        if (step.state === 'running' && this.now().getTime() > Date.parse(step.startedAt) + step.timeoutMs + ENV_STEP_LOST_AFTER_MS) {
            return { ...stepView(step), state: 'lost', error: 'The step stopped reporting; its worker went away. Run it again.' };
        }
        return stepView(step);
    }

    async close(owner: EnvSessionOwner, sessionId: string): Promise<EnvSessionView> {
        const row = await this.load(owner, sessionId);
        if (!isLiveEnvSession(row.state)) return envSessionView(row);
        await this.end(row, 'released');
        return envSessionView({ ...row, state: 'released' });
    }

    /** Releases sessions idle past the limit or past their lease (each worker runs it; a release is idempotent). */
    async sweep(): Promise<number> {
        const now = this.now();
        const stale = await this.deps.store.listStale(
            new Date(now.getTime() - (this.deps.idleMs ?? ENV_SESSION_IDLE_MS)).toISOString(),
            now.toISOString(),
            STALE_BATCH,
        );
        for (const row of stale) await this.expireIfStale(row);
        return stale.length;
    }
}

export function stepView(step: EnvStepRow): EnvStepView {
    return {
        stepId: step.stepId,
        sessionId: step.sessionId,
        state: step.state,
        command: step.command,
        startedAt: step.startedAt,
        ...(step.finishedAt ? { finishedAt: step.finishedAt } : {}),
        ...(step.result ?? {}),
    };
}
