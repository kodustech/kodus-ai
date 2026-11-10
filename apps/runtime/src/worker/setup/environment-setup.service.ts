import { checkReservedRecipeResources } from '@libs/runtime/run/recipe-resources';
import { createHash } from 'crypto';

import { Logger } from '@nestjs/common';
import { z } from 'zod';

import type { RuntimeEnvironmentSetupRequested, SetupRecipeOrigin } from '@libs/runtime/api/domain/runtime-commands';
import type { AuthoredFile } from '@libs/runtime/contracts/authored-files';
import { notReadyWaited } from '@libs/runtime/blockers/catalog';
import { deriveLessons } from '@libs/runtime/blockers/lessons';
import { type BakeOutcome, type Claim, EnvironmentRuntime, isBlocked, isEnvError, isCapacityWait, POOL_SIZE_UNSUPPORTED } from '@libs/runtime/environment';
import { LATEST_IMAGE } from '@libs/runtime/gate';
import { RECIPE_PATH } from '@libs/runtime/protocol/recipe';

import type { RecipeAuthorClient, RecipeAuthorOutcome } from '../agent/http-recipe-author';
import { acquireWaitingForRoom } from '../env/capacity-wait';
import { AdmissionCapacityLostError } from '../env/admission-errors';
import type { PhysicalAdmissionTicket } from '../../shared/admission-contract';
import { checkClaimLease, ClaimLeaseUnavailableError, throwClaimLeaseFailure, type ClaimLeaseFailed } from '../env/claim-liveness';
import { DEFAULT_HEALTH_TIMEOUT_SECONDS, HEALTH_RETRY_INTERVAL_SECONDS, notAnsweringYet, readyProbe, readyTarget } from '../env/ready-check';
import { stableStepId } from '../run/step-id';
import { isCancellation } from '../workflow-cancellation';
import {
    type EnvironmentRecipeRecord,
    type EnvironmentSetupBlocker,
    type EnvironmentSetupRecord,
    type EnvironmentSetupStep,
    type EnvironmentSetupStepName,
    ExposeSchema,
    lastActiveOf,
    parseRecipeSummary,
    recipeDigest,
    type RecipeSummary,
    withSetupBoot,
} from '@libs/runtime/run';

// The setup of an environment (runtime.environment.setup_requested), run as
// a DBOS workflow (RunEngineService.startSetup): boot the default-branch head
// the product resolved, with the recipe the product read at that commit (§6),
// check that the exposed app answers, release the claim, and record each step
// and every blocker for Environment Health. Every I/O goes through `step` so
// a worker restart resumes after the last checkpoint instead of booting twice.
//
// S-52: the image bake is asked only for the default-branch head the product
// read from the Git API (never the dev override), only from the setup claim
// that booted it; the hub and the cell refuse a PR claim again. A failed
// setup keeps the cell's redacted failure bundle; with the org admin's
// diagnostic hold its machines stay until hardExpiresAt (§11 runbook).

export const ENVIRONMENT_SETUP_SERVICE = Symbol('ENVIRONMENT_SETUP_SERVICE');
export { ENVIRONMENT_SETUP_STORE, InMemoryEnvironmentSetupStore, MongoEnvironmentSetupStore } from './environment-setup.store';
export type { EnvironmentSetupStore } from './environment-setup.store';
import type { EnvironmentSetupStore } from './environment-setup.store';
import type { LessonStore } from './lesson.store';
import { type LearnBootOutcome, type LearnLoopOptions, SetupLearnLoop } from './learn-loop';

export type SetupExpose = NonNullable<EnvironmentSetupRecord['expose']>;

/** A checkpointed step (DBOS.runStep in the workflow, a plain call in tests). */
export type SetupStepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
const direct: SetupStepRunner = (_name, fn) => fn();

export interface SetupEnvFactory {
    /** The repo token stays sealed (bound to the setup key); the environment opens it inside the boot step. */
    envForSetup(input: { correlationId: string; organizationId: string; setupKey: string; fullName: string; sealedRepoToken: string; imageId: string; expose: SetupExpose; admissionTicket?: PhysicalAdmissionTicket }): EnvironmentRuntime;
}

export interface SetupExecutionOptions {
    admissionTicket?: PhysicalAdmissionTicket;
    noCapacityWait?: boolean;
    admissionBlocker?: { kind: 'resources' | 'platform'; signature: string; message: string };
}

export interface SetupOptions {
    /**
     * Explicit dev override (RUNTIME_SETUP_DEV_SHA): boot this commit instead
     * of the one the product resolved, even past a ref or token blocker. Never
     * a fallback: without it a request with no commit is a blocker.
     */
    devSha?: string;
    /** Explicit dev override of the expose list (RUNTIME_SETUP_EXPOSE, JSON); wins over the recipe. */
    devExpose?: SetupExpose;
    /** Ready path when the recipe has no services.compose.health (RUNTIME_SETUP_HEALTH_PATH). */
    healthPath?: string;
    now?: () => Date;
    /** The wait between two tries of the ready check, and between two asks for room on a cell (tests make it instant). */
    sleep?: (ms: number) => Promise<void>;
    /** How long a boot waits for room on a cell (ADR-070); SETUP_CAPACITY_WAIT_MS when absent. */
    capacityWaitMs?: number;
    /**
     * Where a setup that proves a fix records the lesson (ADR-018), and the
     * environment's approved hosts it reads to tell an allowed host made the
     * difference. Without it nothing is learned.
     */
    lessons?: { store: LessonStore; approvedHosts(organizationId: string, environmentId: string): Promise<string[]> };
    /**
     * Kody's learn loop on a blocked default-branch setup (learn-loop.ts): the
     * product's LLM gateway and the lessons it reads. Without it, or without a
     * setup token in the command, the loop is off and the catalog's card stays.
     */
    learn?: LearnLoopOptions;
    /**
     * Kody writes the recipe when the default branch has none and Kodus could
     * not infer one (docs RECIPE-AGENT-TEST-PLAN, "Ligar ao produto"): the
     * product's endpoint, called with the setup token. Without it, or without
     * a setup token in the command, the setup goes on as before.
     */
    author?: RecipeAuthorClient;
}

/** What the recipe step got from Kody: a recipe, Kody's reason for none, or no answer at all. */
type WrittenRecipe =
    | { status: 'recipe'; content: string; notes?: string; files?: AuthoredFile[]; kept: boolean }
    | { status: 'no_recipe'; reason: string }
    | { status: 'unavailable'; message: string };

const setupLogger = new Logger('EnvironmentSetup');

const SETUP_IMAGE = 'setup';

export { DEFAULT_HEALTH_TIMEOUT_SECONDS, HEALTH_RETRY_INTERVAL_SECONDS };
/**
 * What the ready check leaves of the claim before its hardExpiresAt: the bake
 * runs from that same claim after the check, then the pool and the release,
 * and a claim at its ceiling is reaped under them.
 */
export const READY_CHECK_CEILING_MARGIN_SECONDS = 120;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The environment's image once its bake is accepted: its last bake in the
 * cell that baked it, which the cell resolves (and its warm pool machines,
 * made from that bake, answer to). Runs then boot on the bake.
 */
export const BAKED_IMAGE = LATEST_IMAGE;

/** The setup's trace id, derived from its command key (stable across a resumed workflow). */
export const setupCorrelationId = (key: string) => {
    const h = createHash('sha256').update(`kody-runtime/setup\0${key}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** How long a setup's boot waits for room on a cell before it is blocked (ADR-070): the setup queue's own budget. */
export const SETUP_CAPACITY_WAIT_MS = 30 * 60_000;

export class EnvironmentSetupService {
    private readonly now: () => Date;
    private readonly loop?: SetupLearnLoop;

    private readonly sleep: (ms: number) => Promise<void>;

    constructor(
        private readonly envs: SetupEnvFactory,
        private readonly store: EnvironmentSetupStore,
        private readonly opts: SetupOptions = {},
    ) {
        this.now = opts.now ?? (() => new Date());
        this.sleep = opts.sleep ?? realSleep;
        if (opts.learn) this.loop = new SetupLearnLoop(opts.learn);
    }

    /**
     * A setup's acquire, asked again while no cell has room for it (ADR-070):
     * nothing started, so it waits instead of blocking the setup. The hub
     * shows the wait in the claim's progress (phase capacity), which the
     * setup's live view reads.
     */
    private async acquireWaitingForRoom(env: EnvironmentRuntime, req: Parameters<EnvironmentRuntime['acquire']>[0], signal?: AbortSignal, noCapacityWait = false) {
        if (noCapacityWait) return env.acquire(req);
        const r = await acquireWaitingForRoom(env, req, {
            until: this.now().getTime() + (this.opts.capacityWaitMs ?? SETUP_CAPACITY_WAIT_MS),
            now: this.now,
            ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
            signal,
        });
        if (r.rounds > 1) setupLogger.log({ msg: 'setup.capacity_waited', environmentId: req.environmentId, waitedMs: r.waitedMs, rounds: r.rounds });
        return r.claim;
    }

    async run(cmd: RuntimeEnvironmentSetupRequested, step: SetupStepRunner = direct, cancellationSignal?: () => AbortSignal | undefined, execution: SetupExecutionOptions = {}): Promise<EnvironmentSetupRecord> {
        // Deterministic for the workflow engine: every clock read is a step (a resumed
        // workflow replays the same times), and ids derive from the command key.
        let clocks = 0;
        const clock = () => step(`clock:${++clocks}`, async () => this.now().toISOString());
        let saves = 0;
        const save = async (rec: EnvironmentSetupRecord): Promise<void> => {
            rec.updatedAt = await clock();
            const copy = JSON.parse(JSON.stringify(rec)) as EnvironmentSetupRecord;
            await step(`record:${++saves}`, () => this.store.save(copy));
        };
        const start = async (rec: EnvironmentSetupRecord, name: EnvironmentSetupStepName) => {
            const s: EnvironmentSetupStep = { name, state: 'running', startedAt: await clock() };
            rec.steps.push(s);
            await save(rec);
            return s;
        };
        const finish = async (rec: EnvironmentSetupRecord, s: EnvironmentSetupStep, state: EnvironmentSetupStep['state'], detail?: string) => {
            const end = await clock();
            s.state = state;
            s.finishedAt = end;
            s.durationMs = Date.parse(end) - Date.parse(s.startedAt);
            if (detail) s.detail = detail.slice(0, 300);
            await save(rec);
        };
        const done = (rec: EnvironmentSetupRecord, s: EnvironmentSetupStep, detail?: string) => finish(rec, s, 'done', detail);
        const block = async (rec: EnvironmentSetupRecord, s: EnvironmentSetupStep | undefined, b: Omit<EnvironmentSetupBlocker, 'at'>) => {
            const at = await clock();
            rec.blockers.push({ ...b, message: blockerMessage(b.message), at });
            rec.state = 'blocked';
            rec.finishedAt = at;
            if (s && s.state === 'running') await finish(rec, s, 'failed', b.message);
            return rec;
        };

        const previous = await step('load', () => this.store.get(cmd.environmentId));
        // Same command delivered twice: the first answer stands.
        if (previous && previous.key === cmd.key && previous.state !== 'setting_up') return previous;

        const rec: EnvironmentSetupRecord = {
            environmentId: cmd.environmentId,
            organizationId: cmd.organizationId,
            repositoryId: cmd.repositoryId,
            key: cmd.key,
            state: 'setting_up',
            steps: [],
            blockers: [],
            requestedAt: cmd.requestedAt,
            updatedAt: cmd.requestedAt,
            // The size every boot of this setup asks, and every Run on it after.
            ...(cmd.machineSize ? { machineSize: cmd.machineSize } : {}),
            // What the last good setup took, for the one running to show what to expect.
            ...(previous?.lastActive ? { lastActive: previous.lastActive } : {}),
            // The cell that holds the environment's build state and bake: this record replaces the last one
            // before the boot, and the boot's cell preference (poolCellOf) reads it. The boot overwrites it.
            ...carriedBuildCell(previous, cmd.organizationId),
            // The environment's recent boots (Environment Health's setup numbers).
            ...(previous?.boots?.length ? { boots: previous.boots } : {}),
        };
        await done(rec, await start(rec, 'requested'));
        // A development ref override never overrides resource or recipe-policy refusal.
        if (cmd.blocker && (cmd.blocker.kind === 'resources' || cmd.blocker.kind === 'recipe_invalid')) {
            await block(rec, undefined, { kind: cmd.blocker.kind, signature: `setup:${cmd.blocker.kind}`, message: cmd.blocker.message });
            return this.close(rec, save);
        }
        if (execution.admissionBlocker) {
            await block(rec, undefined,
                cmd.blocker
                    ? {
                          kind: cmd.blocker.kind,
                          signature: `setup:${cmd.blocker.kind}`,
                          message: cmd.blocker.message,
                      }
                    : execution.admissionBlocker);
            return this.close(rec, save);
        }

        // The commit: the product's default-branch head, or the explicit dev override.
        const resolve = await start(rec, 'resolve_ref');
        let sha: string;
        if (this.opts.devSha) {
            sha = this.opts.devSha;
            rec.refSource = 'dev_override';
            await done(rec, resolve, `dev override RUNTIME_SETUP_DEV_SHA ${sha.slice(0, 12)}`);
        } else if (cmd.blocker) {
            await block(rec, resolve, { kind: cmd.blocker.kind, signature: `setup:${cmd.blocker.kind}`, message: cmd.blocker.message });
            return this.close(rec, save);
        } else if (!cmd.ref?.sha) {
            await block(rec, resolve, { kind: 'no_ref', signature: 'setup:no_ref', message: 'The setup request carries no commit to build.' });
            return this.close(rec, save);
        } else {
            sha = cmd.ref.sha;
            rec.refSource = 'default_branch';
            if (cmd.ref.branch) rec.branch = cmd.ref.branch;
            await done(rec, resolve, `${cmd.ref.branch ?? 'default branch'} ${sha.slice(0, 12)}`);
        }
        rec.sha = sha;

        // The recipe the product read at that commit (§6: always the default branch).
        const recipeStep = await start(rec, 'recipe');
        let expose: SetupExpose = [];
        const recipe = cmd.recipe && cmd.recipe.sha === sha ? cmd.recipe : undefined;
        // What the cell boots with: the recipe the product read, or the one Kody wrote.
        let bootRecipe: { path: string; content: string | null; files?: AuthoredFile[] } | undefined = recipe ? { path: recipe.path, content: recipe.content } : undefined;
        // A recipe text goes through the same checks whoever wrote it (parseRecipe here, the cell's own on boot).
        // `files`: what Kody wrote with an authored recipe; recorded, digested and booted with it.
        const useRecipe = async (path: string, content: string, label: string, origin?: SetupRecipeOrigin, notes?: string, files?: AuthoredFile[]): Promise<boolean> => {
            const parsed = parseRecipeSummary(content);
            if ('error' in parsed) {
                await block(rec, recipeStep, { kind: 'recipe_invalid', signature: 'setup:recipe_invalid', message: parsed.error });
                return false;
            }
            const resources = checkReservedRecipeResources(
                parsed.recipe.size,
                cmd.machineSize,
            );
            if (resources.ok === false) {
                await block(rec, recipeStep, {
                    kind: 'resources',
                    signature: `recipe_${resources.reason}`,
                    message: resources.message,
                });
                return false;
            }
            const r: EnvironmentRecipeRecord = {
                path,
                sha,
                state: 'found',
                digest: recipeDigest(content, files),
                content,
                ...(files?.length ? { files } : {}),
                ...(parsed.recipe.public ? { public: parsed.recipe.public } : {}),
                ...(parsed.recipe.health ? { health: parsed.recipe.health } : {}),
                ...(parsed.recipe.healthTimeoutSeconds !== undefined ? { healthTimeoutSeconds: parsed.recipe.healthTimeoutSeconds } : {}),
                ...(origin && origin !== 'repository' ? { origin } : {}),
                ...(notes ? { notes } : {}),
            };
            rec.recipe = r;
            expose = parsed.recipe.expose;
            bootRecipe = { path, content, ...(files?.length ? { files } : {}) };
            const withFiles = files?.length ? ` with ${files.length} file${files.length === 1 ? '' : 's'} under .kodus/` : '';
            // A key the cell boots without is said here, once for the setup and every Run on it, never left to look applied.
            const unapplied = parsed.recipe.unapplied?.length ? `; not applied by the cell yet: ${parsed.recipe.unapplied.join(', ')}` : '';
            await done(rec, recipeStep, `${label}${withFiles} ${r.digest!.slice(0, 19)}, ${expose.length} exposed${unapplied}`);
            return true;
        };
        if (!recipe) {
            await finish(rec, recipeStep, 'skipped', cmd.recipe ? 'the recipe was read at another commit than the one booting' : 'the request carries no recipe');
        } else if (recipe.content === null) {
            rec.recipe = { path: recipe.path, sha, state: 'absent', ...(recipe.inference ? { inference: recipe.inference } : {}) };
            // Kodus could not infer one either: Kody reads the repository and writes it.
            const written = recipe.inference ? await this.writtenRecipe(cmd, previous, rec, sha, step) : undefined;
            if (written?.status === 'recipe') {
                const label = written.kept ? 'written by Kody (kept from the last setup)' : 'written by Kody';
                if (!(await useRecipe(RECIPE_PATH, written.content, label, 'authored', written.notes, written.files))) {
                    return this.close(rec, save);
                }
            } else if (written?.status === 'no_recipe') {
                await block(rec, recipeStep, { kind: 'no_recipe', signature: 'setup:no_recipe', message: `Kody could not write a recipe: ${written.reason}` });
                return this.close(rec, save);
            } else if (recipe.inference?.reason === 'no_build_files') {
                // No compose file and no Dockerfile either: the cell has nothing to boot (its no_environment), so say it here.
                await block(rec, recipeStep, { kind: 'no_recipe', signature: 'setup:no_recipe', message: recipe.inference.message });
                return this.close(rec, save);
            } else {
                const kody = written?.status === 'unavailable' ? `; Kody could not write one (${written.message})` : '';
                await finish(rec, recipeStep, 'skipped', `no ${recipe.path} on the default branch${recipe.inference ? '; Kodus could not infer one' : ''}${kody}`);
            }
        } else if (!(await useRecipe(recipe.path, recipe.content, recipe.origin === 'inferred' ? 'inferred by Kodus' : recipe.path, recipe.origin))) {
            return this.close(rec, save);
        }
        if (this.opts.devExpose) expose = this.opts.devExpose;

        const env = this.envs.envForSetup({
            ...(execution.admissionTicket ? { admissionTicket: execution.admissionTicket } : {}),
            correlationId: setupCorrelationId(cmd.key),
            organizationId: cmd.organizationId,
            setupKey: cmd.key,
            fullName: cmd.repositoryFullName ?? cmd.repositoryName,
            sealedRepoToken: cmd.repoToken ?? '',
            imageId: SETUP_IMAGE,
            expose,
        });

        const boot = await start(rec, 'boot');
        let claimId: string | undefined;
        let cancelled = false;
        let claimFailed = false;
        const bootKey = `setup:${cmd.key}`;
        try {
            // While the cell prepares the machine, its phases and the build's last
            // lines reach the setup's record (a live view, outside the journal).
            const watch = this.watchBoot(env, cmd.organizationId, cmd.environmentId, cmd.key, bootKey);
            const claim = await step('boot', () =>
                this.acquireWaitingForRoom(env, {
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
                }, cancellationSignal?.(), execution.noCapacityWait),
            ).finally(() => watch.stop());
            if (execution.noCapacityWait && isCapacityWait(claim)) throw new AdmissionCapacityLostError();
            // The boot's last progress stays on the record (journaled: a replay reads the same).
            const progress = await step('boot:progress', async () => (await env.progress?.({ organizationId: cmd.organizationId, idempotencyKey: bootKey }).catch(() => null)) ?? null);
            if (progress) rec.progress = progress;
            if (isBlocked(claim)) {
                const b = claim.blockers[0];
                // A boot that failed after its build left that cell its state: the next setup goes there.
                if (claim.cellId) rec.buildCellId = claim.cellId;
                if (b?.bundle) rec.failureBundle = b.bundle;
                // The cell kept the machines: they are not released here; they go at hardExpiresAt.
                if (claim.held) rec.diagnosticHold = { claimId: claim.held.claimId, cellId: claim.held.cellId, until: claim.held.hardExpiresAt };
                await block(rec, boot, {
                    kind: b?.kind ?? 'could_not_boot',
                    signature: b?.signature ?? 'setup:could_not_boot',
                    message: b?.message ?? 'the cell could not boot the environment',
                });
                rec.boots = withSetupBoot(rec.boots, boot, 'failed', b?.signature ?? 'setup:could_not_boot');
                return rec;
            }
            claimId = claim.claimId;
            rec.cellId = rec.buildCellId = claim.cellId;
            rec.imageId = SETUP_IMAGE;
            rec.expose = (claim.manifest?.expose?.length ? claim.manifest.expose : expose) as SetupExpose;
            if (claim.timing) rec.bootTiming = claim.timing;
            await done(rec, boot, `cell ${claim.cellId}`);
            rec.boots = withSetupBoot(rec.boots, boot, 'ready');

            const ready = await start(rec, 'ready');
            const check = await this.readyCheck(env, claim, rec.expose, rec.recipe ?? {}, `setup:${cmd.key}`, 'health', step);
            if (check.state === 'skipped') {
                await finish(rec, ready, 'skipped', 'no http service exposed: nothing to check');
            } else if (check.state === 'failed') {
                await block(rec, ready, check.blocker);
                return rec;
            } else {
                await done(rec, ready, `GET ${check.path} → ${check.status}`);
            }

            // image.bake (S-52); a skipped, refused or failed bake leaves the environment active without an image.
            let baked = false;
            const bake = await start(rec, 'bake');
            if (!env.bake) {
                await finish(rec, bake, 'skipped', 'this cell connection has no bake');
            } else if (rec.refSource !== 'default_branch' || !cmd.ref?.branch || cmd.ref.sha !== sha) {
                await finish(rec, bake, 'skipped', 'commit not checked as the default branch head by the product (S-52)');
            } else {
                const bakeEnv = env;
                const out: BakeOutcome | ClaimLeaseFailed = await step('bake', async () => {
                    const failure = await checkClaimLease(bakeEnv, claim.claimId, 'setup');
                    if (failure) return { claimFailure: failure };
                    return bakeEnv.bake!({ organizationId: cmd.organizationId, environmentId: cmd.environmentId, recipeSha: rec.recipe?.digest ?? sha, sha, claimId: claim.claimId }).catch(
                        (e: Error): BakeOutcome => ({ status: 'refused', code: 'bake_error', message: (e?.message ?? String(e)).slice(0, 200) }),
                    );
                });
                if ('claimFailure' in out) throwClaimLeaseFailure(out.claimFailure);
                if (out.status === 'accepted') await done(rec, bake, `image.bake accepted for ${cmd.ref.branch} ${sha.slice(0, 12)}`);
                else await finish(rec, bake, 'failed', `image.bake refused: ${out.code}`);
                baked = out.status === 'accepted';
                if (baked) rec.imageId = BAKED_IMAGE;
            }
            // pool.target to the cell that baked (S-52: only from its bake); a refusal leaves the environment active, with no pool.
            const pool = await start(rec, 'pool');
            if (cmd.poolSize === undefined || !env.poolTarget) {
                await finish(rec, pool, 'skipped', 'no pool size for this environment');
            } else if (!baked) {
                await finish(rec, pool, 'skipped', 'no bake to fill the pool from');
            } else {
                const poolEnv = env;
                const size = cmd.poolSize;
                const out: BakeOutcome = await step('pool', () =>
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
                if (out.status === 'accepted') await done(rec, pool, `${size} machine${size === 1 ? '' : 's'} kept ready from the bake`);
                // The cell is too old to make a sized pool: nothing failed and nothing in the recipe fixes it, as with no bake.
                else if (out.code === POOL_SIZE_UNSUPPORTED) await finish(rec, pool, 'skipped', out.message);
                else await finish(rec, pool, 'failed', `pool.target refused: ${out.code}`);
            }
            rec.state = 'active';
            if (rec.recipe?.origin === 'inferred' || rec.recipe?.origin === 'authored') rec.recipe.cleanBoots = cleanBootsOf(previous, rec);
            return rec;
        } catch (e) {
            if (isCancellation(e)) {
                cancelled = true;
                throw e;
            }
            claimFailed = e instanceof ClaimLeaseUnavailableError || e instanceof AdmissionCapacityLostError;
            const last = rec.steps[rec.steps.length - 1];
            await block(rec, last, {
                kind: claimFailed ? ((e as ClaimLeaseUnavailableError).code === 'security_violation' ? 'security_violation' : 'platform') : (e as { code?: string })?.code ?? 'setup_failed',
                // No cell to boot on has its own card; any other throw keeps the error's name.
                signature: (e as { code?: string })?.code === 'cell_unavailable' ? 'cell_unavailable' : `setup:${(e as Error)?.name ?? 'error'}`,
                message: blockerMessage((e as Error)?.message ?? String(e)),
            });
            return rec;
        } finally {
            if (!cancelled) {
                if (claimId) {
                    const id = claimId;
                    const release = await start(rec, 'release');
                    // A failed release is recorded and left to the reaper (the claim stays open until the hub records it).
                    const releaseError = await step('release', () => env.release(id).then(() => undefined, (e: Error) => (e?.message ?? String(e)).slice(0, 200)));
                    await done(rec, release, releaseError ? `release failed, the reaper retries: ${releaseError}` : undefined);
                }
                await this.close(rec, save);
                if (!claimFailed) {
                    await this.learn(previous, rec, step);
                    await this.tryFixes(cmd, previous, rec, step, clock, save, (text, label) =>
                        this.bootAttempt(env, cmd, sha, rec.recipe?.path ?? '.kodus/workspace.yaml', text, label, step, cancellationSignal, execution.noCapacityWait),
                    );
                }
            }
        }
    }

    /** The ready check of a booted claim: GET the health path on the public http service; under 500 is ready. */
    private async readyCheck(
        env: EnvironmentRuntime,
        claim: Pick<Claim, 'claimId' | 'hardExpiresAt'>,
        expose: SetupExpose,
        recipe: Pick<RecipeSummary, 'public' | 'health' | 'healthTimeoutSeconds'>,
        scope: string,
        stepName: string,
        step: SetupStepRunner,
    ): Promise<{ state: 'skipped' } | { state: 'done'; path: string; status: number } | { state: 'failed'; blocker: Omit<EnvironmentSetupBlocker, 'at'> }> {
        const target = readyTarget(expose, recipe, this.opts.healthPath);
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
                const at = this.now().toISOString();
                if (i > 0) await this.sleep(HEALTH_RETRY_INTERVAL_SECONDS * 1_000);
                const failure = await checkClaimLease(env, claimId, 'setup');
                if (failure) return { claimFailure: failure };
                const probed = await env.probe(claimId, readyProbe(target, { id: 'setup-ready', purpose: 'the environment answers after setup' }), stableStepId(scope, i, 'health'));
                return { out: probed, at, finishedAt: this.now().toISOString() };
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

    /**
     * One learn-loop attempt: the hypothesis recipe on a new clean setup claim
     * (its own idempotency key, never a pool, a bake or a diagnostic hold), the
     * same ready check, then the release. The recipe is never committed.
     */
    private async bootAttempt(
        env: EnvironmentRuntime,
        cmd: RuntimeEnvironmentSetupRequested,
        sha: string,
        path: string,
        text: string,
        label: string,
        step: SetupStepRunner,
        cancellationSignal?: () => AbortSignal | undefined,
        noCapacityWait = false,
    ): Promise<LearnBootOutcome> {
        const parsed = parseRecipeSummary(text);
        if ('error' in parsed) return { ready: false, blocker: { kind: 'recipe_invalid', signature: 'setup:recipe_invalid', message: parsed.error } };
        const resources = checkReservedRecipeResources(
            parsed.recipe.size,
            cmd.machineSize,
        );
        if (resources.ok === false) {
            return {
                ready: false,
                blocker: {
                    kind: 'resources',
                    signature: `recipe_${resources.reason}`,
                    message: resources.message,
                },
            };
        }
        let claimId: string | undefined;
        let cancelled = false;
        try {
            const claim = await step(`learn:boot:${label}`, () =>
                this.acquireWaitingForRoom(env, {
                    organizationId: cmd.organizationId,
                    environmentId: cmd.environmentId,
                    imageId: SETUP_IMAGE,
                    ref: { side: 'setup', sha },
                    consumer: 'setup',
                    idempotencyKey: `setup:${cmd.key}:${label}`,
                    recipe: { path, content: text, digest: recipeDigest(text) },
                    ...(cmd.machineSize ? { size: cmd.machineSize } : {}),
                }, cancellationSignal?.(), noCapacityWait),
            );
            if (noCapacityWait && isCapacityWait(claim)) throw new AdmissionCapacityLostError();
            if (isBlocked(claim)) {
                const b = claim.blockers[0];
                return {
                    ready: false,
                    blocker: {
                        kind: b?.kind ?? 'could_not_boot',
                        signature: b?.signature ?? 'setup:could_not_boot',
                        message: blockerMessage(b?.message ?? 'the cell could not boot the environment'),
                    },
                    ...(b?.bundle ? { bundle: b.bundle } : {}),
                };
            }
            claimId = claim.claimId;
            const expose = (claim.manifest?.expose?.length ? claim.manifest.expose : parsed.recipe.expose) as SetupExpose;
            const check = await this.readyCheck(env, claim, expose, parsed.recipe, `setup:${cmd.key}:${label}`, `learn:health:${label}`, step);
            return check.state === 'failed' ? { ready: false, blocker: check.blocker } : { ready: true };
        } catch (e) {
            if (isCancellation(e)) {
                cancelled = true;
                throw e;
            }
            if (e instanceof ClaimLeaseUnavailableError || e instanceof AdmissionCapacityLostError) throw e;
            return {
                ready: false,
                blocker: {
                    kind: 'setup_failed',
                    signature: `setup:${(e as Error)?.name ?? 'error'}`,
                    message: blockerMessage((e as Error)?.message ?? String(e)),
                },
            };
        } finally {
            if (claimId && !cancelled) {
                const id = claimId;
                await step(`learn:release:${label}`, () =>
                    env.release(id).then(
                        () => undefined,
                        (e: Error) => (e?.message ?? String(e)).slice(0, 200),
                    ),
                );
            }
        }
    }

    /**
     * The recipe Kody writes when the default branch has none and Kodus could
     * not infer one. An authored recipe that booted in the environment's last
     * setup is kept, with no new run: the same text boots again, so its clean
     * boots add up to the PR (ENV-06). Otherwise one product call, as a step:
     * a replay reads the recorded answer instead of asking again.
     */
    private async writtenRecipe(
        cmd: RuntimeEnvironmentSetupRequested,
        previous: EnvironmentSetupRecord | null,
        rec: EnvironmentSetupRecord,
        sha: string,
        step: SetupStepRunner,
    ): Promise<WrittenRecipe | undefined> {
        // Only the default-branch head the product resolved, never a dev override (§6).
        if (rec.refSource !== 'default_branch') return undefined;
        const last = previous && previous.key !== cmd.key && previous.state === 'active' && previous.recipe?.origin === 'authored' ? previous.recipe : undefined;
        // Kept with the files it booted with: the digest that proved it covers both.
        if (last?.state === 'found' && last.content) {
            return { status: 'recipe', content: last.content, ...(last.notes ? { notes: last.notes } : {}), ...(last.files?.length ? { files: last.files } : {}), kept: true };
        }
        const author = this.opts.author;
        const llmToken = cmd.llmToken;
        if (!author || !llmToken) return undefined;
        const out: RecipeAuthorOutcome = await step('recipe:author', () =>
            author
                .author({ organizationId: cmd.organizationId, llmToken, setupKey: cmd.key, sha })
                .catch((e: Error): RecipeAuthorOutcome => ({ status: 'unavailable', code: 'llm_unavailable', message: (e?.message ?? String(e)).slice(0, 200) })),
        );
        if (out.status === 'submitted') {
            return { status: 'recipe', content: out.recipe, ...(out.notes ? { notes: out.notes } : {}), ...(out.files?.length ? { files: out.files } : {}), kept: false };
        }
        if (out.status === 'no_recipe') return { status: 'no_recipe', reason: out.reason };
        setupLogger.warn({ msg: 'setup.recipe_author_unavailable', environmentId: rec.environmentId, code: out.code, error: out.message });
        return { status: 'unavailable', message: out.message };
    }

    /** Kody's learn loop on a blocked setup (learn-loop.ts). Never fails the setup. */
    private async tryFixes(
        cmd: RuntimeEnvironmentSetupRequested,
        previous: EnvironmentSetupRecord | null,
        rec: EnvironmentSetupRecord,
        step: SetupStepRunner,
        clock: () => Promise<string>,
        save: (rec: EnvironmentSetupRecord) => Promise<void>,
        boot: (text: string, label: string) => Promise<LearnBootOutcome>,
    ) {
        if (!this.loop || rec.state !== 'blocked') return;
        try {
            await this.loop.run({ cmd, rec, previous, step, clock, save, boot });
        } catch (e) {
            if (isCancellation(e)) throw e;
            if (e instanceof AdmissionCapacityLostError) {
                rec.blockers.push({ kind: 'platform', signature: e.code, message: e.message, at: await clock() });
                await save(rec);
                return;
            }
            setupLogger.warn({ msg: 'setup.learn_failed', environmentId: rec.environmentId, error: (e as Error)?.message });
        }
    }

    /** A default-branch setup that booted right after a blocked one proves the fix that changed: it becomes a lesson. Never fails the setup. */
    /** Polls the boot's progress into the record until stopped; best effort, never failing the setup. */
    private watchBoot(env: EnvironmentRuntime, organizationId: string, environmentId: string, key: string, idempotencyKey: string) {
        const saveProgress = this.store.saveProgress?.bind(this.store);
        if (!env.progress || !saveProgress) return { stop() {} };
        let stopped = false;
        let last = '';
        const tick = async () => {
            const p = await env.progress!({ organizationId, idempotencyKey }).catch(() => null);
            if (!p || stopped) return;
            const seen = JSON.stringify(p);
            if (seen === last) return;
            last = seen;
            await saveProgress(environmentId, key, p).catch(() => undefined);
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

    private async learn(previous: EnvironmentSetupRecord | null, rec: EnvironmentSetupRecord, step: SetupStepRunner) {
        const lessons = this.opts.lessons;
        if (!lessons || rec.state !== 'active' || previous?.state !== 'blocked' || rec.refSource !== 'default_branch') return;
        try {
            await step('lessons', async () => {
                const approvedHosts = await lessons.approvedHosts(rec.organizationId, rec.environmentId);
                for (const lesson of deriveLessons({ previous, current: rec, approvedHosts, at: rec.finishedAt ?? rec.updatedAt })) await lessons.store.record(lesson);
            });
        } catch (e) {
            if (isCancellation(e)) throw e;
            setupLogger.warn({ msg: 'setup.lessons_failed', environmentId: rec.environmentId, error: (e as Error)?.message });
        }
    }

    private async close(rec: EnvironmentSetupRecord, save: (rec: EnvironmentSetupRecord) => Promise<void>) {
        rec.finishedAt ??= rec.updatedAt;
        if (rec.state === 'setting_up') rec.state = rec.blockers.length ? 'blocked' : 'active';
        const last = lastActiveOf(rec);
        if (last) rec.lastActive = last;
        await save(rec);
        return rec;
    }
}

/**
 * The cell a new setup carries from the last one of the same org: where its last
 * boot built (its build state and cache), else the active setup's cell (a record
 * older than buildCellId). Never `cellId`: the new setup has no active cell yet.
 */
export function carriedBuildCell(previous: EnvironmentSetupRecord | null, organizationId: string): { buildCellId?: string } {
    if (!previous || previous.organizationId !== organizationId) return {};
    const cell = previous.buildCellId ?? previous.cellId;
    return cell ? { buildCellId: cell } : {};
}

/** How often a running boot's progress is read from the hub. */
export const BOOT_PROGRESS_POLL_MS = 3_000;

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

/** How much of a blocker's message is kept. */
export const BLOCKER_MESSAGE_MAX = 500;

/**
 * A blocker's message: its start (the step and what ran) and its end (where a
 * build or compose says what failed), never only the start. The cell's reason
 * for a failed build is the docker command line first and the cause last.
 */
export function blockerMessage(text: string, max = BLOCKER_MESSAGE_MAX): string {
    const chars = Array.from(text);
    if (chars.length <= max) return text;
    const sep = ' … ';
    const head = Math.floor(max * 0.3);
    return chars.slice(0, head).join('') + sep + chars.slice(chars.length - (max - head - sep.length)).join('');
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** The worker's setup options from its config; a malformed dev override fails the boot. */
export function setupOptionsFrom(c: { devSha?: string; devExposeJson?: string; healthPath?: string }): SetupOptions {
    const devSha = c.devSha?.trim() || undefined;
    if (devSha && !SHA_RE.test(devSha)) throw new Error('RUNTIME_SETUP_DEV_SHA must be a 40-hex commit SHA');
    let devExpose: SetupExpose | undefined;
    if (c.devExposeJson?.trim()) {
        let json: unknown;
        try {
            json = JSON.parse(c.devExposeJson);
        } catch {
            throw new Error('RUNTIME_SETUP_EXPOSE must be a JSON list of { service, port, kind }');
        }
        const parsed = z.array(ExposeSchema).max(32).safeParse(json);
        if (!parsed.success) throw new Error('RUNTIME_SETUP_EXPOSE must be a JSON list of { service, port, kind }');
        devExpose = parsed.data;
    }
    return { devSha, devExpose, healthPath: c.healthPath?.trim() || undefined };
}

/** The same, from environment-style keys (tests and scripts). */
export function loadSetupOptions(env: Record<string, string | undefined>): SetupOptions {
    return setupOptionsFrom({ devSha: env.RUNTIME_SETUP_DEV_SHA, devExposeJson: env.RUNTIME_SETUP_EXPOSE, healthPath: env.RUNTIME_SETUP_HEALTH_PATH });
}
