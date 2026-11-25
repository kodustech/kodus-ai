import { RUNTIME_RECIPE_MAX_BYTES, RUNTIME_RECIPE_PATHS } from '@libs/runtime/contracts/runtime-commands';
import { parseRecipe, SUITE_LIMITS, type RecipeSuite } from '@libs/runtime/protocol/recipe';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import type { RuntimeGitPort } from '../domain/ports';

/** The environment's setup, for the recipe it booted: the suite's source when the repository has none committed. */
export type SuiteSetup = Pick<EnvironmentSetupRecord, 'sha' | 'recipe'> | null | undefined;

/** Where the suite block came from: the recipe committed in the repository, or the one the environment booted (Kody's or Kodus's). */
export type SuiteSource = 'repository' | 'environment';

/**
 * The recipe the environment booted at `sha` when it is not the repository's: one Kody wrote or Kodus inferred, recorded on
 * the setup. The Runs already boot it before anyone commits it; the suite runs from it too, so a customer has e2e from the
 * first pull request instead of after a commit of .kodus/ (a design partner's monorepo would have had none until then).
 */
export function environmentRecipeAt(setup: SuiteSetup, sha: string): string | undefined {
    const r = setup?.recipe;
    if (!r || r.state !== 'found' || !r.content || r.sha !== sha || setup?.sha !== sha) return undefined;
    return r.origin === 'authored' || r.origin === 'inferred' ? r.content : undefined;
}

/**
 * The e2e suite the environment's recipe declares at `sha`, as far as the product needs it to mint the right number of download
 * tokens: the shard ceiling, and whether a baseline is asked for. Undefined when the recipe at that commit declares no suite (or
 * none can be read), so nothing is minted for a suite that cannot run. The first recipe found wins, as for a setup (§6).
 */
export async function suiteOfRecipeAt(
    git: Pick<RuntimeGitPort, 'readFileAtCommit'>,
    repo: { organizationId: string; teamId: string; repositoryId: string; repositoryName: string },
    sha: string,
    setup?: SuiteSetup,
): Promise<{ shards: number; baseline: boolean; specs: string; cwd?: string; source: SuiteSource } | undefined> {
    const found = await suiteSourceAt(git, repo, sha, setup);
    const suite = found?.suite;
    return suite && found
        ? { shards: suite.shards ?? SUITE_LIMITS.shards, baseline: suite.baseline, specs: suite.specs, ...(suite.cwd !== undefined ? { cwd: suite.cwd } : {}), source: found.source }
        : undefined;
}

/** The whole suite block the recipe declares at `sha` (what Settings shows read-only), by the same rules as suiteSourceAt. */
export async function suiteDeclarationAt(
    git: Pick<RuntimeGitPort, 'readFileAtCommit'>,
    repo: { organizationId: string; teamId: string; repositoryId: string; repositoryName: string },
    sha: string,
    setup?: SuiteSetup,
): Promise<RecipeSuite | undefined> {
    return (await suiteSourceAt(git, repo, sha, setup))?.suite;
}

/**
 * The suite block at `sha` and where it came from. A recipe committed in the repository wins, whatever it says: the first one
 * found decides, and one without a suite (or invalid) declares none. With none committed, the recipe the environment booted at
 * that commit decides the same way (environmentRecipeAt).
 */
export async function suiteSourceAt(
    git: Pick<RuntimeGitPort, 'readFileAtCommit'>,
    repo: { organizationId: string; teamId: string; repositoryId: string; repositoryName: string },
    sha: string,
    setup?: SuiteSetup,
): Promise<{ suite: RecipeSuite; source: SuiteSource } | undefined> {
    for (const path of RUNTIME_RECIPE_PATHS) {
        const content = await git.readFileAtCommit({ ...repo, path, sha, maxBytes: RUNTIME_RECIPE_MAX_BYTES });
        if (content === null || content === 'unsupported_platform') continue;
        const parsed = parseRecipe(content);
        if (parsed.ok === false || !parsed.recipe.suite) return undefined;
        return { suite: parsed.recipe.suite, source: 'repository' };
    }
    const active = environmentRecipeAt(setup, sha);
    if (!active) return undefined;
    const parsed = parseRecipe(active);
    return parsed.ok && parsed.recipe.suite ? { suite: parsed.recipe.suite, source: 'environment' } : undefined;
}
