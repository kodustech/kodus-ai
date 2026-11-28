import { createHash } from 'crypto';

// What decides whether an environment's template must be built again (docs/runtime/host-providers.md §8.2.2): the files
// that change what the build installs and which images it makes, not the app's source. The template's key is the recipe's
// digest plus the digest of these files; a main push that touches only source leaves both alone, so the template stays.
// The product reads the files at the default-branch commit (it holds the repository credentials) and sends one digest.

const LOCKFILES = new Set([
    'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'go.sum', 'Cargo.lock', 'poetry.lock', 'uv.lock',
    'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'gradle.lockfile',
]);
const MANIFESTS = new Set([
    'package.json', 'pnpm-workspace.yaml', '.npmrc', '.nvmrc', '.node-version', '.tool-versions', 'go.mod', 'Cargo.toml', 'pyproject.toml',
    'Pipfile', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
]);
const REQUIREMENTS = /^requirements(-.+)?\.txt$/;
/** `Dockerfile`, `Dockerfile.app`, `app.Dockerfile`, `app.dockerfile`. */
const DOCKERFILE = /^(Dockerfile(\..+)?|.+\.[Dd]ockerfile)$/;

/** More build inputs than this is a repository the digest does not try to cover: the template then keys on the commit as before. */
export const BUILD_INPUTS_MAX_FILES = 300;
/** A build input larger than this is not read (a lockfile this big is not read through a Git API either). */
export const BUILD_INPUT_MAX_BYTES = 8 * 1024 * 1024;

export type BuildInputKind = 'lockfile' | 'manifest' | 'dockerfile' | 'compose';

/**
 * Which kind of build input a repository path is, or null when it is not one. `composeFiles` are the compose files the
 * recipe names (any directory), compared without a leading `./`. A vendored copy under `node_modules/` is never one.
 */
export function buildInputKindOf(path: string, composeFiles: readonly string[] = []): BuildInputKind | null {
    if (path.startsWith('/') || path.split('/').includes('..') || /(^|\/)(node_modules|vendor)\//.test(path)) return null;
    if (composeFiles.some((c) => c.replace(/^\.\//, '') === path)) return 'compose';
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (LOCKFILES.has(base)) return 'lockfile';
    if (MANIFESTS.has(base) || REQUIREMENTS.test(base)) return 'manifest';
    if (DOCKERFILE.test(base)) return 'dockerfile';
    return null;
}

/** The paths of a repository listing that are build inputs, sorted. */
export function buildInputPathsOf(listing: readonly string[], composeFiles: readonly string[] = []): string[] {
    return listing.filter((p) => buildInputKindOf(p, composeFiles)).sort();
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function sortedJson(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
    return JSON.stringify(v);
}

/**
 * The digest of one build input's text. A `package.json` is read without its `version` and with sorted keys, so a release
 * bump or a reordering is not a dependency change; any other file is its bytes.
 */
export function buildInputContentDigest(path: string, text: string): string {
    if (path === 'package.json' || path.endsWith('/package.json')) {
        try {
            const { version: _version, ...rest } = JSON.parse(text) as Record<string, unknown>;
            return sha256(sortedJson(rest));
        } catch {
            // Not JSON: the bytes, so a broken manifest still changes the key.
        }
    }
    return sha256(text);
}

/** One digest of the build inputs, independent of the order they were read in. Undefined for none: no inputs is no evidence. */
export function buildInputsDigest(entries: ReadonlyArray<{ path: string; digest: string }>): string | undefined {
    if (entries.length === 0) return undefined;
    const lines = entries.map((e) => `${e.path}\0${e.digest}`).sort();
    return sha256(`build-inputs:1\n${lines.join('\n')}`);
}

/**
 * The template's key: the recipe's digest (it covers the compose files and Dockerfiles the recipe carries) and the build
 * inputs' digest. The cell base is the other half of a template's identity and lives in its row and its name, not here.
 * Both are `sha256:<hex>` or bare hex; undefined when either is not a digest.
 */
export function templateKeyOf(recipeDigest: string | undefined, inputsDigest: string | undefined): string | undefined {
    const recipe = recipeDigest?.replace(/^sha256:/, '');
    const inputs = inputsDigest?.replace(/^sha256:/, '');
    if (!recipe || !inputs || !/^[0-9a-f]{16,64}$/.test(recipe) || !/^[0-9a-f]{64}$/.test(inputs)) return undefined;
    return sha256(`template-key:1\0${recipe}\0${inputs}`);
}
