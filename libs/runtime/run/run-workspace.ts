import type { ClaimSide } from '@libs/runtime/contracts/enums';
import type { ForkApprovalTokens, RuntimeEnvironmentSetupRequested } from '@libs/runtime/contracts/runtime-commands';
import { REPOSITORY_ALIAS_PATTERN, refsDigest } from '@libs/runtime/contracts/workspace';
import { type RecipeNeed, recipeNeedsConflict } from '@libs/runtime/protocol/recipe';

import type { RuntimeRunRequested } from './run-messages';

// The repositories of one claim in a multi-repository environment, as the
// setup and Run messages pinned them: the primary (claim.acquire repo, whose
// recipe boots) and every other one (claim.acquire repos), each at the commit
// of the claim's side with that side's own sealed download token. The tokens
// stay sealed here; the environment client opens them inside the acquire.
// A message without `workspace` has none of this and boots as before.

/** One side of one repository: the commit it boots and the sealed token it downloads with (absent: the message carries none). */
export interface WorkspaceSide {
    sha: string;
    sealedToken?: string;
}

export interface WorkspaceClaimRepo {
    repositoryId: string;
    fullName: string;
    alias: string;
    base: WorkspaceSide;
    pr: WorkspaceSide;
}

export interface ClaimWorkspace {
    primary: WorkspaceClaimRepo;
    /** Every repository but the primary, in the message's order. */
    members: WorkspaceClaimRepo[];
}

/** The side of a repository a claim boots: a setup boots the default branch, as the base side does. */
export const workspaceSideOf = (side: ClaimSide): 'base' | 'pr' => (side === 'pr' ? 'pr' : 'base');

const side = (sha: string, sealedToken: string | undefined): WorkspaceSide => ({ sha, ...(sealedToken ? { sealedToken } : {}) });

/**
 * A Run's workspace. The PR's own repository (source pull_request) fetches
 * with the request's repoToken and prRepoToken, as a Run of one repository
 * does (the fork approval replaces those); every other one with its own.
 * A side without its own token falls back to the base's, as prRepoToken does.
 */
export function runClaimWorkspace(req: Pick<RuntimeRunRequested, 'workspace' | 'repoToken' | 'prRepoToken'>): ClaimWorkspace | undefined {
    if (!req.workspace?.length) return undefined;
    let primary: WorkspaceClaimRepo | undefined;
    const members: WorkspaceClaimRepo[] = [];
    for (const r of req.workspace) {
        const own = r.source === 'pull_request';
        const baseToken = own ? req.repoToken : r.sealedRepoToken;
        const prToken = own ? (req.prRepoToken ?? req.repoToken) : (r.sealedPrRepoToken ?? r.sealedRepoToken);
        const repo: WorkspaceClaimRepo = {
            repositoryId: r.repositoryId,
            fullName: r.fullName,
            alias: r.alias,
            base: side(r.baseSha, baseToken),
            pr: side(r.headSha, prToken),
        };
        if (r.role === 'primary') primary = repo;
        else members.push(repo);
    }
    // The schema holds exactly one primary; a message that slipped past it is not booted half.
    if (!primary) throw new Error('the Run workspace has no primary repository');
    return { primary, members };
}

/**
 * A setup's workspace: every repository at its default-branch head with its
 * own token, the same on any side (a setup has one). The primary falls back
 * to the command's repoToken.
 */
export function setupClaimWorkspace(cmd: Pick<RuntimeEnvironmentSetupRequested, 'workspace' | 'repoToken'>): ClaimWorkspace | undefined {
    if (!cmd.workspace?.length) return undefined;
    let primary: WorkspaceClaimRepo | undefined;
    const members: WorkspaceClaimRepo[] = [];
    for (const r of cmd.workspace) {
        const token = r.sealedRepoToken ?? (r.role === 'primary' ? cmd.repoToken : undefined);
        const repo: WorkspaceClaimRepo = { repositoryId: r.repositoryId, fullName: r.fullName, alias: r.alias, base: side(r.sha, token), pr: side(r.sha, token) };
        if (r.role === 'primary') primary = repo;
        else members.push(repo);
    }
    if (!primary) throw new Error('the setup workspace has no primary repository');
    return { primary, members };
}

/**
 * The commit a Run's claim of `side` boots its own repository at: the
 * primary's, which is the pull request's when the PR is in the primary and
 * the primary's pinned commit when the PR is in another repository. Without a
 * workspace, the pull request's, as always.
 */
export function claimShaOf(req: Pick<RuntimeRunRequested, 'workspace' | 'pullRequest'>, side: 'base' | 'pr'): string {
    const primary = req.workspace?.find((r) => r.role === 'primary');
    if (primary) return side === 'pr' ? primary.headSha : primary.baseSha;
    return side === 'pr' ? req.pullRequest.headSha : req.pullRequest.baseSha;
}

/**
 * The bake key of a multi-repository setup (contracts/workspace refsDigest):
 * every repository's commit, the primary's being the one the setup booted,
 * and the recipe digest. Undefined for a setup of one repository, or of a
 * workspace of its primary alone (its claim carries no repos).
 */
export function setupRefsDigest(cmd: Pick<RuntimeEnvironmentSetupRequested, 'workspace'>, primarySha: string, recipeDigest: string): string | undefined {
    // Only a setup claim that carried other repositories bakes by them; the cell nacks a key on a claim of one (refs_mismatch).
    if (!cmd.workspace?.some((r) => r.role !== 'primary')) return undefined;
    return refsDigest(
        cmd.workspace.map((r) => ({ repositoryId: r.repositoryId, sha: r.role === 'primary' ? primarySha : r.sha })),
        recipeDigest,
    );
}

/**
 * The repository a cell's failure reason is about: the cell starts the
 * reason of a member repository's failure with `repository <alias>: `
 * (claim.failed has no field for it). Only an alias of the claim's repos.
 */
export function memberAliasOfReason(reason: string | undefined, repos: ReadonlyArray<{ alias: string }> | undefined): string | undefined {
    const m = /^repository ([a-z0-9][a-z0-9._-]{0,62}): /.exec(reason ?? '');
    return m && repos?.some((r) => r.alias === m[1]) ? m[1] : undefined;
}

/** The alias a blocker names, when it names a well-formed one (it crossed the hub's HTTP answer unchecked). */
export function blockerAliasOf(b: object | undefined): string | undefined {
    const alias = (b as { alias?: unknown } | undefined)?.alias;
    return typeof alias === 'string' && REPOSITORY_ALIAS_PATTERN.test(alias) ? alias : undefined;
}

/**
 * Why a recipe's services.needs cannot boot in this workspace, and the
 * repository it is about, or undefined: a need never names the primary, and
 * every need is a repository of the environment under the same alias. A
 * repository of the environment the recipe does not name is still fetched.
 */
export function workspaceNeedsError(
    needs: readonly RecipeNeed[] | undefined,
    workspace: ReadonlyArray<{ fullName: string; alias: string; role: string }>,
): { alias: string; message: string } | undefined {
    const primary = workspace.find((r) => r.role === 'primary');
    const conflict = primary ? recipeNeedsConflict(needs, primary) : undefined;
    if (primary && conflict) return { alias: primary.alias, message: conflict };
    for (const n of needs ?? []) {
        const member = workspace.find((r) => r.role !== 'primary' && r.alias === n.alias);
        if (!member) {
            return { alias: n.alias, message: `services.needs names ${n.repo} (${n.alias}), which is not a repository of this environment; add it to the environment or take it out of the recipe` };
        }
        if (member.fullName.toLowerCase() !== n.repo.toLowerCase()) {
            return { alias: n.alias, message: `services.needs names ${n.repo} as ${n.alias}, and ${n.alias} is ${member.fullName} in this environment` };
        }
    }
    return undefined;
}

/** A fork approval's tokens of the PR's own repository, without the member tokens (which go into the workspace). */
export function repoTokensOf(tokens: ForkApprovalTokens | undefined): Omit<ForkApprovalTokens, 'workspace'> | Record<string, never> {
    if (!tokens) return {};
    const { workspace: _members, ...own } = tokens;
    return own;
}

/**
 * A Run with a fork approval's fresh member tokens: every repository but the
 * PR's own (which uses the request's repoToken and prRepoToken) takes the
 * approval's tokens for it, and one the approval leaves out keeps none, so
 * its claim is refused naming it instead of fetching with a token that
 * expired while the Run waited. Without an approval's tokens, or for a Run
 * of one repository, the request is returned as it is.
 */
export function withMemberTokens<T extends Pick<RuntimeRunRequested, 'workspace'>>(req: T, tokens: Pick<ForkApprovalTokens, 'workspace'> | undefined): T {
    if (!tokens || !req.workspace) return req;
    const fresh = new Map((tokens.workspace ?? []).map((t) => [t.repositoryId, t]));
    return {
        ...req,
        workspace: req.workspace.map((r) => {
            if (r.source === 'pull_request') return r;
            const { sealedRepoToken: _base, sealedPrRepoToken: _pr, ...rest } = r;
            const t = fresh.get(r.repositoryId);
            return { ...rest, ...(t ? { sealedRepoToken: t.sealedRepoToken, ...(t.sealedPrRepoToken ? { sealedPrRepoToken: t.sealedPrRepoToken } : {}) } : {}) };
        }),
    };
}

/** The member tokens a Run holds, as a fork approval carries them; undefined when it holds none. */
export function memberTokensOf(req: Pick<RuntimeRunRequested, 'workspace'>): ForkApprovalTokens['workspace'] {
    const out = (req.workspace ?? [])
        .filter((r) => r.source !== 'pull_request' && r.sealedRepoToken)
        .map((r) => ({ repositoryId: r.repositoryId, sealedRepoToken: r.sealedRepoToken!, ...(r.sealedPrRepoToken ? { sealedPrRepoToken: r.sealedPrRepoToken } : {}) }));
    return out.length ? out : undefined;
}

/**
 * The alias of the PR's repository when it is a member of a multi-repository
 * environment, not its primary: the Run's claims are of the primary, and the
 * commands on the PR's code run where that member was built (exec.repository).
 */
export const memberPullRequestAliasOf = (req: Partial<Pick<RuntimeRunRequested, 'workspace'>>): string | undefined =>
    req.workspace?.find((r) => r.source === 'pull_request' && r.role === 'member')?.alias;
