import fs from 'node:fs/promises';
import path from 'node:path';
import { CommandError } from '../../utils/command-errors.js';

export const RECIPE_CANDIDATES = [
    '.kodus/workspace.runtime.yaml',
    '.kodus/workspace.yaml',
] as const;

/** The planner's notes (docs/runtime/environment-setup.md): read from the repository at the base commit, never a build file of the recipe. */
export const RUNTIME_NOTES_FILE = 'runtime-notes.md';

export const MAX_BUILD_FILES = 4;
export const MAX_FILE_BYTES = 16 * 1024;
export const MAX_TOTAL_BYTES = 48 * 1024;
const BUILD_FILE_NAME = /^\.kodus\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface RecipeFile {
    path: string;
    content: string;
}

export interface CollectedRecipe {
    recipePath: string;
    recipe: string;
    files: RecipeFile[];
}

function toPosix(p: string): string {
    return p.split(path.sep).join('/');
}

async function isRegularFile(p: string): Promise<boolean> {
    try {
        return (await fs.lstat(p)).isFile();
    } catch {
        return false;
    }
}

/**
 * Reads the recipe (explicit `file`, else `.kodus/workspace.runtime.yaml`,
 * else `.kodus/workspace.yaml`) and the build files that sit directly under
 * `.kodus/`. Throws INVALID_INPUT when a local limit is exceeded, so the API
 * is never called with a payload it would refuse.
 */
export async function collectRecipe(
    root: string,
    file?: string,
): Promise<CollectedRecipe> {
    let recipePath: string | undefined;
    if (file) {
        const abs = path.resolve(root, file);
        if (!(await isRegularFile(abs))) {
            throw new CommandError(
                'INVALID_INPUT',
                `Recipe file not found: ${file}`,
            );
        }
        recipePath = abs;
    } else {
        for (const candidate of RECIPE_CANDIDATES) {
            const abs = path.join(root, candidate);
            if (await isRegularFile(abs)) {
                recipePath = abs;
                break;
            }
        }
    }

    if (!recipePath) {
        throw new CommandError(
            'INVALID_INPUT',
            `No recipe found. Create ${RECIPE_CANDIDATES[0]} (or ${RECIPE_CANDIDATES[1]}), or pass --file <path>.`,
        );
    }

    const recipe = await fs.readFile(recipePath, 'utf-8');
    if (!recipe.trim()) {
        throw new CommandError(
            'INVALID_INPUT',
            `Recipe file is empty: ${toPosix(path.relative(root, recipePath))}`,
        );
    }

    const kodusDir = path.join(root, '.kodus');
    const recipeNames = new Set(
        RECIPE_CANDIDATES.map((c) => c.slice('.kodus/'.length)),
    );
    // No .kodus/ directory (the recipe came from --file): no build files.
    const entries = (await fs.readdir(kodusDir).catch(() => [] as string[])).sort();

    const files: RecipeFile[] = [];
    let total = 0;
    for (const name of entries) {
        if (recipeNames.has(name) || name === RUNTIME_NOTES_FILE) {
            continue;
        }
        const abs = path.join(kodusDir, name);
        if (abs === recipePath) {
            continue;
        }
        if (!(await isRegularFile(abs))) {
            continue;
        }

        const rel = `.kodus/${name}`;
        if (!BUILD_FILE_NAME.test(rel)) {
            throw new CommandError(
                'INVALID_INPUT',
                `Build file name not allowed: ${rel}. Names must match ${BUILD_FILE_NAME.source}. Rename or remove it.`,
            );
        }
        const content = await fs.readFile(abs, 'utf-8');
        const size = Buffer.byteLength(content, 'utf-8');
        if (size > MAX_FILE_BYTES) {
            throw new CommandError(
                'INVALID_INPUT',
                `Build file ${rel} is ${size} bytes; the limit is ${MAX_FILE_BYTES} bytes (16 KiB) per file.`,
            );
        }
        total += size;
        files.push({ path: rel, content });
    }

    if (files.length > MAX_BUILD_FILES) {
        throw new CommandError(
            'INVALID_INPUT',
            `Found ${files.length} build files under .kodus/ (${files.map((f) => f.path).join(', ')}); the limit is ${MAX_BUILD_FILES}.`,
        );
    }
    if (total > MAX_TOTAL_BYTES) {
        throw new CommandError(
            'INVALID_INPUT',
            `Build files total ${total} bytes; the limit is ${MAX_TOTAL_BYTES} bytes (48 KiB).`,
        );
    }

    return {
        recipePath: toPosix(path.relative(root, recipePath)),
        recipe,
        files,
    };
}
