import { Inject, Injectable } from '@nestjs/common';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { type ITeamService, TEAM_SERVICE_TOKEN } from '@libs/organization/domain/team/contracts/team.service.contract';
import type { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { kodusFilesChangedBy } from '@libs/runtime/contracts/enums';
import { MAX_DIFF_BYTES, type RuntimeRunRequested } from '@libs/runtime/run';
import { RunBaseBranchSchema } from '@libs/runtime/run/run-messages';

import type {
    DefaultBranchHead,
    GitIdentity,
    OpenPullRequestSummary,
    OrgTeam,
    PullRequestDiff,
    PullRequestHead,
    RuntimeGitPort,
    RuntimeOrgRepositories,
    RuntimeTeamRepositories,
} from '../domain/ports';

const MAX_DIFF_FILES = 500;
/**
 * Post-change contents fetched for route extraction and for the plan agent
 * (the machines run the built app, often without source): code files only,
 * at most this many and this big each.
 */
const MAX_CONTENT_FILES = 40;
const MAX_CONTENT_BYTES = 256 * 1024;
const CONTENT_CONCURRENCY = 5;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|go|py|rb|java|kt|kts|scala|php|rs|cs|ex|exs|swift)$/;

const splitFullName = (name: string) => {
    const i = name.lastIndexOf('/');
    return i > 0 ? { owner: name.slice(0, i), name: name.slice(i + 1) } : { name };
};
/** The Run request's bounds on the PR title and description (run-messages.ts pullRequest), in UTF-16 units as the schema counts. */
const MAX_TITLE = 1_024;
const MAX_DESCRIPTION = 65_536;
/** Text cut to a bound on a whole character. */
const cutTo = (text: string, max: number): string => {
    let cut = '';
    for (const ch of text) {
        if (cut.length + ch.length > max) break;
        cut += ch;
    }
    return cut;
};
/** The PR title as the Git API answered it, cut to the request's bound on a whole character; none when it did not answer one. */
const titleOf = (title: unknown): { title?: string } => {
    if (typeof title !== 'string' || !title) return {};
    const cut = cutTo(title, MAX_TITLE);
    return cut ? { title: cut } : {};
};
/** The PR description as the Git API answered it, cut the same way; none when it answered nothing but whitespace. */
const descriptionOf = (body: unknown): { description?: string } => {
    if (typeof body !== 'string' || !body.trim()) return {};
    return { description: cutTo(body, MAX_DESCRIPTION) };
};
const MAX_PATCH = 1_000_000;
/** A full commit SHA (SHA-1 or SHA-256). */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** The Git API through the product's CodeManagementService (the Runtime never has a Git credential, ADR-052). */
@Injectable()
export class CodeManagementRuntimeGitAdapter implements RuntimeGitPort {
    constructor(private readonly codeManagement: CodeManagementService) {}

    async openPullRequestWithFiles(
        input: OrgTeam & {
            repositoryId: string;
            repositoryName: string;
            baseBranch: string;
            branch: string;
            title: string;
            body: string;
            commitMessage: string;
            files: { path: string; content: string }[];
        },
    ): Promise<{ number: number; url: string } | null> {
        const pr = await this.codeManagement.createPullRequestWithFiles({
            organizationAndTeamData: { organizationId: input.organizationId, teamId: input.teamId },
            repository: { id: input.repositoryId, name: splitFullName(input.repositoryName).name },
            baseBranch: input.baseBranch,
            targetBranch: input.baseBranch,
            sourceBranch: input.branch,
            title: input.title,
            description: input.body,
            commitMessage: input.commitMessage,
            files: input.files.map((f) => ({ path: f.path, content: f.content, operation: 'upsert' as const })),
        });
        const url = (pr as { prURL?: string } | null)?.prURL ?? (pr as { url?: string } | null)?.url;
        return pr?.number !== undefined && url ? { number: Number(pr.number), url } : null;
    }

    async getPullRequestHead(
        input: OrgTeam & { repositoryId: string; repositoryName: string; prNumber: number },
    ): Promise<PullRequestHead | null> {
        const pr = await this.codeManagement.getPullRequest({
            organizationAndTeamData: { organizationId: input.organizationId, teamId: input.teamId },
            // The product stores owner/repo; the platform call takes the repo name (and its owner apart).
            repository: { id: input.repositoryId, ...splitFullName(input.repositoryName) },
            prNumber: input.prNumber,
            includeLabels: true,
        });
        if (!pr?.head?.sha || !pr.base?.sha) return null;
        const headRepo = pr.head.repo?.id;
        const baseRepo = pr.base.repo?.id;
        const baseBranch = RunBaseBranchSchema.safeParse(pr.base.ref);
        return {
            headSha: pr.head.sha,
            baseSha: pr.base.sha,
            ...(baseBranch.success ? { baseBranch: baseBranch.data } : {}),
            ...(typeof pr.head.ref === 'string' && pr.head.ref.length > 0 && pr.head.ref.length <= 256 ? { headBranch: pr.head.ref } : {}),
            ...titleOf(pr.title),
            ...descriptionOf((pr as { body?: unknown }).body),
            // Unknown repos count as a fork: approval is the safe side.
            fork: !headRepo || !baseRepo || String(headRepo) !== String(baseRepo),
            authorId: pr.user?.id !== undefined ? String(pr.user.id) : undefined,
            authorLogin: pr.user?.login,
            ...(pr.user?.login && /\[bot\]$/i.test(pr.user.login) ? { authorIsBot: true } : {}),
            state: pr.state === PullRequestState.OPENED ? 'open' : pr.state === PullRequestState.MERGED ? 'merged' : 'closed',
            ...(typeof pr.isDraft === 'boolean' ? { draft: pr.isDraft } : {}),
            ...(Array.isArray(pr.labels) ? { labels: pr.labels.filter((l): l is string => typeof l === 'string').slice(0, 100) } : {}),
        };
    }

    /**
     * The PR's files at `headSha`, with the post-change content of the first
     * code files (the entry-point extractor reads routes from it). Anything
     * past the caps (files, bytes per patch, bytes in total) is cut and the
     * cut is said (`truncated`), never hidden: the Run is then partly tested.
     */
    async getPullRequestDiff(
        input: OrgTeam & { repositoryId: string; repositoryName: string; prNumber: number; headSha: string },
    ): Promise<PullRequestDiff> {
        const raw: Array<{ filename?: unknown; patch?: unknown; status?: unknown; previous_filename?: unknown }> =
            (await this.codeManagement.getFilesByPullRequestId({
                organizationAndTeamData: { organizationId: input.organizationId, teamId: input.teamId },
                repository: { id: input.repositoryId, ...splitFullName(input.repositoryName) },
                prNumber: input.prNumber,
                headSha: input.headSha,
            })) ?? [];
        const named = raw.filter((f) => typeof f?.filename === 'string' && f.filename.length > 0);
        // Before any cut, and with the old name of a rename: the worker tells a PR that moves or edits the recipe (S-19).
        const recipeFiles = kodusFilesChangedBy(
            named.flatMap((f) => [String(f.filename), typeof f.previous_filename === 'string' ? f.previous_filename : undefined]),
        );
        // The specs the suite drops: a removed file, and the old path of a rename (the new path is a changed file).
        const removed = [
            ...new Set(
                named.flatMap((f) => (f.status === 'removed' ? [String(f.filename)] : f.status === 'renamed' && typeof f.previous_filename === 'string' && f.previous_filename ? [f.previous_filename] : [])),
            ),
        ].sort();
        let truncated = named.length > MAX_DIFF_FILES;
        let bytes = 0;
        const files: Array<RuntimeRunRequested['diff'][number] & { removed?: boolean }> = [];
        for (const f of named.slice(0, MAX_DIFF_FILES)) {
            const path = String(f.filename);
            const fullPatch = String(f.patch ?? '');
            if (path.length > 1_024) {
                truncated = true;
                continue;
            }
            const patch = fullPatch.slice(0, MAX_PATCH);
            if (patch.length < fullPatch.length) truncated = true;
            if (bytes + patch.length > MAX_DIFF_BYTES / 2) {
                truncated = true;
                break;
            }
            bytes += patch.length;
            const previousPath = f.status === 'renamed' && typeof f.previous_filename === 'string' && f.previous_filename && f.previous_filename.length <= 1_024 ? f.previous_filename : undefined;
            files.push({ path, patch, removed: f.status === 'removed', ...(previousPath ? { previousPath } : {}) });
        }
        await this.fillContents(input, files, bytes);
        return { files: files.map(({ removed: _removed, ...file }) => file), truncated, ...(recipeFiles.length ? { recipeFiles } : {}), ...(removed.length ? { removedFiles: removed } : {}) };
    }

    /** Reads the post-change content of the first code files, bounded in count, size and total bytes. */
    private async fillContents(
        input: OrgTeam & { repositoryId: string; repositoryName: string; headSha: string },
        files: Array<RuntimeRunRequested['diff'][number] & { removed?: boolean }>,
        usedBytes: number,
    ) {
        const wanted = files.filter((f) => !f.removed && CODE_FILE.test(f.path)).slice(0, MAX_CONTENT_FILES);
        let budget = MAX_DIFF_BYTES - usedBytes;
        for (let i = 0; i < wanted.length; i += CONTENT_CONCURRENCY) {
            const batch = wanted.slice(i, i + CONTENT_CONCURRENCY);
            // A failed read is no content: the extractor then maps the file as unmapped, never success.
            const texts = await Promise.all(
                batch.map((f) =>
                    this.readFileAtCommit({ ...input, path: f.path, sha: input.headSha, maxBytes: MAX_CONTENT_BYTES }).catch(() => null),
                ),
            );
            batch.forEach((f, j) => {
                const text = texts[j];
                // Unreadable or too big: no content, so the extractor maps the file as unmapped (never success).
                if (typeof text === 'string' && text !== 'unsupported_platform' && text.length <= budget) {
                    f.content = text;
                    budget -= text.length;
                }
            });
        }
    }

    /**
     * Membership of the integration's org, from its member list (login or
     * id). An empty or failed list is unknown, which the caller denies.
     */
    async isOrganizationMember(input: OrgTeam & { identity: GitIdentity }): Promise<boolean | undefined> {
        const { id, login } = input.identity;
        if (!id && !login) return undefined;
        const members: Array<{ id?: unknown; name?: unknown }> | undefined = await this.codeManagement
            .getListMembers({ organizationAndTeamData: { organizationId: input.organizationId, teamId: input.teamId } })
            // A failed list is unknown membership, which the caller denies (fail closed).
            .catch(() => undefined);
        if (!Array.isArray(members) || members.length === 0) return undefined;
        return members.some(
            (m) => (id !== undefined && String(m?.id) === String(id)) || (!!login && typeof m?.name === 'string' && m.name.toLowerCase() === login.toLowerCase()),
        );
    }

    /**
     * There is no verified link between a Kodus user and a Git account yet
     * (an e-mail match can name someone else), so the dashboard approval fails
     * closed. The `@kody runtime approve` comment path names the Git user itself.
     */
    async resolveGitIdentity(): Promise<GitIdentity | null> {
        return null;
    }

    /**
     * The newest open PR of the repository from `branch`, read again by number
     * for its shas; a PR from a fork never pairs (its branch name is not this
     * repository's). Null when there is none.
     */
    async findOpenPullRequestByBranch(
        input: OrgTeam & { repositoryId: string; repositoryName: string; branch: string },
    ): Promise<{ number: number; headSha: string; baseSha: string } | null> {
        const prs =
            (await this.codeManagement.getPullRequests({
                organizationAndTeamData: { organizationId: input.organizationId, teamId: input.teamId },
                repository: { id: input.repositoryId, name: splitFullName(input.repositoryName).name },
                filters: { state: PullRequestState.OPENED },
            })) ?? [];
        const candidates = prs
            .filter((pr) => pr?.head?.ref === input.branch && Number.isSafeInteger(Number(pr.number)) && Number(pr.number) > 0)
            .sort((a, b) => Number(b.number) - Number(a.number))
            // Bounded: one Git call per candidate.
            .slice(0, 3);
        for (const pr of candidates) {
            const head = await this.getPullRequestHead({ ...input, prNumber: Number(pr.number) });
            if (head && !head.fork && head.state === 'open' && head.headBranch === input.branch) {
                return { number: Number(pr.number), headSha: head.headSha, baseSha: head.baseSha };
            }
        }
        return null;
    }

    /**
     * The repository's open PRs from the platform's own listing (one call,
     * paginated by the platform service). A PR whose listing gives no full
     * head SHA is left out: Bitbucket Cloud's listing abbreviates it, and an
     * abbreviated SHA never matches the head a Run recorded. A listing that
     * failed reads as empty (the platform services log and return []), so the
     * reconciler then hands nothing.
     */
    async listOpenPullRequests(input: OrgTeam & { repositoryId: string; repositoryName: string }): Promise<OpenPullRequestSummary[]> {
        const prs =
            (await this.codeManagement.getPullRequests({
                organizationAndTeamData: { organizationId: input.organizationId, teamId: input.teamId },
                // Every platform service finds the repository by id; Forgejo reads owner/repo from the name.
                repository: { id: input.repositoryId, name: input.repositoryName },
                filters: { state: PullRequestState.OPENED },
            })) ?? [];
        const out: OpenPullRequestSummary[] = [];
        for (const pr of prs) {
            const number = Number(pr?.number);
            const headSha = pr?.head?.sha;
            if (!Number.isSafeInteger(number) || number < 1 || typeof headSha !== 'string' || !FULL_SHA.test(headSha)) continue;
            if (pr.state !== undefined && pr.state !== PullRequestState.OPENED) continue;
            const updated = typeof pr.updated_at === 'string' && Number.isFinite(Date.parse(pr.updated_at)) ? new Date(pr.updated_at).toISOString() : undefined;
            out.push({ number, headSha: headSha.toLowerCase(), ...(typeof pr.isDraft === 'boolean' ? { draft: pr.isDraft } : {}), ...(updated ? { updatedAt: updated } : {}) });
        }
        return out;
    }

    async getDefaultBranchHead(input: OrgTeam & { repositoryId: string; repositoryName: string }): Promise<DefaultBranchHead> {
        const organizationAndTeamData = { organizationId: input.organizationId, teamId: input.teamId };
        const head = await this.codeManagement.getDefaultBranchHead({
            organizationAndTeamData,
            repository: { id: input.repositoryId, ...splitFullName(input.repositoryName) } as { id: string; name: string; owner?: string },
        });
        if (head === undefined) {
            // Only labels the unsupported answer: the status is already decided by the head read.
            const platform = await this.codeManagement.getTypeIntegration(organizationAndTeamData).catch(() => null);
            return { status: 'unsupported_platform', platform: platform ?? null };
        }
        if (!head || !/^[0-9a-f]{40}$/.test(head.sha)) return { status: 'not_found' };
        return { status: 'ok', branch: head.branch, sha: head.sha };
    }

    async readFileAtCommit(
        input: OrgTeam & { repositoryId: string; repositoryName: string; path: string; sha: string; maxBytes: number },
    ): Promise<string | null | 'unsupported_platform'> {
        const text = await this.codeManagement.getFileContentAtRef({
            organizationAndTeamData: { organizationId: input.organizationId, teamId: input.teamId },
            repository: { id: input.repositoryId, ...splitFullName(input.repositoryName) } as { id: string; name: string; owner?: string },
            path: input.path,
            ref: input.sha,
            maxBytes: input.maxBytes,
        });
        return text === undefined ? 'unsupported_platform' : text;
    }

    /**
     * The tree at the commit (the integration's recursive listing, `branch`
     * set to the SHA, every file): a failed listing throws instead of reading
     * as an empty repository.
     */
    async listFilesAtCommit(input: OrgTeam & { repositoryId: string; repositoryName: string; sha: string }): Promise<string[] | 'unsupported_platform'> {
        const files = await this.codeManagement.getRepositoryAllFiles({
            organizationAndTeamData: { organizationId: input.organizationId, teamId: input.teamId },
            repository: { id: input.repositoryId, name: splitFullName(input.repositoryName).name },
            filters: { branch: input.sha, maxFiles: 0 },
            throwOnError: true,
        });
        if (!Array.isArray(files)) return 'unsupported_platform';
        return files.map((f) => f?.path).filter((p): p is string => typeof p === 'string' && p.length > 0);
    }

    /** The provider's own read diagnosis of the repository (never throws); unknown when it cannot be asked. */
    async repositoryReadAccess(input: OrgTeam & { repositoryId: string; repositoryName: string }): Promise<'ok' | 'denied' | 'unknown'> {
        const { name } = splitFullName(input.repositoryName);
        const diagnosis = await this.codeManagement
            .diagnoseRepositoryAccess({
                organizationAndTeamData: { organizationId: input.organizationId, teamId: input.teamId },
                repository: { id: input.repositoryId, name, ...(input.repositoryName.includes('/') ? { fullName: input.repositoryName } : {}) },
            })
            .catch(() => null);
        return diagnosis?.read ?? 'unknown';
    }

    async userCanWrite(input: OrgTeam & { repositoryId: string; repositoryName: string; identity: GitIdentity }) {
        return this.codeManagement.userCanWrite({
            organizationAndTeamData: { organizationId: input.organizationId, teamId: input.teamId },
            repository: { id: input.repositoryId, ...splitFullName(input.repositoryName) },
            ...(input.identity.login ? { login: input.identity.login } : {}),
            ...(input.identity.id ? { userId: input.identity.id } : {}),
        });
    }
}

/** Repositories configured for a team, from the integration config. */
@Injectable()
export class IntegrationConfigTeamRepositories implements RuntimeTeamRepositories {
    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfig: IIntegrationConfigService,
    ) {}

    async listRepositoryIds(input: OrgTeam): Promise<string[]> {
        const repositories =
            (await this.integrationConfig.findIntegrationConfigFormatted<Repositories[]>(IntegrationConfigKey.REPOSITORIES, {
                organizationId: input.organizationId,
                teamId: input.teamId,
            })) ?? [];
        return repositories.map((r) => String(r.id));
    }
}

/** Repositories connected to the org: its team's integration config (one team per org today). */
@Injectable()
export class IntegrationConfigOrgRepositories implements RuntimeOrgRepositories {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teams: ITeamService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfig: IIntegrationConfigService,
    ) {}

    async list(organizationId: string) {
        const team = await this.teams.findOneByOrganizationId(organizationId);
        const teamId = team?.uuid;
        if (!teamId) return { teamId: '', repositories: [] };
        const repositories =
            (await this.integrationConfig.findIntegrationConfigFormatted<Repositories[]>(IntegrationConfigKey.REPOSITORIES, {
                organizationId,
                teamId,
            })) ?? [];
        return {
            teamId,
            repositories: repositories.map((r) => ({ repositoryId: String(r.id), repositoryName: String(r.full_name ?? r.name ?? r.id) })),
        };
    }
}
