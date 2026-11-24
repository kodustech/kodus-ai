import { RUNTIME_RECIPE_MAX_BYTES, RUNTIME_RECIPE_PATHS } from '@libs/runtime/contracts/runtime-commands';
import { parseRecipe, SUITE_LIMITS, type RecipeSuite } from '@libs/runtime/protocol/recipe';

import type { RuntimeGitPort } from '../domain/ports';

/**
 * The e2e suite the environment's recipe declares at `sha`, as far as the product needs it to mint the right number of download
 * tokens: the shard ceiling, and whether a baseline is asked for. Undefined when the recipe at that commit declares no suite (or
 * none can be read), so nothing is minted for a suite that cannot run. The first recipe found wins, as for a setup (§6).
 */
export async function suiteOfRecipeAt(
    git: Pick<RuntimeGitPort, 'readFileAtCommit'>,
    repo: { organizationId: string; teamId: string; repositoryId: string; repositoryName: string },
    sha: string,
): Promise<{ shards: number; baseline: boolean; specs: string; cwd?: string } | undefined> {
    const suite = await suiteDeclarationAt(git, repo, sha);
    return suite ? { shards: suite.shards ?? SUITE_LIMITS.shards, baseline: suite.baseline, specs: suite.specs, ...(suite.cwd !== undefined ? { cwd: suite.cwd } : {}) } : undefined;
}

/** The whole suite block the recipe declares at `sha` (what Settings shows read-only), by the same rules: the first recipe found wins; none, or an invalid one, declares no suite. */
export async function suiteDeclarationAt(
    git: Pick<RuntimeGitPort, 'readFileAtCommit'>,
    repo: { organizationId: string; teamId: string; repositoryId: string; repositoryName: string },
    sha: string,
): Promise<RecipeSuite | undefined> {
    for (const path of RUNTIME_RECIPE_PATHS) {
        const content = await git.readFileAtCommit({ ...repo, path, sha, maxBytes: RUNTIME_RECIPE_MAX_BYTES });
        if (content === null || content === 'unsupported_platform') continue;
        const parsed = parseRecipe(content);
        if (parsed.ok === false || !parsed.recipe.suite) return undefined;
        return parsed.recipe.suite;
    }
    return undefined;
}
