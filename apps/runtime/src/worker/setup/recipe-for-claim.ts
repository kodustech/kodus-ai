import type { RecipeForClaim } from '@libs/runtime/environment';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

/**
 * The recipe a claim of the environment boots with: what its setup recorded from the default branch (§6), never a PR's
 * copy. Kody's build files (the authored Dockerfile that fetches the Firebase emulators from the cell's mirror, the compose
 * file that adds the suite's service) come only from that record, and so do a committed recipe's own build files (a PR branch cut before them lacks them). A Run's claims and a suite's claims boot the same way.
 */
export function recipeForClaimOf(recipe: EnvironmentSetupRecord['recipe']): RecipeForClaim | undefined {
    if (!recipe) return undefined;
    const found = recipe.state === 'found' && typeof recipe.content === 'string';
    return {
        path: recipe.path,
        content: found ? (recipe.content as string) : null,
        ...(recipe.digest ? { digest: recipe.digest } : {}),
        ...(found && recipe.files?.length ? { files: recipe.files } : {}),
        // A committed recipe's build files, read at its commit: laid only where the PR's checkout has none (a branch cut before them).
        ...(found && !recipe.files?.length && recipe.buildFiles?.length ? { files: recipe.buildFiles, filesMode: 'fill_missing' as const } : {}),
    };
}
