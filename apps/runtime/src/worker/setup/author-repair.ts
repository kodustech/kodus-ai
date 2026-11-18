import type { RecipeAuthorLast } from '@libs/runtime/contracts/recipe-author';
import { RECIPE_PATH } from '@libs/runtime/protocol/recipe';
import { type EnvironmentSetupRepair, recipeDigest } from '@libs/runtime/run';

import type { RecipeAuthorOutcome } from '../agent/http-recipe-author';
import { repairFailureOf } from './recipe-failure';
import { adoptRecipe, checkRecipe } from './resolve-recipe';
import { setupLogger, type SetupRun } from './setup-scope';
import { askTokens, useTokens } from './setup-tokens';

/**
 * Repair n of Kody's recipe, after the boot that just ended blocked on
 * the recipe's account (repairFailureOf): that recipe, its files and the
 * failure go back to Kody's author as `last`, as the next setup would
 * send them, and the recipe Kody writes becomes the one to boot. True
 * when there is a new recipe to boot; otherwise the failed boot's
 * blocker stays the setup's. Never under a diagnostic hold (the failure
 * is kept to be looked at), never past the setup's repairs.
 */
export async function authorRepair(run: SetupRun, n: number): Promise<boolean> {
    const { cmd, rec, journal } = run;
    const repairs = run.deps.repairs;
    const author = run.deps.opts.author;
    const llmToken = cmd.llmToken;
    if (n > repairs || !author || !llmToken || cmd.diagnosticHold) return false;
    const failedBoot = repairFailureOf(rec);
    const failed = rec.recipe;
    const blocker = rec.blockers[0];
    if (!failedBoot || !failed?.content || !failed.digest || !blocker) return false;
    const failure = failedBoot.failure;
    const last: RecipeAuthorLast = {
        recipe: failed.content,
        ...(failed.files?.length ? { files: failed.files } : {}),
        ...(failed.notes ? { notes: failed.notes.slice(0, 1_000) } : {}),
        failure,
    };
    // Every recipe that failed in this setup: Kody answering one of them again is no repair.
    const failedDigests = new Set([...(rec.repairs ?? []).map((r) => r.failedDigest), failed.digest]);
    const entry: EnvironmentSetupRepair = {
        n,
        max: repairs,
        blocker: { kind: failedBoot.kind, signature: failure.signature, title: failure.title.slice(0, 200) },
        failedDigest: failed.digest,
        outcome: 'writing',
        at: await journal.clock(),
    };
    // Running again while Kody writes: the product's author answers only a setup still running.
    rec.state = 'setting_up';
    delete rec.finishedAt;
    rec.blockers = [];
    rec.repairs = [...(rec.repairs ?? []), entry];
    journal.repair = n;
    const recipeRepair = await journal.start('recipe');
    const stop = async (outcome: EnvironmentSetupRepair['outcome'], state: 'failed' | 'skipped', detail: string) => {
        entry.outcome = outcome;
        // The setup ends on the boot that failed: its blocker, its bundle.
        rec.blockers = [blocker];
        rec.state = 'blocked';
        rec.finishedAt = await journal.clock();
        await journal.finish(recipeRepair, state, detail);
        return false;
    };
    if (run.tokens.needsFresh) {
        // The cell revoked the tokens the last boot downloaded with: the new boot's are asked
        // first, so Kody never rewrites a recipe no boot could download the repository for.
        const fresh = await askTokens(run, `tokens:repair:${n}`, `repair-${n}`);
        if (fresh.status === 'unavailable') {
            setupLogger.warn({ msg: 'setup.repair_tokens_unavailable', environmentId: rec.environmentId, repair: n, error: fresh.message });
            return stop('no_token', 'skipped', `Kody's rewrite was not asked: a new boot could not download the repository again (${fresh.message})`);
        }
        useTokens(run, fresh, entry.at);
    }
    const out: RecipeAuthorOutcome = await run.step(`recipe:repair:${n}`, () => {
        // A cancelled setup stops here, between two attempts (read inside the step, as the boot does).
        run.cancellationSignal?.()?.throwIfAborted();
        return author
            .author({ organizationId: cmd.organizationId, llmToken, setupKey: cmd.key, sha: run.sha, attempt: `repair-${n}`, last })
            .catch((e: Error): RecipeAuthorOutcome => ({ status: 'unavailable', code: 'llm_unavailable', message: (e?.message ?? String(e)).slice(0, 200) }));
    });
    if (out.status === 'unavailable') {
        setupLogger.warn({ msg: 'setup.recipe_repair_unavailable', environmentId: rec.environmentId, repair: n, code: out.code, error: out.message });
        return stop(out.code === 'llm_budget_exceeded' ? 'budget' : 'unavailable', 'skipped', `Kody could not rewrite the recipe: ${out.message}`);
    }
    if (out.status === 'no_recipe') return stop('no_recipe', 'failed', `Kody wrote no other recipe: ${out.reason}`);
    const digest = recipeDigest(out.recipe, out.files);
    if (failedDigests.has(digest)) return stop('identical', 'failed', `Kody answered a recipe that already failed in this setup, unchanged (${digest.slice(0, 19)})`);
    entry.recipeDigest = digest;
    const checked = checkRecipe(run, out.recipe);
    if ('blocker' in checked) return stop('refused', 'failed', `Kody's new recipe was refused: ${checked.blocker.message}`);
    const detail = adoptRecipe(run, { path: RECIPE_PATH, content: out.recipe, origin: 'authored', notes: out.notes, files: out.files, adjusted: out.adjusted, authorVersion: out.authorVersion }, checked.recipe);
    if (run.deps.opts.devExpose) run.expose = run.deps.opts.devExpose;
    // The failed boot's evidence went to Kody; what the record keeps from here is the new boot's.
    delete rec.failureBundle;
    delete rec.progress;
    entry.outcome = 'booting';
    await journal.done(recipeRepair, `written by Kody (repair ${n} of ${repairs}, after the boot failed on ${failure.signature})${detail}`);
    return true;
}
