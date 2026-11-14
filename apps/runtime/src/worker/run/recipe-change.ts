import { recipeFilesChangedBy } from '@libs/runtime/contracts/enums';
import type { RuntimeRunRequested } from '@libs/runtime/run';

type RecipeFacts = Pick<RuntimeRunRequested, 'diff' | 'prChangedRecipeFiles' | 'environment' | 'diffTruncated'>;

/**
 * Recipe files the PR changes (S-19) whose PR copy the Run never boots: among
 * the `.kodus/` files the product read from the whole file list and what the
 * diff shows, the workspace files and the setup's authored files, when the
 * claims carry the recipe (`environment.recipe`, set by the RunRequested
 * handler from the setup record). Every other `.kodus/` file boots from the PR.
 */
export const recipeChangedInPr = (req: Pick<RecipeFacts, 'diff' | 'prChangedRecipeFiles' | 'environment'>) =>
    recipeFilesChangedBy([...(req.prChangedRecipeFiles ?? []), ...req.diff.map((f) => f.path)], req.environment.recipe);

/**
 * Every file the PR changes is a recipe file the Run replaces with the base's
 * copy, so its PR side would boot exactly as main: nothing to boot or test.
 * Read from the request only (the DBOS workflow input), so a replay decides
 * the same. A cut diff never qualifies: what was cut is not known.
 */
export function changesOnlyTheRecipe(req: RecipeFacts): boolean {
    if (req.diffTruncated || !req.environment.recipe || req.diff.length === 0) return false;
    const recipe = new Set(recipeChangedInPr(req));
    return req.diff.every((f) => recipe.has(f.path)) && (req.prChangedRecipeFiles ?? []).every((p) => recipe.has(p));
}
