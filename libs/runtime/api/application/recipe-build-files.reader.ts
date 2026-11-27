import { AUTHORED_FILE_PATH_PATTERN, AUTHORED_FILES_LIMITS, type AuthoredFile, AuthoredFilesSchema } from '@libs/runtime/contracts/authored-files';
import { RECIPE_FILE_PATHS } from '@libs/runtime/contracts/enums';
import { parseRecipe } from '@libs/runtime/protocol/recipe';

import type { OrgTeam, RuntimeGitPort } from '../domain/ports';

type Target = OrgTeam & { repositoryId: string; repositoryName: string; sha: string };

const AUTHORED_FILE_PATH = new RegExp(AUTHORED_FILE_PATH_PATTERN);
const KODUS_DIRECTORY = '.kodus/';
/** `Dockerfile`, `Dockerfile.app`, `app.Dockerfile`, `app.dockerfile`: what a compose file builds from. */
const DOCKERFILE_NAME = /^(Dockerfile(\..+)?|.+\.[Dd]ockerfile)$/;

/** A direct child of `.kodus/` a claim may carry as a build file, never a recipe path. */
const isBuildFilePath = (path: string): boolean => AUTHORED_FILE_PATH.test(path) && !(RECIPE_FILE_PATHS as readonly string[]).includes(path);

/**
 * The `.kodus/` build files of a committed recipe at its commit: the compose files the recipe names and the Dockerfiles
 * beside them (a direct child of `.kodus/`, Dockerfile-named), so a Run on a PR branch cut before the recipe still finds
 * them. All or nothing: a file the Git API cannot give (or one past the authored-files bounds, count, per-file or total
 * bytes) leaves none, and the Run boots as before, the cell's blocker naming the file the checkout lacks. Never throws.
 */
export async function readCommittedBuildFiles(
    git: Pick<RuntimeGitPort, 'readFileAtCommit' | 'listFilesAtCommit'>,
    target: Target,
    recipeContent: string,
): Promise<AuthoredFile[] | undefined> {
    try {
        const parsed = parseRecipe(recipeContent);
        const paths = new Set<string>();
        if (parsed.ok) for (const named of parsed.recipe.composeFiles) {
                const f = named.replace(/^\.\//, '');
                if (f.startsWith(KODUS_DIRECTORY) && isBuildFilePath(f)) paths.add(f);
            }
        const listed = git.listFilesAtCommit ? await git.listFilesAtCommit(target) : undefined;
        if (Array.isArray(listed)) {
            for (const f of listed) if (isBuildFilePath(f) && DOCKERFILE_NAME.test(f.slice(KODUS_DIRECTORY.length))) paths.add(f);
        }
        if (paths.size === 0) return undefined;
        const files: AuthoredFile[] = [];
        for (const path of [...paths].sort()) {
            const content = await git.readFileAtCommit({ ...target, path, maxBytes: AUTHORED_FILES_LIMITS.fileBytes });
            // A named compose file the commit lacks is the recipe's own problem, not a build file to fill.
            if (content === null) continue;
            if (content === 'unsupported_platform') return undefined;
            files.push({ path, content });
        }
        const checked = AuthoredFilesSchema.safeParse(files);
        return checked.success ? checked.data : undefined;
    } catch {
        return undefined;
    }
}
