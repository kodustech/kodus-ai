import { z } from 'zod';

import { MAX_HYPOTHESES_PER_BLOCKER } from '@libs/runtime/blockers/hypothesis';
import { MAX_WORKSPACE_REPOSITORIES } from '@libs/runtime/contracts/workspace';

import { SEALED_PREFIX } from './sealed-secret';
import { SETUP_AUTHOR_REPAIRS_MAX } from './environment-setup';

// Fresh download tokens for a new boot of a setup: a repair of Kody's recipe
// while the setup runs, or a clean boot of its learn loop once it ended
// blocked. The cell revokes a repository token right after its first
// fetch, so the setup command's tokens download once: each later boot asks
// the product for new ones, as a fork approval mints them again for a Run.
// The setup's own first boot asks too (`boot`) when its request waited long
// enough for the command's tokens to run out (SETUP_REPO_TOKEN_LIFE_MS), and
// once more when the cell's download was refused with tokens that had expired.
//
// POST /internal/runtime/setup-repo-tokens, `Authorization: Bearer <setup
// token>` (the command's llmToken, opened with the setup key, as the recipe
// author's call). The product:
//   - 401 when the setup token does not verify or expired;
//   - 404 when the token's setup (setupKey, environmentId, repositoryId) is
//     not the environment's current setup record, or its org is not the
//     token's (another org's setup reads as absent);
//   - 409 { code: 'setup_finished' } when that setup is no longer setting_up
//     (for `learn-<k>`: when it is not blocked with a learn loop that may
//     still boot);
//   - 400 for an attempt it does not know: a product older than the worker
//     answers `boot` so, and the first boot then downloads with the
//     command's tokens, as before `boot` existed;
//   - 200 with one new installation token per repository of the environment
//     (the primary, and every member for a multi-repository one), each for
//     that repository only, sealed for the setup key (sealForRuntime). A
//     member no longer in the environment gets none (its claim is refused,
//     naming it). Every call mints new tokens: the attempt names the boot,
//     for the log, never to answer the same tokens again.
// The worker never sends a token, a repository name or an org: the setup
// token says which setup, and the product reads the rest from its records.

export const SETUP_REPO_TOKENS_PATH = 'internal/runtime/setup-repo-tokens';

const Sealed = z.string().startsWith(SEALED_PREFIX).max(4_096);

/** The learn loop's clean boots: two (the boot and its replay, ENV-06) for each hypothesis it may try on one blocker. */
export const SETUP_LEARN_BOOTS_MAX = 2 * MAX_HYPOTHESES_PER_BLOCKER;

/**
 * The boot the tokens are for: `boot`, the setup's own first boot (its
 * request waited past the command's tokens, or the cell's download was
 * refused with expired ones); `repair-<n>`, n up to the setup's most
 * repairs; `learn-<k>`, the learn loop's k-th clean boot, k up to
 * SETUP_LEARN_BOOTS_MAX (hypothesis h boots as 2h-1, its replay as 2h).
 */
export const SetupRepoTokensRequestSchema = z.strictObject({
    attempt: z
        .string()
        .regex(/^(?:boot|(?:repair|learn)-[1-9]\d?)$/)
        .refine((a) => {
            if (a === 'boot') return true;
            const [kind, n] = a.split('-');
            return Number(n) <= (kind === 'repair' ? SETUP_AUTHOR_REPAIRS_MAX : SETUP_LEARN_BOOTS_MAX);
        }),
});
export type SetupRepoTokensRequest = z.infer<typeof SetupRepoTokensRequestSchema>;

export const SetupRepoTokensResponseSchema = z.strictObject({
    /** The primary repository's token (the command's repoToken for this boot). */
    repoToken: Sealed,
    /** Every other repository of a multi-repository environment; absent for one repository. */
    workspace: z
        .array(z.strictObject({ repositoryId: z.string().min(1).max(200), sealedRepoToken: Sealed }))
        .max(MAX_WORKSPACE_REPOSITORIES - 1)
        .optional(),
});
export type SetupRepoTokensResponse = z.infer<typeof SetupRepoTokensResponseSchema>;

/**
 * How long a repository download token lives from when the product issues
 * it: a GitHub installation token's hour (the product issues the setup
 * command's a moment after the request's requestedAt).
 */
export const SETUP_REPO_TOKEN_LIFE_MS = 60 * 60_000;

/**
 * What a boot's tokens must have left when the boot starts, or it asks for
 * new ones first: the wait for room on a cell and the hub's queue come
 * before the download.
 */
export const SETUP_REPO_TOKEN_REFRESH_MARGIN_MS = 15 * 60_000;

const ageMs = (issuedAt: string, at: string) => Date.parse(at) - Date.parse(issuedAt);

/** Whether tokens issued at `issuedAt` have less than SETUP_REPO_TOKEN_REFRESH_MARGIN_MS of their life left at `at`. False for a time that does not parse. */
export function setupRepoTokensRunOut(issuedAt: string, at: string): boolean {
    return ageMs(issuedAt, at) > SETUP_REPO_TOKEN_LIFE_MS - SETUP_REPO_TOKEN_REFRESH_MARGIN_MS;
}

/**
 * Whether a boot's blocker is the cell's download refused with 401
 * (`platform/repo_fetch`, the cell's "download status 401") of tokens
 * issued at `issuedAt` that had outlived SETUP_REPO_TOKEN_LIFE_MS by `at`:
 * an expired token, which new ones fix. A 401 of tokens still in their life
 * (revoked, an installation removed) is not one, nor any other status.
 */
export function isExpiredTokenDownload(b: { kind: string; signature: string; message: string } | undefined, issuedAt: string, at: string): boolean {
    // The cell's blocker carries no HTTP status field, only its message (tarball/fetch.go), so the status is read from it.
    if (!b || b.kind !== 'platform' || b.signature !== 'repo_fetch' || !/\bdownload status 401\b/.test(b.message)) return false;
    return ageMs(issuedAt, at) >= SETUP_REPO_TOKEN_LIFE_MS;
}
