import { kodusFilesChangedBy, recipeFilesChangedBy } from '@libs/runtime/contracts/enums';
import { parseRecipe } from '@libs/runtime/protocol/recipe';
import { memberPullRequestAliasOf, type RuntimeRunRequested } from '@libs/runtime/run';

type RecipeFacts = Pick<RuntimeRunRequested, 'diff' | 'prChangedRecipeFiles' | 'environment' | 'diffTruncated'> & Partial<Pick<RuntimeRunRequested, 'workspace'>>;

/**
 * Recipe files the PR changes (S-19) whose PR copy the Run never boots: among
 * the `.kodus/` files the product read from the whole file list and what the
 * diff shows, the workspace files and the setup's authored files, when the
 * claims carry the recipe (`environment.recipe`, set by the RunRequested
 * handler from the setup record). Every other `.kodus/` file boots from the PR.
 */
export const recipeChangedInPr = (req: Pick<RecipeFacts, 'diff' | 'prChangedRecipeFiles' | 'environment' | 'workspace'>) => {
    const paths = [...(req.prChangedRecipeFiles ?? []), ...req.diff.map((f) => f.path)];
    // A member repository's `.kodus/` is never applied: every file of it the PR changes.
    return memberPullRequestAliasOf(req) ? kodusFilesChangedBy(paths) : recipeFilesChangedBy(paths, req.environment.recipe);
};

/**
 * Every file the PR changes is a recipe file the Run replaces with the base's
 * copy, so its PR side would boot exactly as main: nothing to boot or test.
 * Read from the request only (the DBOS workflow input), so a replay decides
 * the same. A cut diff never qualifies: what was cut is not known.
 */
/**
 * The member whose PR this Run tests, when the environment's recipe boots
 * nothing of it: neither `services.needs` nor any path of the recipe or its
 * authored files names `../<alias>`. Every probe of its routes would then
 * reach another repository's service (demo-shop-billing on 2026-11-13: every
 * `POST /invoices/preview` hit demo-shop's app, 404 on both sides, read as the
 * same failure on both versions). Undefined when the PR is the primary's,
 * or the request carries no recipe to decide from. A compose file committed
 * in the repository that builds `../<alias>` without `services.needs` is not
 * read here: declare the member in `services.needs`.
 */
export function memberNotBootedOf(req: Pick<RecipeFacts, 'environment'> & Partial<Pick<RuntimeRunRequested, 'workspace'>>): string | undefined {
    const alias = memberPullRequestAliasOf(req);
    const recipe = req.environment.recipe;
    if (!alias || !recipe) return undefined;
    const workspaceText = recipe.content ?? recipe.files?.find((f) => f.path === recipe.path)?.content;
    const parsed = workspaceText ? parseRecipe(workspaceText) : undefined;
    if (parsed?.ok && parsed.recipe.needs?.some((n) => n.alias === alias)) return undefined;
    // Every regex metacharacter of the alias escaped, not only its dots.
    const literal = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = new RegExp(`(^|[^A-Za-z0-9._-])\\.\\./${literal}(?![A-Za-z0-9._-])`, 'm');
    const texts = [recipe.content ?? '', ...(recipe.files ?? []).map((f) => f.content)];
    return texts.some((t) => named.test(t)) ? undefined : alias;
}

export function changesOnlyTheRecipe(req: RecipeFacts): boolean {
    if (req.diffTruncated || !req.environment.recipe || req.diff.length === 0) return false;
    const recipe = new Set(recipeChangedInPr(req));
    return req.diff.every((f) => recipe.has(f.path)) && (req.prChangedRecipeFiles ?? []).every((p) => recipe.has(p));
}
