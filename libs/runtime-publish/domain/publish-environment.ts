import { sha256Hex } from '@libs/runtime/contracts/derive-id';

import { RUNTIME_COMMENT_MARKER } from './render-runtime-comment';
import { KODY_RUNTIME_CHECK_NAME } from './runtime-publish.ports';

// One Kody Runtime comment and one check per environment a PR runs in
// (2026-11-13: two environments on kr-shop-billing #2 overwrote each other,
// and a later "Partly tested" hid a "2 regressions" failure). The
// environment a PR's repository is the primary of keeps the comment slot,
// the marker and the check name it always had; an environment where the
// repository is a member gets its own, named after that environment.

/** Which environment's comment and check a publication writes. */
export interface PublishEnvironment {
    /** '' for the environment the PR's repository is the primary of (or of one repository); else a digest of its primary. */
    key: string;
    /** The environment's name (its primary's alias), only for an environment where the PR's repository is a member. */
    name?: string;
}

/**
 * The environment of a Run, from what its target stored at enqueue: the
 * workspace lists the primary first (environment-members list order), so a
 * first entry that is not the PR's repository is another environment's
 * primary. No raw id reaches the PR: the key is a digest.
 */
export function publishEnvironmentOf(target: {
    repositoryId: string;
    workspace?: ReadonlyArray<{ repositoryId: string; alias: string }>;
}): PublishEnvironment {
    const primary = target.workspace?.[0];
    if (!primary || primary.repositoryId === target.repositoryId) return { key: '' };
    return {
        // Shipped without a namespace: the repository id alone.
        key: sha256Hex(primary.repositoryId, 16),
        name: primary.alias,
    };
}

/** "Kody Runtime" for the repository's own environment; "Kody Runtime (kr-shop)" for another one. */
export const checkNameOf = (env: PublishEnvironment): string =>
    env.key && env.name ? `${KODY_RUNTIME_CHECK_NAME} (${env.name})` : KODY_RUNTIME_CHECK_NAME;

/** The hidden marker of this environment's comment: the legacy one for the repository's own. */
export const commentMarkerOf = (env: PublishEnvironment): string =>
    env.key ? `<!-- kody-runtime:comment env=${env.key} -->` : RUNTIME_COMMENT_MARKER;
