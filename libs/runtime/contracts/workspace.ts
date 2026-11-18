import { sha256Hex } from './derive-id';

import { z } from 'zod';

import { type EnvironmentRepositoryRole } from './enums';

// An environment of several repositories: the names, bounds and keys every
// layer shares (the membership table, the setup and Run messages, the cell
// protocol, the recipe's services.needs and the bake). The cell's Go code
// mirrors repositoryAliasOf, refsDigest and memberImageKey; the shared
// vectors in protocol/fixtures/workspace hold both to the same output.

/** A repository's directory in the workspace (ws/<alias>): lower case, no separator, at most 63 characters. */
export const REPOSITORY_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const RepositoryAliasSchema = z.string().regex(REPOSITORY_ALIAS_PATTERN);

// One path segment that is not `.` or `..`, spelled out for RE2 (no lookahead).
const SEGMENT = '(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*|\\.[A-Za-z0-9_-][A-Za-z0-9_.-]*|\\.\\.[A-Za-z0-9_.-]+)';
/** owner/name, or group/subgroup/name: what a Git provider's API names a repository by. */
export const REPOSITORY_FULL_NAME_PATTERN = new RegExp(`^${SEGMENT}(/${SEGMENT})+$`);
export const MAX_REPOSITORY_FULL_NAME = 512;
export const RepositoryFullNameSchema = z.string().min(3).max(MAX_REPOSITORY_FULL_NAME).regex(REPOSITORY_FULL_NAME_PATTERN);

/** The other repositories one recipe may boot beside its own (services.needs). */
export const MAX_RECIPE_NEEDS = 9;
/** Every repository of one environment's workspace: the primary and the ones it needs. */
export const MAX_WORKSPACE_REPOSITORIES = MAX_RECIPE_NEEDS + 1;

/** The alias of a repository whose name leaves none. */
export const FALLBACK_REPOSITORY_ALIAS = 'repo';

/**
 * The alias a repository gets when none is given: its short name (after the
 * last `/`) in lower case, every run of other characters as one `-`, without
 * a leading `.`, `_` or `-`, cut to 63 characters; `repo` when nothing is
 * left. The membership backfill and the Go cell (recipe.AliasOf) compute the same.
 */
export function repositoryAliasOf(name: string): string {
    const alias = name
        .slice(name.lastIndexOf('/') + 1)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[^a-z0-9]+/, '')
        .slice(0, 63);
    return REPOSITORY_ALIAS_PATTERN.test(alias) ? alias : FALLBACK_REPOSITORY_ALIAS;
}

/**
 * Why a workspace's list of repositories is malformed, or undefined: exactly
 * one primary, and each repository and each alias once.
 */
export function workspaceShapeError(entries: ReadonlyArray<{ repositoryId: string; alias: string; role: EnvironmentRepositoryRole }>): string | undefined {
    if (entries.filter((e) => e.role === 'primary').length !== 1) return 'a workspace has exactly one primary repository';
    const ids = new Set<string>();
    const aliases = new Set<string>();
    for (const e of entries) {
        if (ids.has(e.repositoryId)) return `repository ${e.repositoryId} twice in the workspace`;
        if (aliases.has(e.alias)) return `alias ${e.alias} twice in the workspace`;
        ids.add(e.repositoryId);
        aliases.add(e.alias);
    }
    return undefined;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * The bake key of a multi-repository environment: sha256 over its
 * repositories' `repositoryId:sha` lines, sorted, each ending in a newline,
 * then the recipe digest. The order the repositories are listed in never
 * changes it; a new commit of any of them, or another recipe, does. Throws
 * on a ref it could not frame unambiguously (an empty id or one with a
 * newline, a sha that is not 40 hex characters, a repository twice).
 */
export function refsDigest(refs: ReadonlyArray<{ repositoryId: string; sha: string }>, recipeDigest: string): string {
    const seen = new Set<string>();
    const lines = refs.map((r) => {
        if (!r.repositoryId || /[\n\r]/.test(r.repositoryId)) throw new Error('refsDigest: bad repository id');
        if (!SHA.test(r.sha)) throw new Error(`refsDigest: bad sha for ${r.repositoryId}`);
        if (seen.has(r.repositoryId)) throw new Error(`refsDigest: ${r.repositoryId} twice`);
        seen.add(r.repositoryId);
        return `${r.repositoryId}:${r.sha}\n`;
    });
    lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `sha256:${sha256Hex(lines.join('') + recipeDigest)}`;
}

/**
 * The key of one member repository's build image: what it was built from
 * (the repository, its commit, the digest of the build context), as 64 hex
 * characters, so an unchanged member keeps its image whatever the other
 * repositories' commits are.
 */
export function memberImageKey(repositoryId: string, sha: string, contextDigest: string): string {
    if (!repositoryId || /[\n\r]/.test(repositoryId)) throw new Error('memberImageKey: bad repository id');
    if (!SHA.test(sha)) throw new Error('memberImageKey: bad sha');
    if (!contextDigest || /[\n\r]/.test(contextDigest)) throw new Error('memberImageKey: bad context digest');
    // Newline-separated (shipped): the checks above keep a newline out of every part.
    return sha256Hex(`${repositoryId}\n${sha}\n${contextDigest}`);
}
