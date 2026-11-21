import { notReadyWaited } from '@libs/runtime/blockers/catalog';
import { type BakeOutcome, type BakeRequest, type Blocked, type Claim, EnvironmentRuntime, isBlocked, isCapacityWait, isEnvError, POOL_SIZE_UNSUPPORTED } from '@libs/runtime/environment';
import { LATEST_IMAGE } from '@libs/runtime/gate';
import { blockerAliasOf, type EnvironmentSetupBlocker, type EnvironmentSetupRecord, type EnvironmentSetupStep, type RecipeSummary, setupRefsDigest, withSetupBoot } from '@libs/runtime/run';
import { isExpiredTokenDownload, setupRepoTokensRunOut } from '@libs/runtime/run/setup-repo-tokens';
import { safeFailure } from '@libs/runtime/telemetry/failure';

import { AdmissionCapacityLostError } from '../env/admission-errors';
import { acquireWaitingForRoom } from '../env/capacity-wait';
import { checkClaimLease, ClaimLeaseUnavailableError, type ClaimLeaseFailed, throwClaimLeaseFailure } from '../env/claim-liveness';
import { HEALTH_RETRY_INTERVAL_SECONDS, notAnsweringYet, readyProbe, readyTarget } from '../env/ready-check';
import { stableStepId } from '../run/step-id';
import { isCancellation } from '../workflow-cancellation';
import { blockerMessage } from './blocker-message';
import { setupBootPhases } from './boot-phases';
import { envFor, SETUP_IMAGE, type SetupDeps, type SetupExpose, setupLogger, type SetupRun, type SetupStepRunner } from './setup-scope';
import { askTokens, useTokens } from './setup-tokens';

/**
 * What the ready check leaves of the claim before its hardExpiresAt: the bake
 * runs from that same claim after the check, then the pool and the release,
 * and a claim at its ceiling is reaped under them.
 */
export const READY_CHECK_CEILING_MARGIN_SECONDS = 120;

/**
 * The environment's image once its bake is accepted: its last bake in the
 * cell that baked it, which the cell resolves (and its warm pool machines,
 * made from that bake, answer to). Runs then boot on the bake.
 */
export const BAKED_IMAGE = LATEST_IMAGE;

/** How long a setup's boot waits for room on a cell before it is blocked (ADR-070): the setup queue's own budget. */
export const SETUP_CAPACITY_WAIT_MS = 30 * 60_000;

/** How often a running boot's progress is read from the hub. */
export const BOOT_PROGRESS_POLL_MS = 3_000;

/**
 * One boot of the setup: attempt 0 is the setup's own boot; attempt n, the
 * boot of Kody's repair n, has its own claim (idempotency key) and its own
 * step names. `env` and `key` change once when the boot downloads again with
 * new tokens; `step` is the record's current boot step.
 */
interface BootAttempt {
    attempt: number;
    env: EnvironmentRuntime;
    step: EnvironmentSetupStep;
    key: string;
    /** The step id of `name` for this attempt (`<name>:repair:<n>` for a repair's boot). */
    named: (name: string) => string;
}

/**
 * A setup's acquire, asked again while no cell has room for it (ADR-070):
 * nothing started, so it waits instead of blocking the setup. The hub
 * shows the wait in the claim's progress (phase capacity), which the
 * setup's live view reads.
 */
export async function acquireForSetup(deps: SetupDeps, env: EnvironmentRuntime, req: Parameters<EnvironmentRuntime['acquire']>[0], signal?: AbortSignal, noCapacityWait = false) {
    if (noCapacityWait) return env.acquire(req);
    const r = await acquireWaitingForRoom(env, req, {
        until: deps.now().getTime() + (deps.opts.capacityWaitMs ?? SETUP_CAPACITY_WAIT_MS),
        now: deps.now,
        ...(deps.opts.sleep ? { sleep: deps.opts.sleep } : {}),
        signal,
    });
    if (r.rounds > 1) setupLogger.log({ msg: 'setup.capacity_waited', environmentId: req.environmentId, waitedMs: r.waitedMs, rounds: r.rounds });
    return r.claim;
}

/**
 * One boot of the recipe in hand, its ready check, the bake and the
 * pool when it answers, and the release of its claim. Attempt 0 is the
 * setup's own boot; attempt n, the boot of Kody's repair n, has its own
 * claim (idempotency key) and its own step names, so a replay reads
 * each attempt's answers in order. The first boot of a request older
 * than its tokens' safe life asks for new ones first (`tokens:boot`);
 * a boot whose download was refused with expired tokens boots once
 * more with new ones (`tokens:refetch`, `boot:refetch`, its claim
 * `<boot key>:refetch`). Neither step exists for any other boot.
 */
export async function bootOnce(run: SetupRun, bootEnv: EnvironmentRuntime, attempt: number): Promise<{ claimFailed: boolean }> {
    const { cmd, rec, journal } = run;
    const b: BootAttempt = {
        attempt,
        env: bootEnv,
        step: await journal.start('boot'),
        key: attempt ? `setup:${cmd.key}:repair-${attempt}` : `setup:${cmd.key}`,
        named: (name: string) => (attempt ? `${name}:repair:${attempt}` : name),
    };
    let claimId: string | undefined;
    let cancelled = false;
    let claimFailed = false;
    try {
        await refreshStaleTokens(run, b);
        const claim = await bootAgainAfterExpiredDownload(run, b, await acquireBoot(run, b, false));
        if (isBlocked(claim)) {
            await recordBlockedBoot(run, b, claim);
            return { claimFailed };
        }
        claimId = claim.claimId;
        await recordBootedClaim(run, b, claim);
        if (!(await checkReady(run, b, claim))) return { claimFailed };
        const baked = await bake(run, b, claim);
        await fillPool(run, b, claim, baked);
        rec.state = 'active';
        if (rec.recipe?.origin === 'inferred' || rec.recipe?.origin === 'authored') rec.recipe.cleanBoots = cleanBootsOf(run.previous, rec);
        return { claimFailed };
    } catch (e) {
        if (isCancellation(e)) {
            cancelled = true;
            throw e;
        }
        claimFailed = e instanceof ClaimLeaseUnavailableError || e instanceof AdmissionCapacityLostError;
        const last = rec.steps[rec.steps.length - 1];
        await journal.block(last, {
            kind: claimFailed ? ((e as ClaimLeaseUnavailableError).code === 'security_violation' ? 'security_violation' : 'platform') : (e as { code?: string })?.code ?? 'setup_failed',
            // No cell to boot on has its own card; any other throw keeps the error's name.
            signature: (e as { code?: string })?.code === 'cell_unavailable' ? 'cell_unavailable' : `setup:${(e as Error)?.name ?? 'error'}`,
            message: blockerMessage((e as Error)?.message ?? String(e)),
        });
        return { claimFailed };
    } finally {
        if (!cancelled && claimId) await releaseBoot(run, b, claimId);
    }
}

/**
 * A request that waited in the queue past its tokens' safe life: the first boot asks for new ones before it
 * downloads (demo-calcom: 77 minutes queued, a 401 on the first download). A product that cannot answer leaves
 * the command's, as before. A recent request asks nothing, and its steps stay as they were.
 */
async function refreshStaleTokens(run: SetupRun, b: BootAttempt): Promise<void> {
    if (b.attempt || !run.tokens.needsFresh || !setupRepoTokensRunOut(run.tokens.issuedAt, b.step.startedAt)) return;
    const fresh = await askTokens(run, 'tokens:boot', 'boot');
    if (fresh.status === 'issued') {
        useTokens(run, fresh, b.step.startedAt);
        b.env = envFor(run);
    } else {
        setupLogger.warn({ msg: 'setup.boot_tokens_unavailable', environmentId: run.rec.environmentId, requestedAt: run.cmd.requestedAt, error: fresh.message });
    }
}

/** The claim of this boot, its progress and phases; `again` names the boot that downloads with new tokens after expired ones. */
async function acquireBoot(run: SetupRun, b: BootAttempt, again: boolean): Promise<Claim | Blocked> {
    const { cmd, rec, step, sha, execution } = run;
    const env = b.env;
    const bootKey = b.key;
    const bootRecipe = run.bootRecipe;
    // While the cell prepares the machine, its phases and the build's last
    // lines reach the setup's record (a live view, outside the journal).
    const watch = watchBoot(run.deps, env, cmd.organizationId, cmd.environmentId, cmd.key, bootKey);
    const claim = await step(b.named(again ? 'boot:refetch' : 'boot'), () =>
        acquireForSetup(run.deps, env, {
            organizationId: cmd.organizationId,
            environmentId: cmd.environmentId,
            imageId: SETUP_IMAGE,
            ref: { side: 'setup', sha },
            consumer: 'setup',
            idempotencyKey: bootKey,
            ...(cmd.diagnosticHold ? { diagnosticHold: true } : {}),
            // The environment's machine size; the cell refuses one above what it grants.
            ...(cmd.machineSize ? { size: cmd.machineSize } : {}),
            // Only the default branch's builds may leave the environment their cache (S-52), as only they bake.
            ...(rec.refSource === 'default_branch' ? { seedsCache: true } : {}),
            // The recipe read at this commit (or Kody's); the cell boots with it, not the checkout's copy.
            ...(bootRecipe
                ? {
                      recipe: {
                          path: bootRecipe.path,
                          content: bootRecipe.content,
                          ...(rec.recipe?.digest ? { digest: rec.recipe.digest } : {}),
                          ...(bootRecipe.files ? { files: bootRecipe.files } : {}),
                      },
                  }
                : {}),
        }, run.cancellationSignal?.(), execution.noCapacityWait),
    ).finally(() => watch.stop());
    if (execution.noCapacityWait && isCapacityWait(claim)) throw new AdmissionCapacityLostError();
    // The boot's last progress stays on the record (journaled: a replay reads the same). Progress is best
    // effort (the hub's own answers null when unreachable): one that throws is no progress, not a failed boot.
    const progress = await step(b.named(again ? 'boot:refetch:progress' : 'boot:progress'), async () => (await env.progress?.({ organizationId: cmd.organizationId, idempotencyKey: bootKey }).catch(() => null)) ?? null);
    if (progress) rec.progress = progress;
    // Where the boot spent its time, on its step: also when it did not come up.
    const phases = setupBootPhases(claim, progress);
    if (phases) b.step.phases = phases;
    return claim;
}

/**
 * The cell's download refused with tokens that had expired by then (the wait for room, the hub's queue):
 * new ones and one more boot on its own claim, never a second time, and never under a diagnostic hold
 * (its machines are kept to be looked at). A 401 of tokens still in their life (revoked, an
 * installation removed) stays the platform failure it reads as.
 */
async function bootAgainAfterExpiredDownload(run: SetupRun, b: BootAttempt, acquired: Claim | Blocked): Promise<Claim | Blocked> {
    const { cmd, rec, journal } = run;
    if (!isBlocked(acquired) || !run.tokens.needsFresh || cmd.diagnosticHold || acquired.blockers[0]?.signature !== 'repo_fetch') return acquired;
    const refusedAt = await journal.clock();
    if (!isExpiredTokenDownload(acquired.blockers[0], run.tokens.issuedAt, refusedAt)) return acquired;
    const tokensIssuedAt = run.tokens.issuedAt;
    const fresh = await askTokens(run, b.named('tokens:refetch'), b.attempt ? `repair-${b.attempt}` : 'boot');
    if (fresh.status !== 'issued') {
        setupLogger.warn({ msg: 'setup.refetch_tokens_unavailable', environmentId: rec.environmentId, repair: b.attempt, error: fresh.message });
        return acquired;
    }
    setupLogger.warn({ msg: 'setup.download_token_expired', environmentId: rec.environmentId, repair: b.attempt, tokensIssuedAt, refusedAt });
    useTokens(run, fresh, refusedAt);
    b.env = envFor(run);
    await journal.finish(b.step, 'failed', 'the repository download was refused: its token had expired; booting again with new tokens');
    rec.boots = withSetupBoot(rec.boots, b.step, 'failed', 'repo_fetch');
    delete rec.progress;
    b.step = await journal.start('boot');
    b.key = `${b.key}:refetch`;
    return acquireBoot(run, b, true);
}

/** A boot the cell blocked: its cell, its failure bundle and any held machines on the record, and the setup blocked on it. */
async function recordBlockedBoot(run: SetupRun, b: BootAttempt, claim: Blocked): Promise<void> {
    const { rec, journal } = run;
    const first = claim.blockers[0];
    // A boot that failed after its build left that cell its state: the next setup goes there.
    if (claim.cellId) rec.buildCellId = claim.cellId;
    if (first?.bundle) rec.failureBundle = first.bundle;
    // The cell kept the machines: they are not released here; they go at hardExpiresAt.
    if (claim.held) rec.diagnosticHold = { claimId: claim.held.claimId, cellId: claim.held.cellId, until: claim.held.hardExpiresAt };
    const alias = blockerAliasOf(first);
    await journal.block(b.step, {
        kind: first?.kind ?? 'could_not_boot',
        signature: first?.signature ?? 'setup:could_not_boot',
        message: first?.message ?? 'the cell could not boot the environment',
        ...(alias ? { alias } : {}),
    });
    rec.boots = withSetupBoot(rec.boots, b.step, 'failed', first?.signature ?? 'setup:could_not_boot');
}

/** A boot that came up: where, with what exposed and how long it took. */
async function recordBootedClaim(run: SetupRun, b: BootAttempt, claim: Claim): Promise<void> {
    const { rec } = run;
    rec.cellId = rec.buildCellId = claim.cellId;
    rec.imageId = SETUP_IMAGE;
    rec.expose = (claim.manifest?.expose?.length ? claim.manifest.expose : run.expose) as SetupExpose;
    if (claim.timing) rec.bootTiming = claim.timing;
    await run.journal.done(b.step, `cell ${claim.cellId}`);
    rec.boots = withSetupBoot(rec.boots, b.step, 'ready');
}

/** The `ready` step: the exposed app answers. False when the setup ended blocked on it. */
async function checkReady(run: SetupRun, b: BootAttempt, claim: Claim): Promise<boolean> {
    const { rec, journal } = run;
    const ready = await journal.start('ready');
    const check = await readyCheck(run.deps, b.env, claim, rec.expose!, rec.recipe ?? {}, b.key, b.named('health'), run.step);
    if (check.state === 'skipped') {
        await journal.finish(ready, 'skipped', 'no http service exposed: nothing to check');
    } else if (check.state === 'failed') {
        await journal.block(ready, check.blocker);
        return false;
    } else {
        await journal.done(ready, `GET ${check.path} → ${check.status}`);
    }
    return true;
}

/** image.bake (S-52); a skipped, refused or failed bake leaves the environment active without an image. True when the bake was accepted. */
async function bake(run: SetupRun, b: BootAttempt, claim: Claim): Promise<boolean> {
    const { cmd, rec, journal, sha } = run;
    const bakeStep = await journal.start('bake');
    if (!b.env.bake) {
        await journal.finish(bakeStep, 'skipped', 'this cell connection has no bake');
        return false;
    }
    if (rec.refSource !== 'default_branch' || !cmd.ref?.branch || cmd.ref.sha !== sha) {
        await journal.finish(bakeStep, 'skipped', 'commit not checked as the default branch head by the product (S-52)');
        return false;
    }
    const bakeEnv = b.env;
    const out: BakeOutcome | ClaimLeaseFailed = await run.step(b.named('bake'), async () => {
        const failure = await checkClaimLease(bakeEnv, claim.claimId, 'setup', run.deps.leaseRetry);
        if (failure) return { claimFailure: failure };
        const recipeSha = rec.recipe?.digest ?? sha;
        // A multi-repository environment's bake is keyed by every repository's commit and the recipe.
        const digest = setupRefsDigest(cmd, sha, recipeSha);
        const request: BakeRequest = { organizationId: cmd.organizationId, environmentId: cmd.environmentId, recipeSha, sha, claimId: claim.claimId, ...(digest ? { refsDigest: digest } : {}) };
        return bakeEnv.bake!(request).catch(
            (e: Error): BakeOutcome => ({ status: 'refused', code: 'bake_error', message: (e?.message ?? String(e)).slice(0, 200) }),
        );
    });
    if ('claimFailure' in out) throwClaimLeaseFailure(out.claimFailure);
    const bakeDigest = setupRefsDigest(cmd, sha, rec.recipe?.digest ?? sha);
    if (out.status === 'accepted' && bakeDigest) rec.bakeRefsDigest = bakeDigest;
    if (out.status === 'accepted') await journal.done(bakeStep, `image.bake accepted for ${cmd.ref.branch} ${sha.slice(0, 12)}`);
    else await journal.finish(bakeStep, 'failed', `image.bake refused: ${out.code}`);
    const baked = out.status === 'accepted';
    if (baked) rec.imageId = BAKED_IMAGE;
    return baked;
}

/** pool.target to the cell that baked (S-52: only from its bake); a refusal leaves the environment active, with no pool. */
async function fillPool(run: SetupRun, b: BootAttempt, claim: Claim, baked: boolean): Promise<void> {
    const { cmd, journal } = run;
    const pool = await journal.start('pool');
    if (cmd.poolSize === undefined || !b.env.poolTarget) {
        await journal.finish(pool, 'skipped', 'no pool size for this environment');
        return;
    }
    if (!baked) {
        await journal.finish(pool, 'skipped', 'no bake to fill the pool from');
        return;
    }
    const poolEnv = b.env;
    const size = cmd.poolSize;
    const out: BakeOutcome = await run.step(b.named('pool'), () =>
        poolEnv.poolTarget!({
            organizationId: cmd.organizationId,
            environmentId: cmd.environmentId,
            size,
            // The size the setup booted (and baked) at: the pool's machines are made at it.
            ...(cmd.machineSize ? { machineSize: cmd.machineSize } : {}),
            cellId: claim.cellId,
            claimId: claim.claimId,
        }).catch(
            (e: Error): BakeOutcome => ({ status: 'refused', code: 'pool_error', message: (e?.message ?? String(e)).slice(0, 200) }),
        ),
    );
    if (out.status === 'accepted') await journal.done(pool, `${size} machine${size === 1 ? '' : 's'} kept ready from the bake`);
    // The cell is too old to make a sized pool: nothing failed and nothing in the recipe fixes it, as with no bake.
    else if (out.code === POOL_SIZE_UNSUPPORTED) await journal.finish(pool, 'skipped', out.message);
    else await journal.finish(pool, 'failed', `pool.target refused: ${out.code}`);
}

/** The `release` step of the boot's claim. A failed release is recorded and left to the reaper (the claim stays open until the hub records it). */
async function releaseBoot(run: SetupRun, b: BootAttempt, claimId: string): Promise<void> {
    const env = b.env;
    const release = await run.journal.start('release');
    const releaseError = await run.step(b.named('release'), () => env.release(claimId).then(() => undefined, (e: Error) => (e?.message ?? String(e)).slice(0, 200)));
    await run.journal.done(release, releaseError ? `release failed, the reaper retries: ${releaseError}` : undefined);
}

/** The ready check of a booted claim: GET the health path on the public http service; under 500 is ready. */
export async function readyCheck(
    deps: SetupDeps,
    env: EnvironmentRuntime,
    claim: Pick<Claim, 'claimId' | 'hardExpiresAt'>,
    expose: SetupExpose,
    recipe: Pick<RecipeSummary, 'public' | 'health' | 'healthTimeoutSeconds'>,
    scope: string,
    stepName: string,
    step: SetupStepRunner,
): Promise<{ state: 'skipped' } | { state: 'done'; path: string; status: number } | { state: 'failed'; blocker: Omit<EnvironmentSetupBlocker, 'at'> }> {
    const target = readyTarget(expose, recipe, deps.opts.healthPath);
    if (!target) return { state: 'skipped' };
    const path = target.path;
    // The app may still be starting when the claim is ready (compose up does not wait for it):
    // the check asks again until it answers or the recipe's health_timeout passes, measured on
    // the clock (a probe that hangs to its own timeout uses up the wait too), never past
    // MAX_HEALTH_TIMEOUT_SECONDS, and never past READY_CHECK_CEILING_MARGIN_SECONDS before the
    // claim's hardExpiresAt (a long boot leaves less than the wait). Each try is its own
    // journaled step, its wait and its clock reads inside it, so a replay reads the same tries
    // and the same times at once; the ceiling is the journaled boot's.
    const claimId = claim.claimId;
    const ceilingMs = Date.parse(claim.hardExpiresAt) - READY_CHECK_CEILING_MARGIN_SECONDS * 1_000;
    const waits = target.waitSeconds;
    const tries = Math.max(1, Math.ceil(waits / HEALTH_RETRY_INTERVAL_SECONDS));
    let out: Awaited<ReturnType<EnvironmentRuntime['probe']>> | undefined;
    let startedAt: number | undefined;
    let waitMs = waits * 1_000;
    for (let i = 0; i < tries; i++) {
        const t = await step(i === 0 ? stepName : `${stepName}:${i}`, async () => {
            const at = deps.now().toISOString();
            if (i > 0) await deps.sleep(HEALTH_RETRY_INTERVAL_SECONDS * 1_000);
            const failure = await checkClaimLease(env, claimId, 'setup', deps.leaseRetry);
            if (failure) return { claimFailure: failure };
            const probed = await env.probe(claimId, readyProbe(target, { id: 'setup-ready', purpose: 'the environment answers after setup' }), stableStepId(scope, i, 'health'));
            return { out: probed, at, finishedAt: deps.now().toISOString() };
        });
        if ('claimFailure' in t) throwClaimLeaseFailure(t.claimFailure);
        out = t.out;
        if (startedAt === undefined) {
            startedAt = Date.parse(t.at);
            // A claim with no readable ceiling (a fake, an old reply) keeps the recipe's wait.
            if (Number.isFinite(ceilingMs)) waitMs = Math.max(0, Math.min(waitMs, ceilingMs - startedAt));
        }
        if (!notAnsweringYet(out)) break;
        // The next try would start past the wait: stop here.
        if (Date.parse(t.finishedAt) + HEALTH_RETRY_INTERVAL_SECONDS * 1_000 - startedAt >= waitMs) break;
    }
    const status = out === undefined || isEnvError(out) ? undefined : out.http?.status;
    if (out === undefined || isEnvError(out) || !status || status >= 500) {
        return {
            state: 'failed',
            blocker: {
                kind: 'not_ready',
                signature: `setup:not_ready:${target.service}:${target.port}${path}`,
                // "after N s": the card proposes a longer wait than this one.
                message:
                    (out !== undefined && isEnvError(out)
                        ? `GET ${path} on ${target.service}:${target.port} failed (${out.code})`
                        : `GET ${path} on ${target.service}:${target.port} answered ${status ?? 'nothing'}`) + (tries > 1 ? notReadyWaited(Math.floor(waitMs / 1_000), waitMs < waits * 1_000) : ''),
            },
        };
    }
    return { state: 'done', path, status };
}

/** Polls the boot's progress into the record until stopped; best effort, never failing the setup. */
function watchBoot(deps: SetupDeps, env: EnvironmentRuntime, organizationId: string, environmentId: string, key: string, idempotencyKey: string) {
    const saveProgress = deps.store.saveProgress?.bind(deps.store);
    if (!env.progress || !saveProgress) return { stop() {} };
    let stopped = false;
    let last = '';
    let saveFailed = false;
    const tick = async () => {
        // A read that fails is no progress this tick; the next tick reads again.
        const p = await env.progress!({ organizationId, idempotencyKey }).catch(() => null);
        if (!p || stopped) return;
        const seen = JSON.stringify(p);
        if (seen === last) return;
        last = seen;
        await saveProgress(environmentId, key, p).catch((e) => {
            // The live view misses this progress; the boot's last one is still kept on the record. Told once per boot.
            if (saveFailed) return;
            saveFailed = true;
            setupLogger.warn({ msg: 'setup.progress_save_failed', environmentId, error: safeFailure(e) });
        });
    };
    const timer = setInterval(() => void tick(), BOOT_PROGRESS_POLL_MS);
    timer.unref?.();
    return {
        stop() {
            stopped = true;
            clearInterval(timer);
        },
    };
}

/**
 * ENV-06: how many setups in a row booted this inferred (or authored) recipe
 * from zero and answered. Each setup is a fresh claim on a new machine (imageId `setup`,
 * never a pool or a bake), so the previous active setup with the same digest
 * is an independent boot of the same file.
 */
export function cleanBootsOf(previous: EnvironmentSetupRecord | null, rec: EnvironmentSetupRecord): number {
    if (!rec.steps.some((s) => s.name === 'ready' && s.state === 'done')) return 0;
    const same =
        previous &&
        previous.key !== rec.key &&
        previous.state === 'active' &&
        (previous.recipe?.origin === 'inferred' || previous.recipe?.origin === 'authored') &&
        previous.recipe.origin === rec.recipe?.origin &&
        previous.recipe.digest !== undefined &&
        previous.recipe.digest === rec.recipe?.digest;
    return same ? (previous.recipe?.cleanBoots ?? 1) + 1 : 1;
}
