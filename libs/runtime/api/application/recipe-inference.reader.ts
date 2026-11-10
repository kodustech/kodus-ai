import {
    INFERENCE_COMPOSE_FILES,
    INFERENCE_DOCKERFILE,
    INFERENCE_MAX_BYTES,
    INFERENCE_PACKAGE_JSON,
    type InferenceFiles,
    inferRecipe,
    type RecipeInference,
} from '@libs/runtime/run/recipe-inference';

import type { OrgTeam, RuntimeGitPort } from '../domain/ports';

type Target = OrgTeam & { repositoryId: string; repositoryName: string; sha: string };

/**
 * Reads the root files the inference needs at one commit, probing fixed paths
 * (the Git port lists no tree): the compose files in the cell's order until
 * one exists, the Dockerfile, and package.json only without a compose file.
 * At most six reads. Throws on a Git failure; a platform that cannot read a
 * file at a commit counts as the file not being there.
 */
export async function readInferenceFiles(git: Pick<RuntimeGitPort, 'readFileAtCommit'>, target: Target): Promise<InferenceFiles> {
    const read = async (path: string) => {
        const text = await git.readFileAtCommit({ ...target, path, maxBytes: INFERENCE_MAX_BYTES });
        return typeof text === 'string' && text !== 'unsupported_platform' ? text : undefined;
    };
    const files: InferenceFiles = {};
    for (const path of INFERENCE_COMPOSE_FILES) {
        const text = await read(path);
        if (text !== undefined) {
            files.compose = { path, text };
            break;
        }
    }
    const dockerfile = await read(INFERENCE_DOCKERFILE);
    if (dockerfile !== undefined) files.dockerfile = dockerfile;
    if (!files.compose && dockerfile !== undefined) {
        // Only a port hint: a package.json too large or unreadable leaves the Dockerfile's word.
        const pkg = await read(INFERENCE_PACKAGE_JSON).catch(() => undefined);
        if (pkg !== undefined) files.packageJson = pkg;
    }
    return files;
}

/** The recipe Kodus infers at this commit, or why it cannot; null when the Git API failed (the setup then boots as without inference). */
export async function inferRecipeAtCommit(git: Pick<RuntimeGitPort, 'readFileAtCommit'>, target: Target): Promise<RecipeInference | null> {
    try {
        return inferRecipe(await readInferenceFiles(git, target));
    } catch {
        return null;
    }
}
