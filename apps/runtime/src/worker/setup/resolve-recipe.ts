import type { SetupRecipeOrigin } from '@libs/runtime/api/domain/runtime-commands';
import type { AuthoredFile } from '@libs/runtime/contracts/authored-files';
import type { RecipeAuthorLast } from '@libs/runtime/contracts/recipe-author';
import { RECIPE_PATH } from '@libs/runtime/protocol/recipe';
import {
    type EnvironmentRecipeRecord,
    type EnvironmentSetupBlocker,
    type EnvironmentSetupRecord,
    type EnvironmentSetupStep,
    parseRecipeSummary,
    recipeDigest,
    type RecipeSummary,
    workspaceNeedsError,
} from '@libs/runtime/run';
import { reauthorRevision, type RecipeAuthorRevision, UNVERSIONED_RECIPE_AUTHOR_VERSION } from '@libs/runtime/run/recipe-author-version';
import { checkReservedRecipeResources } from '@libs/runtime/run/recipe-resources';

import type { RecipeAuthorOutcome } from '../agent/http-recipe-author';
import { lastAuthoredRecipe } from './recipe-failure';
import { setupLogger, type SetupRun } from './setup-scope';

/**
 * What the recipe step got from Kody: a recipe, Kody's reason for none, or no answer at all.
 * `label`: how the recipe step says where the recipe came from (written, kept, reused, rewritten).
 */
type WrittenRecipe =
    | {
          status: 'recipe';
          content: string;
          notes?: string;
          files?: AuthoredFile[];
          label: string;
          adjusted?: string[];
          /** The version of the author's instructions that wrote it (recipe-author-version.ts); absent: not known. */
          authorVersion?: number;
          /** This setup asked Kody to write it again for a new version of the instructions, and how that ended. */
          reauthor?: NonNullable<EnvironmentSetupRecord['reauthor']>;
      }
    | { status: 'no_recipe'; reason: string }
    | { status: 'unavailable'; message: string };

const KEPT_LABEL = 'written by Kody (kept from the last setup)';

/** A recipe text the setup boots, and where it came from. `files`: what Kody wrote with an authored recipe; recorded, digested and booted with it. */
export interface AdoptedRecipe {
    path: string;
    content: string;
    origin?: SetupRecipeOrigin;
    notes?: string;
    files?: AuthoredFile[];
    adjusted?: string[];
    authorVersion?: number;
}

/** A recipe text goes through the same checks whoever wrote it (parseRecipe here, the cell's own on boot). */
export function checkRecipe(run: SetupRun, content: string): { blocker: Omit<EnvironmentSetupBlocker, 'at'> } | { recipe: RecipeSummary } {
    const { cmd } = run;
    const parsed = parseRecipeSummary(content);
    if ('error' in parsed) return { blocker: { kind: 'recipe_invalid', signature: 'setup:recipe_invalid', message: parsed.error } };
    const resources = checkReservedRecipeResources(
        parsed.recipe.size,
        cmd.machineSize,
    );
    if (resources.ok === false) {
        return {
            blocker: {
                kind: 'resources',
                signature: `recipe_${resources.reason}`,
                message: resources.message,
            },
        };
    }
    // A recipe that needs another repository boots it only as a repository of the environment, under its alias.
    const needs = cmd.workspace ? workspaceNeedsError(parsed.recipe.needs, cmd.workspace) : undefined;
    if (needs) return { blocker: { kind: 'other_repo', signature: 'recipe_needs_member', message: needs.message, alias: needs.alias } };
    return { recipe: parsed.recipe };
}

/** The recipe the next boot boots: recorded on the setup, its expose list taken. Returns what the recipe step says after its label. */
export function adoptRecipe(run: SetupRun, a: AdoptedRecipe, parsed: RecipeSummary): string {
    const { path, content, origin, notes, files, adjusted, authorVersion } = a;
    const r: EnvironmentRecipeRecord = {
        path,
        sha: run.sha,
        state: 'found',
        digest: recipeDigest(content, files),
        content,
        ...(files?.length ? { files } : {}),
        ...(parsed.public ? { public: parsed.public } : {}),
        ...(parsed.health ? { health: parsed.health } : {}),
        ...(parsed.healthTimeoutSeconds !== undefined ? { healthTimeoutSeconds: parsed.healthTimeoutSeconds } : {}),
        ...(origin && origin !== 'repository' ? { origin } : {}),
        ...(notes ? { notes } : {}),
        ...(adjusted?.length ? { adjusted } : {}),
        ...(origin === 'authored' && authorVersion ? { authorVersion } : {}),
    };
    run.rec.recipe = r;
    run.expose = parsed.expose;
    run.bootRecipe = { path, content, ...(files?.length ? { files } : {}) };
    const withFiles = files?.length ? ` with ${files.length} file${files.length === 1 ? '' : 's'} under .kodus/` : '';
    // A key the cell boots without is said here, once for the setup and every Run on it, never left to look applied.
    const unapplied = parsed.unapplied?.length ? `; not applied by the cell yet: ${parsed.unapplied.join(', ')}` : '';
    // What Kodus rewrote in Kody's compose files (authored-compose-sanitiser) is said too; the whole list is on the recipe record.
    const rewrote = adjusted?.length ? `; Kodus changed Kody's compose files: ${adjusted.join('; ')}` : '';
    return `${withFiles} ${r.digest!.slice(0, 19)}, ${run.expose.length} exposed${unapplied}${rewrote}`;
}

/** Checks and adopts a recipe as the recipe step's answer; false when the setup ended blocked on it. */
async function useRecipe(run: SetupRun, recipeStep: EnvironmentSetupStep, a: AdoptedRecipe & { label: string }): Promise<boolean> {
    const checked = checkRecipe(run, a.content);
    if ('blocker' in checked) {
        await run.journal.block(recipeStep, checked.blocker);
        return false;
    }
    await run.journal.done(recipeStep, `${a.label}${adoptRecipe(run, a, checked.recipe)}`);
    return true;
}

/**
 * The recipe step: the recipe the product read at the setup's commit (§6:
 * always the default branch), or the one Kody writes when there is none and
 * Kodus could not infer one. False when the setup ended blocked on it.
 */
export async function resolveRecipe(run: SetupRun): Promise<boolean> {
    const { cmd, rec, journal, sha } = run;
    const recipeStep = await journal.start('recipe');
    run.expose = [];
    const recipe = cmd.recipe && cmd.recipe.sha === sha ? cmd.recipe : undefined;
    // What the cell boots with: the recipe the product read, or the one Kody wrote.
    run.bootRecipe = recipe ? { path: recipe.path, content: recipe.content } : undefined;
    if (!recipe) {
        await journal.finish(recipeStep, 'skipped', cmd.recipe ? 'the recipe was read at another commit than the one booting' : 'the request carries no recipe');
    } else if (recipe.content === null) {
        rec.recipe = { path: recipe.path, sha, state: 'absent', ...(recipe.inference ? { inference: recipe.inference } : {}) };
        // Kodus could not infer one either: Kody reads the repository and writes it.
        const written = recipe.inference ? await writtenRecipe(run) : undefined;
        if (written?.status === 'recipe') {
            if (written.reauthor) rec.reauthor = written.reauthor;
            const adopted = { path: RECIPE_PATH, content: written.content, label: written.label, origin: 'authored' as const, notes: written.notes, files: written.files, adjusted: written.adjusted, authorVersion: written.authorVersion };
            if (!(await useRecipe(run, recipeStep, adopted))) return false;
        } else if (written?.status === 'no_recipe') {
            await journal.block(recipeStep, { kind: 'no_recipe', signature: 'setup:no_recipe', message: `Kody could not write a recipe: ${written.reason}` });
            return false;
        } else if (recipe.inference?.reason === 'no_build_files') {
            // No compose file and no Dockerfile either: the cell has nothing to boot (its no_environment), so say it here.
            // When Kody was not reached (budget spent, product down), say so: the inference alone reads as Kody's verdict.
            const kody = written?.status === 'unavailable' ? ` Kody could not write one: ${written.message}.` : '';
            await journal.block(recipeStep, { kind: 'no_recipe', signature: 'setup:no_recipe', message: `${recipe.inference.message}${kody}` });
            return false;
        } else {
            const kody = written?.status === 'unavailable' ? `; Kody could not write one (${written.message})` : '';
            await journal.finish(recipeStep, 'skipped', `no ${recipe.path} on the default branch${recipe.inference ? '; Kodus could not infer one' : ''}${kody}`);
        }
    } else if (!(await useRecipe(run, recipeStep, { path: recipe.path, content: recipe.content, label: recipe.origin === 'inferred' ? 'inferred by Kodus' : recipe.path, origin: recipe.origin }))) {
        return false;
    }
    if (run.deps.opts.devExpose) run.expose = run.deps.opts.devExpose;
    return true;
}

/**
 * The recipe Kody writes when the default branch has none and Kodus could
 * not infer one. The authored recipe of the environment's last setup
 * comes first (lastAuthoredRecipe): at the same commit, one that booted
 * is kept with no call at all, so its clean boots add up to the PR
 * (ENV-06). At a new commit the product checks it again there and answers
 * it as is with no model call (`reused`); only when those checks refuse
 * it, or when its last boot failed, does Kody write a new one, from it and
 * that failure. Without the product (no client, no token, no answer), one
 * that booted is kept as before. One product call, as a step: a replay
 * reads the recorded answer instead of asking again.
 */
async function writtenRecipe(run: SetupRun): Promise<WrittenRecipe | undefined> {
    const { cmd, previous, rec, sha, step } = run;
    // Only the default-branch head the product resolved, never a dev override (§6).
    if (rec.refSource !== 'default_branch') return undefined;
    const prior = lastAuthoredRecipe(previous, cmd.key);
    const booted = prior && !prior.last.failure ? prior.last : undefined;
    // The version of the instructions that wrote the last recipe: the next one keeps it while it is the same recipe.
    const priorVersion = prior ? (previous?.recipe?.authorVersion ?? UNVERSIONED_RECIPE_AUTHOR_VERSION) : undefined;
    // Kept with the files it booted with: the digest that proved it covers both.
    const kept = (label: string, reauthor?: NonNullable<EnvironmentSetupRecord['reauthor']>): WrittenRecipe => ({
        status: 'recipe',
        content: booted!.recipe,
        ...(booted!.notes ? { notes: booted!.notes } : {}),
        ...(booted!.files?.length ? { files: booted!.files } : {}),
        label,
        ...(priorVersion ? { authorVersion: priorVersion } : {}),
        ...(reauthor ? { reauthor } : {}),
    });
    const author = run.deps.opts.author;
    const llmToken = cmd.llmToken;
    // A recipe that booted, written before a revision of the instructions that recipes must get: written again
    // once, for this environment and that version, at this commit or a new one (recipe-author-version.ts).
    const revision = booted && author && llmToken ? reauthorRevision(priorVersion, previous?.reauthor?.version, { recipe: booted.recipe, ...(booted.notes ? { notes: booted.notes } : {}), ...(booted.files ? { files: booted.files } : {}) }) : undefined;
    if (revision) return reauthoredRecipe(run, booted!, priorVersion!, revision, kept);
    if (booted && (prior!.sha === sha || !author || !llmToken)) return kept(KEPT_LABEL);
    if (!author || !llmToken) return undefined;
    const out: RecipeAuthorOutcome = await step('recipe:author', () =>
        author
            .author({ organizationId: cmd.organizationId, llmToken, setupKey: cmd.key, sha, attempt: 'author-0', ...(prior ? { last: prior.last } : {}) })
            .catch((e: Error): RecipeAuthorOutcome => ({ status: 'unavailable', code: 'llm_unavailable', message: (e?.message ?? String(e)).slice(0, 200) })),
    );
    if (out.status === 'submitted') {
        const label = out.reused
            ? 'written by Kody (reused from the last setup that booted: it passes the checks at this commit, no model call)'
            : prior?.last.failure
              ? `written by Kody (rewritten after the last setup's recipe failed on ${prior.last.failure.signature})`
              : prior
                ? "written by Kody (rewritten: the last setup's recipe no longer passes the checks at this commit)"
                : 'written by Kody';
        return {
            status: 'recipe',
            content: out.recipe,
            ...(out.notes ? { notes: out.notes } : {}),
            ...(out.files?.length ? { files: out.files } : {}),
            label,
            ...(out.adjusted?.length ? { adjusted: out.adjusted } : {}),
            // Reused as it was: the version that wrote it still holds.
            ...(out.reused ? (priorVersion ? { authorVersion: priorVersion } : {}) : out.authorVersion ? { authorVersion: out.authorVersion } : {}),
        };
    }
    // Kody wrote none at this commit, but the last recipe booted: it is kept, and the step says Kody found none here.
    if (out.status === 'no_recipe') return booted ? kept(`${KEPT_LABEL}; Kody wrote no recipe at this commit: ${out.reason}`) : { status: 'no_recipe', reason: out.reason };
    setupLogger.warn({ msg: 'setup.recipe_author_unavailable', environmentId: rec.environmentId, code: out.code, error: out.message });
    // No answer is no verdict: a recipe that booted is kept, as without the product, and the step says it was not checked here.
    if (booted) return kept(`${KEPT_LABEL}; not checked at this commit: ${out.message}`);
    return { status: 'unavailable', message: out.message };
}

/**
 * Kody writes the environment's recipe again under a revision of the
 * author's instructions that recipes must get (recipe-author-version.ts),
 * once: the record keeps the version tried (`reauthor`), whatever the
 * answer, and the next setups never ask for it again. The recipe that
 * booted stays when Kody writes none that passes the checks; an answer
 * that never came (budget, product down) keeps it too, and is asked again
 * by the next setup. One product call, as its own step.
 */
async function reauthoredRecipe(
    run: SetupRun,
    booted: RecipeAuthorLast,
    from: number,
    revision: RecipeAuthorRevision,
    kept: (label: string, reauthor?: NonNullable<EnvironmentSetupRecord['reauthor']>) => WrittenRecipe,
): Promise<WrittenRecipe> {
    const { cmd, rec, sha, step } = run;
    const author = run.deps.opts.author!;
    const llmToken = cmd.llmToken!;
    const out: RecipeAuthorOutcome = await step('recipe:reauthor', () =>
        author
            .author({ organizationId: cmd.organizationId, llmToken, setupKey: cmd.key, sha, attempt: 'author-0', last: booted, reauthor: { from, to: revision.version } })
            .catch((e: Error): RecipeAuthorOutcome => ({ status: 'unavailable', code: 'llm_unavailable', message: (e?.message ?? String(e)).slice(0, 200) })),
    );
    const tried = (outcome: NonNullable<EnvironmentSetupRecord['reauthor']>['outcome']) => ({ version: revision.version, from, reason: revision.reason, outcome });
    if (out.status === 'unavailable') {
        setupLogger.warn({ msg: 'setup.recipe_reauthor_unavailable', environmentId: rec.environmentId, version: revision.version, code: out.code, error: out.message });
        return kept(`${KEPT_LABEL}; not written again for author v${revision.version} yet: ${out.message}`);
    }
    if (out.status === 'no_recipe') {
        return kept(`${KEPT_LABEL}; Kody's rewrite for author v${revision.version} did not pass its checks (${out.reason}), so the recipe that booted stays`, tried('kept'));
    }
    // An older product answers the last recipe as is (reused): nothing was written again, nothing was tried.
    if (out.reused) return kept(KEPT_LABEL);
    if (recipeDigest(out.recipe, out.files) === recipeDigest(booted.recipe, booted.files)) {
        const same = kept(`written by Kody (author v${revision.version} leaves this recipe as it was; its rule: ${revision.reason})`, tried('unchanged'));
        return same.status === 'recipe' ? { ...same, authorVersion: revision.version } : same;
    }
    return {
        status: 'recipe',
        content: out.recipe,
        ...(out.notes ? { notes: out.notes } : {}),
        ...(out.files?.length ? { files: out.files } : {}),
        // The revision's reason is the rule the recipe was written again for, never what the new recipe does: a
        // rule has exceptions (demo-nextjs keeps `next dev` for next/font/google). Kody's notes, on the recipe card, say it.
        // The notes stay out of the step (a step's detail never carries text written from the repository).
        label: `recipe updated to author v${revision.version} (its rule: ${revision.reason})${out.notes ? "; Kody's notes say what it does now" : ''}`,
        ...(out.adjusted?.length ? { adjusted: out.adjusted } : {}),
        authorVersion: out.authorVersion ?? revision.version,
        reauthor: tried('updated'),
    };
}
