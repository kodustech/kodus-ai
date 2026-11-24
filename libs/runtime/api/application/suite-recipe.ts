import { RUNTIME_RECIPE_MAX_BYTES, RUNTIME_RECIPE_PATHS } from '@libs/runtime/contracts/runtime-commands';
import { parseRecipe, SUITE_LIMITS } from '@libs/runtime/protocol/recipe';

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
): Promise<{ shards: number; baseline: boolean } | undefined> {
    for (const path of RUNTIME_RECIPE_PATHS) {
        const content = await git.readFileAtCommit({ ...repo, path, sha, maxBytes: RUNTIME_RECIPE_MAX_BYTES });
        if (content === null || content === 'unsupported_platform') continue;
        const parsed = parseRecipe(content);
        if (parsed.ok === false || !parsed.recipe.suite) return undefined;
        return { shards: parsed.recipe.suite.shards ?? SUITE_LIMITS.shards, baseline: parsed.recipe.suite.baseline };
    }
    return undefined;
}
