import { BUILD_INPUT_MAX_BYTES, BUILD_INPUTS_MAX_FILES, buildInputContentDigest, buildInputPathsOf, buildInputsDigest } from '@libs/runtime/run/build-inputs';
import { parseRecipe } from '@libs/runtime/protocol/recipe';

import type { OrgTeam, RuntimeGitPort } from '../domain/ports';

type Target = OrgTeam & { repositoryId: string; repositoryName: string; sha: string };

const READ_PARALLEL = 6;

/**
 * The digest of what changes the environment's build at a commit (lockfiles, package manifests, Dockerfiles and the compose
 * files the recipe names; libs/runtime/run/build-inputs.ts), for the template's key (docs/runtime/host-providers.md §8.2.2).
 * Undefined, never an error, when it cannot be told: no listing on this platform, a Git failure, a file that cannot be read,
 * more files than the bound, or none. The template then keys on the commit as before, so a wrong answer here can only cost a
 * rebuild, never serve a template that skipped a dependency change.
 */
export async function readBuildInputsDigest(
    git: Pick<RuntimeGitPort, 'readFileAtCommit' | 'listFilesAtCommit'>,
    target: Target,
    recipeContent: string | null,
): Promise<string | undefined> {
    try {
        if (!git.listFilesAtCommit) return undefined;
        const listing = await git.listFilesAtCommit(target);
        if (listing === 'unsupported_platform') return undefined;
        const parsed = recipeContent ? parseRecipe(recipeContent) : undefined;
        const paths = buildInputPathsOf(listing, parsed?.ok ? parsed.recipe.composeFiles : []);
        if (paths.length === 0 || paths.length > BUILD_INPUTS_MAX_FILES) return undefined;
        const entries: Array<{ path: string; digest: string }> = [];
        for (let i = 0; i < paths.length; i += READ_PARALLEL) {
            const batch = paths.slice(i, i + READ_PARALLEL);
            const texts = await Promise.all(batch.map((path) => git.readFileAtCommit({ ...target, path, maxBytes: BUILD_INPUT_MAX_BYTES })));
            for (const [j, text] of texts.entries()) {
                // A file listed and not readable is not "unchanged": no digest.
                if (typeof text !== 'string' || text === 'unsupported_platform') return undefined;
                entries.push({ path: batch[j], digest: buildInputContentDigest(batch[j], text) });
            }
        }
        return buildInputsDigest(entries);
    } catch {
        return undefined;
    }
}
