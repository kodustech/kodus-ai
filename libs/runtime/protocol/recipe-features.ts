import type { CellFeature } from './messages';
import { parseRecipe } from './recipe';

export type RecipeFeatureRequirements =
    { ok: true; features: CellFeature[] } | { ok: false };

/** Requirements come from the exact trusted base recipe, never a PR label.
 * Invalid content must not become an empty set that an older cell may ignore.
 */
export function requiredRecipeFeatures(
    recipe: { content?: string | null } | undefined,
): RecipeFeatureRequirements {
    if (recipe?.content === null || recipe?.content === undefined)
        return { ok: true, features: [] };
    if (typeof recipe.content !== 'string') return { ok: false };
    try {
        const parsed = parseRecipe(recipe.content);
        if (parsed.ok === false) return { ok: false };
        const features: CellFeature[] = [];
        if (parsed.recipe.fakes?.length) features.push('recipeFakes');
        if (parsed.recipe.seededSQL) features.push('seededSQL');
        return { ok: true, features };
    } catch {
        return { ok: false };
    }
}
