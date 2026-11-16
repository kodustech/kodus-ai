import { deriveLessons } from '@libs/runtime/blockers/lessons';
import { type EnvironmentRuntime, isBlocked, isCapacityWait } from '@libs/runtime/environment';
import { parseRecipeSummary, recipeDigest } from '@libs/runtime/run';
import { checkReservedRecipeResources } from '@libs/runtime/run/recipe-resources';

import { AdmissionCapacityLostError } from '../env/admission-errors';
import { ClaimLeaseUnavailableError } from '../env/claim-liveness';
import { isCancellation } from '../workflow-cancellation';
import { blockerMessage } from './blocker-message';
import { acquireForSetup, readyCheck } from './boot-once';
import type { LearnBootOutcome, LearnLoopContext } from './learn-loop';
import { envFor, SETUP_IMAGE, type SetupExpose, setupLogger, type SetupRun } from './setup-scope';
import { freshRefs, learnTokens } from './setup-tokens';

/**
 * What a setup that ended learns, after its last save: the lesson a clean
 * boot after a blocked setup proves (ADR-018), and Kody's learn loop on a
 * blocked one (learn-loop.ts), whose clean boots start from `lastEnv`, the
 * runtime of the setup's last boot, or one with new tokens per boot. Never
 * fails the setup.
 */
export async function learnFromSetup(run: SetupRun, lastEnv: EnvironmentRuntime): Promise<void> {
    const { cmd, rec } = run;
    await recordLessons(run);
    // The setup's boots spent their tokens: each clean boot of the learn loop asks the product for its own.
    const tokens = run.tokens.needsFresh ? (k: number) => learnTokens(run, k) : undefined;
    await tryFixes(
        run,
        (text, label, fresh) =>
            bootAttempt(run, fresh ? envFor(run, fresh.repoToken, freshRefs(cmd, fresh)) : lastEnv, rec.recipe?.path ?? '.kodus/workspace.yaml', text, label),
        tokens,
    );
}

/** A default-branch setup that booted right after a blocked one proves the fix that changed: it becomes a lesson. Never fails the setup. */
async function recordLessons(run: SetupRun): Promise<void> {
    const { previous, rec, step } = run;
    const lessons = run.deps.opts.lessons;
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

/** Kody's learn loop on a blocked setup (learn-loop.ts). Never fails the setup. */
async function tryFixes(run: SetupRun, boot: LearnLoopContext['boot'], tokens?: LearnLoopContext['tokens']): Promise<void> {
    const { cmd, previous, rec, step, journal } = run;
    const loop = run.deps.loop;
    if (!loop || rec.state !== 'blocked') return;
    try {
        await loop.run({ cmd, rec, previous, step, clock: journal.clock, save: journal.save, boot, ...(tokens ? { tokens } : {}) });
    } catch (e) {
        if (isCancellation(e)) throw e;
        if (e instanceof AdmissionCapacityLostError) {
            rec.blockers.push({ kind: 'platform', signature: e.code, message: e.message, at: await journal.clock() });
            await journal.save(rec);
            return;
        }
        setupLogger.warn({ msg: 'setup.learn_failed', environmentId: rec.environmentId, error: (e as Error)?.message });
    }
}

/**
 * One learn-loop attempt: the hypothesis recipe on a new clean setup claim
 * (its own idempotency key, never a pool, a bake or a diagnostic hold), the
 * same ready check, then the release. The recipe is never committed.
 */
async function bootAttempt(run: SetupRun, env: EnvironmentRuntime, path: string, text: string, label: string): Promise<LearnBootOutcome> {
    const { cmd, deps, sha, step, cancellationSignal } = run;
    const noCapacityWait = run.execution.noCapacityWait ?? false;
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
            acquireForSetup(deps, env, {
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
        const check = await readyCheck(deps, env, claim, expose, parsed.recipe, `setup:${cmd.key}:${label}`, `learn:health:${label}`, step);
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
